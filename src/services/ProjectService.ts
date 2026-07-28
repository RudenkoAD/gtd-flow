/**
 * ProjectService (ТЗ §7): проекты-DAG поверх индекса — discovery, модель графа,
 * графовые правки (рёбра/узлы/layout) и статус проекта.
 *
 * ВАЖНО: графовые правки идут через СОБСТВЕННЫЕ транзакции сервиса
 * (WritePort.processFile + patchFrontmatter), а не через intents. Intents
 * add-node/connect-edge/disconnect-edge/delete-node/move-node/set-project-status
 * из core/intents/Intent.ts в WritebackService НАМЕРЕННО остаются
 * not-implemented-stage: графовой транзакции нужны данные, которых у одиночного
 * строчного intent нет (проверка циклов по индексу до записи, парная правка
 * «строки + frontmatter layout», вычистка id из всех ⛔ файла). dispatcher в deps
 * зарезервирован под обычные строчные intents с полотна графа (чек-офф узла
 * идёт штатным set-status) — графовые транзакции его сознательно обходят.
 *
 * Отступление от «одной транзакции» ТЗ §7 для AddNode: ТЗ предлагает «строка +
 * layout одной записью», но это требовало бы строкового редактирования YAML
 * frontmatter внутри processFile — хрупче, чем два атомарных вызова API
 * (processFile для строки, затем patchFrontmatter для позиции). Сбой между ними
 * оставляет узел без позиции — авто-layout в слое видов его починит.
 *
 * Ноль импортов obsidian: запись через структурные порты, как у BoardService.
 */
import { isCancelled, isDone } from "../core/model/gtdState";
import type { IsoDate, ProjectStatus, Task } from "../core/model/Task";
import { inNamespace, type NamespaceFilter } from "../core/namespace/namespace";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { setDependsOn } from "../core/parser/serializeTaskLine";
import type { GraphIssue, NodeInfo, ResolveDep } from "../core/projects/graphEngine";
import { buildGraph, wouldCreateCycle as edgeWouldCreateCycle } from "../core/projects/graphEngine";
import type { LayoutMap, NodePosition } from "../core/projects/layout";
import { normalizeLayout } from "../core/projects/layout";
import { frontmatterNamespace } from "./snapshotHelpers";
import type { IndexFeed } from "./types";
import type { IntentDispatcher, WritePort } from "./WritebackService";
import { locateTaskLine } from "./WritebackService";

// ---------------------------------------------------------------------------
// Общий контракт (agent A владеет декларацией; вид кодируется против неё)
// ---------------------------------------------------------------------------

export interface ProjectSummary {
	path: string;
	name: string;
	status: ProjectStatus;
	complete: boolean;
	stalled: boolean;
}
export interface ProjectModel {
	nodes: NodeInfo[];
	edges: { from: string; to: string }[];
	issues: GraphIssue[];
	layout: LayoutMap;
}
export interface ProjectPort {
	discoverProjects(filter?: NamespaceFilter): ProjectSummary[];
	createProject(
		path: string,
		name: string,
	): Promise<{ ok: boolean; path?: string; reason?: string }>;
	model(path: string): ProjectModel | null;
	connect(
		path: string,
		fromId: string,
		toId: string,
	): Promise<{ ok: boolean; reason?: string; cyclePath?: string[] }>;
	disconnect(
		path: string,
		fromId: string,
		toId: string,
	): Promise<{ ok: boolean; reason?: string }>;
	addNode(
		path: string,
		text: string,
		x: number,
		y: number,
	): Promise<{ ok: boolean; reason?: string }>;
	deleteNode(
		path: string,
		id: string,
	): Promise<{ ok: boolean; reason?: string; unblocked?: number }>;
	moveNodes(path: string, moves: { id: string; x: number; y: number }[]): Promise<void>;
	setProjectStatus(path: string, status: ProjectStatus): Promise<void>;
	wouldCreateCycle(path: string, fromId: string, toId: string): string[] | null;
}

export interface ProjectServiceDeps {
	feed: IndexFeed;
	write: WritePort;
	readFrontmatter: (path: string) => Record<string, unknown> | null;
	patchFrontmatter: (path: string, fn: (fm: Record<string, unknown>) => void) => Promise<void>;
	/** Создать пустой файл при отсутствии (для createProject); совместим с VaultAdapter.ensureFile. */
	ensureFile: (path: string) => Promise<void>;
	/** ВСЕ пути файлов с флагом gtd-project — проект без единой задачи виден discovery
	 *  только через этот деп (индекс задач его не хранит). Зовётся лениво из discovery. */
	containerPaths: () => string[];
	/** Активное пространство + defs для фильтрации discoverProjects (пикеры/овервью
	 *  показывают только активное пространство, дизайн). Прозрачен (defs пуст) ⇒
	 *  фильтра нет. Опционален: без него discovery глобальна (обратная совместимость). */
	namespaceFilter?: () => NamespaceFilter;
	/** Не используется графовыми транзакциями (см. шапку) — маршрут строчных intents с полотна. */
	dispatcher: IntentDispatcher;
	/** Сегодняшняя дата для buildGraph (deferred/ready зависят от today). */
	todayIso: () => IsoDate;
	/** Генератор 🆔; по умолчанию 6 символов base36 (как в WritebackService). */
	genId?: () => string;
}

/** Дебаунс коалесценции moveNodes (ТЗ §7: «дебаунс ~300мс, батч за жест»). */
export const MOVE_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Локальные помощники
// ---------------------------------------------------------------------------

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function defaultGenId(): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += BASE36.charAt(Math.floor(Math.random() * BASE36.length));
	return s;
}

/** Парс строки вне индексатора: контекст не важен — нужны только dependsOn/taskId. */
function parseAt(lines: readonly string[], i: number, filePath: string): Task | null {
	const raw = lines[i];
	if (raw === undefined) return null;
	return parseTaskLine(raw, {
		filePath,
		lineStart: i,
		parentLine: null,
		heading: null,
		container: "project",
		projectActive: true,
	});
}

function baseName(path: string): string {
	const slash = path.lastIndexOf("/");
	const file = slash === -1 ? path : path.slice(slash + 1);
	return file.toLowerCase().endsWith(".md") ? file.slice(0, -3) : file;
}

const PROJECT_STATUSES: ReadonlySet<string> = new Set(["active", "on-hold", "done", "archived"]);

/** Зеркалит normalizeProjectStatus из snapshotHelpers: отсутствие/пусто ⇒ active,
 *  неизвестное значение — fail-closed «не активен» ⇒ on-hold. */
function normalizeStatus(raw: unknown): ProjectStatus {
	if (raw === null || raw === undefined) return "active";
	const s = String(raw).trim();
	if (s === "") return "active";
	return PROJECT_STATUSES.has(s) ? (s as ProjectStatus) : "on-hold";
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Живой layout-объект внутри frontmatter (создаётся при отсутствии/мусоре). */
function layoutRecordOf(fm: Record<string, unknown>): Record<string, unknown> {
	const raw = fm["layout"];
	if (isRecord(raw)) return raw;
	const fresh: Record<string, unknown> = {};
	fm["layout"] = fresh;
	return fresh;
}

interface PendingMoves {
	positions: Map<string, NodePosition>;
	timer: ReturnType<typeof setTimeout>;
	promise: Promise<void>;
	resolve: () => void;
	reject: (e: unknown) => void;
}

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

export class ProjectService implements ProjectPort {
	private readonly genId: () => string;
	/** Коалесценция moveNodes по path: одна patchFrontmatter на вспышку жеста. */
	private readonly pendingMoves = new Map<string, PendingMoves>();
	/** Неуспевшие батчи не выбрасываем: следующее перемещение того же проекта
	 * повторит и их вместе с новой позицией. UI получает rejected Promise и может
	 * откатить оптимистичный canvas, но координаты не теряются из памяти сервиса. */
	private readonly failedMoves = new Map<string, Map<string, NodePosition>>();

	constructor(private readonly deps: ProjectServiceDeps) {
		this.genId = deps.genId ?? defaultGenId;
	}

	// --- discovery ---

	/**
	 * discovery проектов пространства. `filter` — явное пространство вызывателя
	 * (пофайловые виды Projects/Project передают своё ЛОКАЛЬНОЕ; меню-пикер — пространство
	 * ЗАДАЧИ). Без него — фолбэк на инжектированный namespaceFilter() (обратная
	 * совместимость). Прозрачен при пустом defs / ALL_NS.
	 */
	discoverProjects(filter?: NamespaceFilter): ProjectSummary[] {
		// Файл-проект без единой задачи индексом задач не виден (byFile хранит
		// только задачи) — добавляем его по frontmatter-флагу (NUX, dedupe через Set).
		const paths = new Set<string>();
		for (const t of this.deps.feed.getIndex().all()) {
			if (t.container === "project") paths.add(t.filePath);
		}
		for (const p of this.deps.containerPaths()) paths.add(p);
		// фильтр по пространству (пикеры/овервью); прозрачен при пустом defs / ALL_NS
		const nsFilter = filter ?? this.deps.namespaceFilter?.();
		const filtering = nsFilter !== undefined && nsFilter.defs.length > 0;
		return [...paths]
			.sort()
			.filter(
				(path) =>
					!filtering ||
					inNamespace(
						path,
						frontmatterNamespace(this.deps.readFrontmatter(path)),
						nsFilter,
					),
			)
			.map((path) => this.summarize(path));
	}

	/**
	 * Скаффолд нового проекта (NUX): ensureFile + frontmatter gtd-project + name.
	 * Идемпотентно: уже помеченный gtd-project файл не перезаписывается. Узлы
	 * добавит addNode в уже существующий файл. Возврат — путь созданного файла.
	 */
	async createProject(
		path: string,
		name: string,
	): Promise<{ ok: boolean; path?: string; reason?: string }> {
		const trimmed = name.trim();
		if (trimmed === "") return { ok: false, reason: "empty-name" };
		await this.deps.ensureFile(path);
		await this.deps.patchFrontmatter(path, (fm) => {
			if (fm["gtd-project"] === true) return; // уже проект — не портим существующий
			fm["gtd-project"] = true;
			fm["name"] = trimmed;
		});
		return { ok: true, path };
	}

	private summarize(path: string): ProjectSummary {
		const fm = this.deps.readFrontmatter(path);
		const rawName = fm?.["name"];
		const name =
			typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : baseName(path);
		const status = normalizeStatus(fm?.["status"]);
		const members = this.members(path);
		// Завершение детектируется, но статус пишется только явным действием (ТЗ §7)
		const complete = members.length > 0 && members.every((t) => isDone(t) || isCancelled(t));
		const g = buildGraph(members, this.resolveDep(), this.deps.todayIso());
		const own = g.nodes.filter((n) => !n.ghost);
		// Стагнация: есть eligible (blocked/doing/ready), но ни одного ready/DOING —
		// т.е. существует blocked и никто не движется (бейдж для ревью)
		const moving = own.some((n) => n.state === "ready" || n.state === "doing");
		const stalled = !moving && own.some((n) => n.state === "blocked");
		return { path, name, status, complete, stalled };
	}

	// --- модель графа ---

	model(path: string): ProjectModel | null {
		const members = this.members(path);
		const isProject =
			members.some((t) => t.container === "project") ||
			this.deps.readFrontmatter(path)?.["gtd-project"] === true;
		if (!isProject) return null;
		const g = buildGraph(members, this.resolveDep(), this.deps.todayIso());
		// layout адресует только членов (призраки — не наши узлы, их кладёт авто-layout)
		const memberIds = g.nodes.filter((n) => !n.ghost).map((n) => n.id);
		const fm = this.deps.readFrontmatter(path);
		const { layout } = normalizeLayout(fm === null ? undefined : fm["layout"], memberIds);
		return { nodes: g.nodes, edges: g.edges, issues: g.issues, layout };
	}

	wouldCreateCycle(path: string, fromId: string, toId: string): string[] | null {
		const g = buildGraph(this.members(path), this.resolveDep(), this.deps.todayIso());
		return edgeWouldCreateCycle(g.edges, fromId, toId).cycle;
	}

	// --- рёбра ---

	/**
	 * Ребро from → to ⇒ ⛔-список цели += fromId. Проверка циклов — ДО записи,
	 * по текущему индексу (ТЗ §7); дубль по актуальному содержимому файла — no-op.
	 * Авторинг только внутри проекта: оба конца обязаны быть членами с 🆔.
	 */
	async connect(
		path: string,
		fromId: string,
		toId: string,
	): Promise<{ ok: boolean; reason?: string; cyclePath?: string[] }> {
		if (fromId === toId) return { ok: false, reason: "self" };
		const members = this.members(path);
		const sources = members.filter((m) => m.taskId === fromId);
		if (sources.length === 0) return { ok: false, reason: "source-not-found" };
		const targets = members.filter((m) => m.taskId === toId);
		if (targets.length === 0) return { ok: false, reason: "target-not-found" };
		// fail-closed при дублях 🆔ников внутри проекта: непонятно, чью строку править
		if (sources.length > 1 || targets.length > 1) return { ok: false, reason: "duplicate-id" };
		const target = targets[0]!;
		if (target.dependsOn.includes(fromId)) return { ok: true }; // дубль по индексу — no-op

		const cycle = this.wouldCreateCycle(path, fromId, toId);
		if (cycle !== null) return { ok: false, reason: "cycle", cyclePath: cycle };

		let failure: string | null = "file-not-found";
		let lateCycle: string[] | null = null;
		try {
			await this.deps.write.processFile(path, (content) => {
				failure = null;
				const lines = content.split("\n");
				const idx = locateTaskLine(lines, path, target);
				if (idx === -1) {
					failure = "line-not-found";
					return null;
				}
				const line = lines[idx]!;
				// файл свежее индекса: дубль по фактическому содержимому — тоже no-op
				const cur = parseAt(lines, idx, path);
				if (cur === null) {
					failure = "line-not-found";
					return null;
				}
				if (cur.dependsOn.includes(fromId)) return null;
				// индекс может отставать от собственных записей (дебаунс реиндексации):
				// два быстрых connect подряд иначе замкнули бы цикл — проверяем ещё раз
				// по фактическому содержимому файла (processFile сериализует записи,
				// поэтому предыдущее ребро здесь уже видно)
				const fresh: Task[] = [];
				for (let i = 0; i < lines.length; i++) {
					const t = parseAt(lines, i, path);
					if (t !== null) fresh.push(t);
				}
				const freshCycle = edgeWouldCreateCycle(
					buildGraph(fresh, this.resolveDep(), this.deps.todayIso()).edges,
					fromId,
					toId,
				).cycle;
				if (freshCycle !== null) {
					failure = "cycle";
					lateCycle = freshCycle;
					return null;
				}
				try {
					lines[idx] = setDependsOn(line, [...cur.dependsOn, fromId]);
				} catch {
					failure = "transform-failed";
					return null;
				}
				return lines.join("\n");
			});
		} catch {
			return { ok: false, reason: "write-failed" };
		}
		if (failure === null) return { ok: true };
		if (failure === "cycle" && lateCycle !== null)
			return { ok: false, reason: "cycle", cyclePath: lateCycle };
		return { ok: false, reason: failure };
	}

	/** Убрать fromId из ⛔ цели; пустой список ⇒ setDependsOn([]) удаляет поле. */
	async disconnect(
		path: string,
		fromId: string,
		toId: string,
	): Promise<{ ok: boolean; reason?: string }> {
		const target = this.members(path).find((m) => m.taskId === toId);
		if (target === undefined) return { ok: false, reason: "target-not-found" };

		let failure: string | null = "file-not-found";
		try {
			await this.deps.write.processFile(path, (content) => {
				failure = null;
				const lines = content.split("\n");
				const idx = locateTaskLine(lines, path, target);
				if (idx === -1) {
					failure = "line-not-found";
					return null;
				}
				const cur = parseAt(lines, idx, path);
				if (cur === null) {
					failure = "line-not-found";
					return null;
				}
				if (!cur.dependsOn.includes(fromId)) return null; // ребра уже нет — no-op
				try {
					lines[idx] = setDependsOn(
						lines[idx]!,
						cur.dependsOn.filter((d) => d !== fromId),
					);
				} catch {
					failure = "transform-failed";
					return null;
				}
				return lines.join("\n");
			});
		} catch {
			return { ok: false, reason: "write-failed" };
		}
		return failure === null ? { ok: true } : { ok: false, reason: failure };
	}

	// --- узлы ---

	/**
	 * Новая задача проекта: 🆔 сразу (eager, ТЗ §7 — узел графа обязан быть
	 * адресуемым с рождения), строка аппендится после последней задачи файла
	 * (или в конец), затем позиция — в frontmatter layout. Две атомарные записи
	 * в один файл; сбой между ними оставляет узел без позиции (см. шапку файла).
	 */
	async addNode(
		path: string,
		text: string,
		x: number,
		y: number,
	): Promise<{ ok: boolean; reason?: string }> {
		const trimmed = text.trim();
		if (trimmed === "" || trimmed.includes("\n") || trimmed.includes("\r"))
			return { ok: false, reason: "invalid-text" };
		const id = this.freshId();
		if (id === null) return { ok: false, reason: "id-collision" };
		const newLine = `- [ ] ${trimmed} 🆔 ${id} ➕ ${this.deps.todayIso()}`;

		let seen = false;
		try {
			await this.deps.write.processFile(path, (content) => {
				seen = true;
				const lines = content.split("\n");
				let lastTask = -1;
				for (let i = 0; i < lines.length; i++) {
					if (parseAt(lines, i, path) !== null) lastTask = i;
				}
				if (lastTask === -1) {
					// задач нет — в конец файла (как append в WritebackService.moveLine)
					return content.trimEnd() !== ""
						? content + (content.endsWith("\n") ? "" : "\n") + newLine + "\n"
						: newLine + "\n";
				}
				// CRLF: строки после split('\n') хранят '\r' — зеркалим у соседа
				const eol = lines[lastTask]!.endsWith("\r") ? "\r" : "";
				lines.splice(lastTask + 1, 0, newLine + eol);
				return lines.join("\n");
			});
		} catch {
			return { ok: false, reason: "write-failed" };
		}
		if (!seen) return { ok: false, reason: "file-not-found" };

		try {
			await this.deps.patchFrontmatter(path, (fm) => {
				layoutRecordOf(fm)[id] = { x, y };
			});
		} catch {
			// строка уже записана: узел существует, позицию дорисует авто-layout
			return { ok: false, reason: "layout-write-failed" };
		}
		return { ok: true };
	}

	/**
	 * Удаление узла — один processFile: строка узла + вычистка его 🆔 из всех ⛔
	 * прочих строк файла; затем layout[id] из frontmatter. unblocked — сколько
	 * членов станет ready (graphEngine до/после на копии членов, до записи).
	 */
	async deleteNode(
		path: string,
		id: string,
	): Promise<{ ok: boolean; reason?: string; unblocked?: number }> {
		const members = this.members(path);
		const victim = members.find((m) => (m.taskId ?? m.key) === id);
		if (victim === undefined) return { ok: false, reason: "node-not-found" };

		const unblocked = this.countUnblocked(members, victim);

		let failure: string | null = "file-not-found";
		// Дубли 🆔 (легальный след sync-схождения, ТЗ: «не удалять работу
		// пользователя»): если после удаления строки в файле остаётся другой
		// носитель того же 🆔, все ⛔-ссылки на него по-прежнему валидны —
		// чистить их (и layout выжившего) нельзя, иначе рёбра теряются навсегда.
		let survivorCarries = false;
		try {
			await this.deps.write.processFile(path, (content) => {
				failure = null;
				const lines = content.split("\n");
				const idx = locateTaskLine(lines, path, victim);
				if (idx === -1) {
					failure = "line-not-found";
					return null;
				}
				lines.splice(idx, 1);
				if (victim.taskId !== null) {
					for (let i = 0; i < lines.length; i++) {
						if (parseAt(lines, i, path)?.taskId === victim.taskId) {
							survivorCarries = true;
							break;
						}
					}
					if (!survivorCarries) {
						for (let i = 0; i < lines.length; i++) {
							const t = parseAt(lines, i, path);
							if (t === null || !t.dependsOn.includes(victim.taskId)) continue;
							try {
								lines[i] = setDependsOn(
									lines[i]!,
									t.dependsOn.filter((d) => d !== victim.taskId),
								);
							} catch {
								// кривой ⛔-список: строку не трогаем — останется broken-dep бейдж
							}
						}
					}
				}
				return lines.join("\n");
			});
		} catch {
			return { ok: false, reason: "write-failed" };
		}
		if (failure !== null) return { ok: false, reason: failure };

		if (!survivorCarries) {
			try {
				await this.deps.patchFrontmatter(path, (fm) => {
					const raw = fm["layout"];
					if (isRecord(raw)) delete raw[id];
				});
			} catch {
				// строки уже переписаны — мусорный layout[id] вычистит normalizeLayout
				return { ok: false, reason: "layout-write-failed" };
			}
		}
		return { ok: true, unblocked };
	}

	/** graphEngine до/после на копии: сколько членов сменит состояние на ready. */
	private countUnblocked(members: readonly Task[], victim: Task): number {
		const today = this.deps.todayIso();
		const victimId = victim.taskId ?? victim.key;
		// Дубль-носитель 🆔 переживает удаление строки — рёбра ⛔ остаются в силе,
		// зависимости из копий не вычищаем (зеркалит guard в deleteNode)
		const survivorCarries =
			victim.taskId !== null &&
			this.deps.feed
				.getIndex()
				.resolveDep(victim.taskId)
				.some((t) => t.key !== victim.key);
		const before = buildGraph(members, this.resolveDep(), today);
		const readyBefore = new Set(
			before.nodes.filter((n) => !n.ghost && n.state === "ready").map((n) => n.id),
		);
		const rest = members
			.filter((m) => m.key !== victim.key)
			.map((m) =>
				survivorCarries
					? m
					: { ...m, dependsOn: m.dependsOn.filter((d) => d !== victimId) },
			);
		// резолвер без жертвы: её носительство 🆔 исчезает вместе со строкой
		const rd: ResolveDep = (depId) =>
			this.deps.feed
				.getIndex()
				.resolveDep(depId)
				.filter((t) => t.key !== victim.key);
		const after = buildGraph(rest, rd, today);
		let count = 0;
		for (const n of after.nodes) {
			if (!n.ghost && n.state === "ready" && !readyBefore.has(n.id)) count++;
		}
		return count;
	}

	// --- позиции ---

	/**
	 * Батч позиций за жест: вызовы коалесцируются по path, дебаунс ~300мс,
	 * одна patchFrontmatter на вспышку. Все вызовы вспышки делят один Promise —
	 * он резолвится после фактической записи.
	 */
	moveNodes(path: string, moves: { id: string; x: number; y: number }[]): Promise<void> {
		if (moves.length === 0) return this.pendingMoves.get(path)?.promise ?? Promise.resolve();
		const existing = this.pendingMoves.get(path);
		if (existing !== undefined) {
			clearTimeout(existing.timer);
			for (const m of moves) existing.positions.set(m.id, { x: m.x, y: m.y });
			existing.timer = setTimeout(() => void this.flushMoves(path), MOVE_DEBOUNCE_MS);
			return existing.promise;
		}
		const positions = new Map<string, NodePosition>(this.failedMoves.get(path));
		this.failedMoves.delete(path);
		for (const m of moves) positions.set(m.id, { x: m.x, y: m.y });
		let resolve!: () => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.pendingMoves.set(path, {
			positions,
			timer: setTimeout(() => void this.flushMoves(path), MOVE_DEBOUNCE_MS),
			promise,
			resolve,
			reject,
		});
		return promise;
	}

	/** Досрочный сброс всех отложенных позиций (для onunload плагина). */
	async flushPending(): Promise<void> {
		const paths = [...this.pendingMoves.keys()];
		for (const path of paths) await this.flushMoves(path);
	}

	private async flushMoves(path: string): Promise<void> {
		const pending = this.pendingMoves.get(path);
		if (pending === undefined) return;
		this.pendingMoves.delete(path);
		clearTimeout(pending.timer);
		try {
			await this.deps.patchFrontmatter(path, (fm) => {
				const layout = layoutRecordOf(fm);
				for (const [id, pos] of pending.positions) layout[id] = { x: pos.x, y: pos.y };
			});
			pending.resolve();
		} catch (e) {
			const retained = this.failedMoves.get(path) ?? new Map<string, NodePosition>();
			for (const [id, pos] of pending.positions) retained.set(id, pos);
			this.failedMoves.set(path, retained);
			pending.reject(e);
		}
	}

	// --- статус проекта ---

	async setProjectStatus(path: string, status: ProjectStatus): Promise<void> {
		await this.deps.patchFrontmatter(path, (fm) => {
			fm["status"] = status;
		});
	}

	// --- внутренности ---

	/** Члены проекта = задачи файла (membership из byFile, ноль нового синтаксиса). */
	private members(path: string): Task[] {
		return this.deps.feed.getIndex().fileTasks(path);
	}

	private resolveDep(): ResolveDep {
		const index = this.deps.feed.getIndex();
		return (depId) => index.resolveDep(depId);
	}

	/** Свежий 🆔: коллизии проверяем по индексу (как в WritebackService). */
	private freshId(): string | null {
		for (let attempt = 0; attempt < 32; attempt++) {
			const id = this.genId();
			if (this.deps.feed.getIndex().resolveDep(id).length === 0) return id;
		}
		return null; // генератор зациклился на занятых id — не пишем
	}
}
