/**
 * BoardService (ТЗ §3, §4): открытие kanban-досок поверх индекса.
 *
 * - discoverBoards: файлы-контейнеры 'board' из индекса → frontmatter →
 *   core parseBoardFrontmatter. Доска без единой строки задачи в самом файле
 *   индексом не видна (byFile хранит только задачи) — такая доска появится
 *   в списке после первой карточки в файле либо задаётся defaultBoardPath.
 * - boardModel: колонки → задачи через core membership/ordering.
 * - moveCard: двухфазная запись по ТЗ §3 — (1) intent по строке задачи,
 *   (2) ручной порядок во frontmatter доски. Строго в этом порядке.
 *
 * Ноль импортов obsidian: frontmatter приходит через инжектированные порты,
 * структурно совместимые с MetadataAdapter.frontmatter / VaultAdapter.processFrontmatter.
 */
import type { BoardDef } from "../core/board/boardFile";
import { isBoardError, parseBoardFrontmatter, parseMatchSpec } from "../core/board/boardFile";
import { belongsToBoard, resolveColumn } from "../core/board/membership";
import { applyOrder, patchOrder } from "../core/board/ordering";
import type { MoveColumn } from "../core/intents/Intent";
import { isDeferred } from "../core/model/gtdState";
import type { Task } from "../core/model/Task";
import type { IndexFeed } from "./types";
import type { IntentDispatcher, IntentResult } from "./WritebackService";

export interface BoardServiceDeps {
	feed: IndexFeed;
	readFrontmatter: (path: string) => Record<string, unknown> | null;
	patchFrontmatter: (path: string, fn: (fm: Record<string, unknown>) => void) => Promise<void>;
	dispatcher: IntentDispatcher;
	/** 🆔 с учётом памяти вписанных в окне дебаунса (WritebackService.knownTaskId). */
	knownTaskId?: (key: string) => string | null;
}

export interface DiscoveredBoard {
	path: string;
	def: BoardDef;
}

export interface BoardDiscoveryError {
	path: string;
	error: string;
}

export interface BoardDiscovery {
	boards: DiscoveredBoard[];
	errors: BoardDiscoveryError[];
}

export interface BoardColumnModel {
	id: string;
	name: string;
	match: string;
	tasks: Task[];
}

/** Результат операций над колонками (создание/переименование). */
export interface ColumnOpResult {
	ok: boolean;
	colId?: string;
	reason?: string;
}

export interface BoardModel {
	path: string;
	def: BoardDef;
	columns: BoardColumnModel[];
}

export class BoardService {
	constructor(private readonly deps: BoardServiceDeps) {}

	// --- discovery ---

	discoverBoards(): BoardDiscovery {
		const paths = new Set<string>();
		for (const t of this.deps.feed.getIndex().all()) {
			if (t.container === "board") paths.add(t.filePath);
		}
		const boards: DiscoveredBoard[] = [];
		const errors: BoardDiscoveryError[] = [];
		for (const path of [...paths].sort()) {
			const fm = this.deps.readFrontmatter(path);
			if (fm === null) {
				// гонка: файл только что удалён/переименован, а индекс ещё не догнал
				errors.push({ path, error: "frontmatter unavailable" });
				continue;
			}
			const parsed = parseBoardFrontmatter(fm);
			if (isBoardError(parsed)) {
				errors.push({ path, error: parsed.messages.join("; ") });
			} else {
				boards.push({ path, def: parsed });
				// упразднённые status-колонки не валят доску, но показываются
				// как предупреждения (тем же errors-механизмом, что и битый fm)
				for (const sc of parsed.skippedColumns) errors.push({ path, error: sc.reason });
			}
		}
		return { boards, errors };
	}

	// --- модель доски ---

	boardModel(path: string, def: BoardDef): BoardModel {
		const today = this.deps.feed.today();
		// Раунд 3: колонки развязаны со статусом — показываем задачи ЛЮБОГО статуса
		// своей доски в их тег-колонках (done/cancelled рендерятся зачёркнутыми —
		// это делает TaskCard). Скрыт только TICKLER (🛫 в будущем, §1).
		const byCol = new Map<string, Task[]>();
		for (const t of this.deps.feed.getIndex().all()) {
			// охват доски: только задачи ЭТОЙ доски (файл доски / тег колонки / scope),
			// иначе чужая задача из другого файла протекала бы на доску
			if (!belongsToBoard(t, path, def)) continue;
			if (isDeferred(t, today)) continue;
			const colId = resolveColumn(t, def);
			if (colId === null) continue;
			const bucket = byCol.get(colId);
			if (bucket) bucket.push(t);
			else byCol.set(colId, [t]);
		}
		const columns: BoardColumnModel[] = def.columns.map((c) => ({
			id: c.id,
			name: c.name,
			match: c.match,
			tasks: applyOrder(byCol.get(c.id) ?? [], def.order[c.id] ?? []),
		}));
		return { path, def, columns };
	}

	// --- drag: перенос карточки в колонку ---

	/**
	 * Двухфазная запись (ТЗ §3), строго (1)→(2):
	 * 1. intent по строке задачи: move-column меняет ТОЛЬКО теги колонок
	 *    (снять исходный → добавить целевой). Раунд 3: колонки развязаны со
	 *    статусом — карточку ЛЮБОГО статуса (в т.ч. done/cancelled) можно
	 *    перетащить в любую колонку; статус при этом не трогается никогда.
	 *    Внутриколоночный drop строку не трогает — сразу фаза 2.
	 * 2. frontmatter доски: вставка 🆔 в ручной порядок целевой колонки.
	 *    Если 🆔 у задачи не было, после (1) он появляется (ленивая вставка
	 *    WritebackService) — перечитываем задачу из feed. Реиндексация
	 *    дебаунсится, поэтому свежего 🆔 может ещё не быть: тогда порядок
	 *    не пишем — карточка ляжет в конец колонки (applyOrder), а порядок
	 *    зафиксируется следующим drag.
	 */
	async moveCard(
		boardPath: string,
		def: BoardDef,
		taskKey: string,
		toColId: string,
		insertIndex: number,
	): Promise<IntentResult> {
		const task = this.deps.feed.getIndex().get(taskKey);
		if (task === undefined) return { ok: false, reason: "task-not-found" };
		const toCol = def.columns.find((c) => c.id === toColId);
		const toSpec = toCol !== undefined ? parseMatchSpec(toCol.match) : null;
		if (toSpec === null) return { ok: false, reason: "column-not-found" };

		// Фаза 1 — строка задачи (пропускается для drop в ту же колонку).
		const fromColId = resolveColumn(task, def);
		if (fromColId !== toColId) {
			// Перенос = только теги (fromTag → toTag) + order; статус не трогается.
			const intent: MoveColumn = {
				type: "move-column",
				key: taskKey,
				fromTag: null,
				toTag: "#" + toSpec.tag,
			};
			const fromCol = fromColId !== null ? def.columns.find((c) => c.id === fromColId) : undefined;
			const fromSpec = fromCol !== undefined ? parseMatchSpec(fromCol.match) : null;
			if (fromSpec !== null) intent.fromTag = "#" + fromSpec.tag;
			intent.index = insertIndex;
			const res = await this.deps.dispatcher.dispatch(intent);
			if (!res.ok) return res; // фаза 1 не прошла — порядок не трогаем
		}

		// Фаза 2 — ручной порядок. 🆔: задача → свежий feed → память вписанных
		// (реиндекс дебаунсится, но WritebackService помнит id, который сам записал).
		const movedId =
			task.taskId ??
			this.deps.feed.getIndex().get(taskKey)?.taskId ??
			this.deps.knownTaskId?.(taskKey) ??
			null;
		if (movedId === null) return { ok: true }; // без 🆔 порядок не записать — задокументировано выше

		const orderedIds = insertIntoColumnOrder(
			this.boardModel(boardPath, def).columns.find((c) => c.id === toColId)?.tasks ?? [],
			movedId,
			insertIndex,
		);
		await this.deps.patchFrontmatter(boardPath, (fm) => {
			fm["order"] = patchOrder(normalizeOrder(fm["order"]), toColId, orderedIds);
		});
		return { ok: true };
	}

	/** Перестановка внутри колонки готовым списком 🆔 (ренормализация при каждом drag). */
	async reorderCard(boardPath: string, colId: string, orderedIds: readonly string[]): Promise<void> {
		await this.deps.patchFrontmatter(boardPath, (fm) => {
			fm["order"] = patchOrder(normalizeOrder(fm["order"]), colId, orderedIds);
		});
	}

	// --- колонки: создание и переименование ---

	/**
	 * Новая колонка в конце доски. colId — slug из имени (транслит кириллицы,
	 * ASCII [a-z0-9-], уникальность против существующих; пустой slug → colN).
	 *
	 * Match новой колонки ВСЕГДА тег '#kanban/<board.id>/<colId>' — иных типов
	 * match больше нет (раунд 3: колонки развязаны со статусом).
	 */
	async addColumn(boardPath: string, name: string): Promise<ColumnOpResult> {
		const trimmed = name.trim();
		if (trimmed === "") return { ok: false, reason: "empty-name" };
		const fm = this.deps.readFrontmatter(boardPath);
		if (fm === null) return { ok: false, reason: "board-not-found" };
		const parsed = parseBoardFrontmatter(fm);
		if (isBoardError(parsed)) return { ok: false, reason: parsed.messages.join("; ") };

		const colId = uniqueColId(trimmed, new Set(parsed.columns.map((c) => c.id)));
		const match = `#kanban/${parsed.id}/${colId}`;
		await this.deps.patchFrontmatter(boardPath, (live) => {
			// живой frontmatter мутируем точечно: чужие ключи и формы не трогаем
			const cols = Array.isArray(live["columns"]) ? (live["columns"] as unknown[]) : [];
			cols.push({ id: colId, name: trimmed, match });
			live["columns"] = cols;
			const order = live["order"];
			if (isPlainRecord(order)) order[colId] = [];
			else live["order"] = { [colId]: [] };
		});
		return { ok: true, colId };
	}

	/**
	 * Переименование меняет ТОЛЬКО display name колонки. Match (тег/статус)
	 * намеренно не трогаем: смена тега потребовала бы переписать строки всех
	 * задач колонки (массовая правка файлов) и «перекрасила» бы карточки —
	 * переименование обязано быть косметическим и безопасным.
	 */
	async renameColumn(boardPath: string, colId: string, name: string): Promise<ColumnOpResult> {
		const trimmed = name.trim();
		if (trimmed === "") return { ok: false, reason: "empty-name" };
		const fm = this.deps.readFrontmatter(boardPath);
		if (fm === null) return { ok: false, reason: "board-not-found" };
		const rawCols = fm["columns"];
		const exists =
			Array.isArray(rawCols) && rawCols.some((c) => isPlainRecord(c) && c["id"] === colId);
		if (!exists) return { ok: false, reason: "column-not-found" };

		await this.deps.patchFrontmatter(boardPath, (live) => {
			const cols = live["columns"];
			if (!Array.isArray(cols)) return; // гонка: frontmatter переписан между чтением и patch
			for (const c of cols) {
				if (isPlainRecord(c) && c["id"] === colId) c["name"] = trimmed;
			}
		});
		return { ok: true, colId };
	}
}

// ---------------------------------------------------------------------------
// Чистые помощники (экспортированы для тестов)
// ---------------------------------------------------------------------------

/**
 * Итоговый порядок 🆔 целевой колонки: видимый порядок задач → их 🆔
 * (задачи без 🆔 позицией не управляют), перемещаемая карточка вычищается
 * и вставляется на позицию insertIndex видимого списка. Если карточка уже
 * стояла в колонке ВЫШЕ точки вставки, индекс сдвигается на -1 (rect-математика
 * drop-а считала и её саму).
 */
export function insertIntoColumnOrder(
	visibleTasks: readonly Task[],
	movedId: string,
	insertIndex: number,
): string[] {
	const selfIdx = visibleTasks.findIndex((t) => t.taskId === movedId);
	let visIdx = Math.max(0, Math.min(insertIndex, visibleTasks.length));
	if (selfIdx !== -1 && selfIdx < visIdx) visIdx--;
	const rest = visibleTasks.filter((t) => t.taskId !== movedId);
	// позиция в списке 🆔 = число id-носителей до точки вставки в видимом списке
	let idPos = 0;
	for (let i = 0; i < visIdx && i < rest.length; i++) {
		if (rest[i]!.taskId !== null) idPos++;
	}
	const ids = rest.map((t) => t.taskId).filter((id): id is string => id !== null);
	ids.splice(idPos, 0, movedId);
	return ids;
}

/** Узкий guard «обычный объект-словарь» для живого frontmatter. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Простая таблица транслитерации кириллицы для slug-ов колонок. */
const CYRILLIC_TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
	з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
	п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
	ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Slug имени колонки: нижний регистр, кириллица → транслит, прочее → '-',
 * серии дефисов схлопываются, крайние обрезаются. Только ASCII [a-z0-9-].
 * Имя целиком из «прочего» (эмодзи, CJK) даёт пустую строку — caller
 * подставит fallback colN.
 */
export function slugifyColumnName(name: string): string {
	let out = "";
	for (const ch of name.toLowerCase()) {
		if (/^[a-z0-9]$/.test(ch)) {
			out += ch;
		} else {
			const tr = CYRILLIC_TRANSLIT[ch];
			out += tr !== undefined ? tr : "-";
		}
	}
	return out.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Уникальный colId: slug имени; занят → суффикс -2, -3…; пустой slug → col1, col2… */
export function uniqueColId(name: string, existing: ReadonlySet<string>): string {
	const base = slugifyColumnName(name);
	if (base === "") {
		for (let n = 1; ; n++) {
			const id = `col${n}`;
			if (!existing.has(id)) return id;
		}
	}
	if (!existing.has(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!existing.has(id)) return id;
	}
}

/** Ленивое чтение текущего order из живого frontmatter (форма не гарантирована). */
export function normalizeOrder(raw: unknown): Record<string, string[]> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const out: Record<string, string[]> = {};
	for (const [col, ids] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(ids)) continue;
		out[col] = ids.filter((v): v is string => typeof v === "string");
	}
	return out;
}
