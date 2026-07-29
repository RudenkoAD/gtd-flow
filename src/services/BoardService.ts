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
import type { MoveColumn, SetDate } from "../core/intents/Intent";
import { isDeferred } from "../core/model/gtdState";
import type { Task } from "../core/model/Task";
import type { IndexFeed } from "./types";
import type { IntentDispatcher, IntentResult } from "./WritebackService";

export interface BoardServiceDeps {
	feed: IndexFeed;
	readFrontmatter: (path: string) => Record<string, unknown> | null;
	patchFrontmatter: (path: string, fn: (fm: Record<string, unknown>) => void) => Promise<void>;
	dispatcher: IntentDispatcher;
	/** Создать пустой файл при отсутствии (для createBoard); совместим с VaultAdapter.ensureFile. */
	ensureFile: (path: string) => Promise<void>;
	/** ВСЕ пути файлов с флагом gtd-board — доска без единой задачи видна discovery
	 *  только через этот деп (индекс задач её не хранит). Метадата-порт зовёт его
	 *  лениво: строго из discovery, никогда синхронно в onload (см. main.ts). */
	containerPaths: () => string[];
	/** 🆔 с учётом памяти вписанных в окне дебаунса (WritebackService.knownTaskId). */
	knownTaskId?: (key: string) => string | null;
	/**
	 * Криптостойкий случайный суффикс для id новой доски. Основной runtime
	 * передаёт secureBoardIdSuffix (randomUUID либо getRandomValues); инъекция
	 * сохраняет сервис детерминируемым в тестах. Сервис сам добавляет читаемый
	 * slug имени перед этим суффиксом.
	 */
	genBoardIdSuffix?: () => string;
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

/** Результат операций над колонками (создание/переименование/удаление/перестановка). */
export interface ColumnOpResult {
	ok: boolean;
	colId?: string;
	reason?: string;
}

/** Результат создания доски: путь созданного/существующего файла либо причина отказа. */
export interface BoardCreateResult {
	ok: boolean;
	path?: string;
	reason?: string;
}

export interface BoardModel {
	path: string;
	def: BoardDef;
	columns: BoardColumnModel[];
}

/** UUID даёт 122 случайных бита; повтор — крайне маловероятен, но всё равно
 * проверяется перед записью и в transactional callback ниже. */
const MAX_BOARD_ID_ALLOCATION_ATTEMPTS = 32;
const BOARD_ID_SUFFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type CryptoRandomSource = {
	randomUUID?: () => string;
	getRandomValues?: (array: Uint8Array) => Uint8Array;
};

/**
 * Secure UUID-form suffix for ids of newly created boards. Older mobile WebViews
 * can expose Web Crypto's getRandomValues without randomUUID, so retain the same
 * 122-bit UUID-v4 form with that CSPRNG fallback. Never fall back to Math.random:
 * a collision would merge the two boards' #kanban memberships.
 */
export function secureBoardIdSuffix(
	cryptoSource: CryptoRandomSource | undefined = globalThis.crypto,
): string {
	if (typeof cryptoSource?.randomUUID === "function") return cryptoSource.randomUUID();
	if (typeof cryptoSource?.getRandomValues !== "function") {
		throw new Error("secure-board-id-generator-unavailable");
	}
	const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
	// UUID v4/version + RFC 4122 variant; other 122 bits came from the CSPRNG.
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class BoardService {
	/** Локальная критическая секция для createBoard. metadataCache обновляется
	 * асинхронно после processFrontMatter, поэтому одного scan-before-write
	 * недостаточно: два быстрых создания могли получить один #kanban/<id>. */
	private boardCreationTail: Promise<void> = Promise.resolve();
	private readonly reservedBoardIds = new Set<string>();
	/** Созданные в этой сессии доски дополняют metadata discovery до прихода
	 * metadataCache changed; запись удаляется, если путь больше не gtd-board. */
	private readonly locallyCreatedBoardIds = new Map<string, string>();
	private readonly genBoardIdSuffix: () => string;

	constructor(private readonly deps: BoardServiceDeps) {
		this.genBoardIdSuffix = deps.genBoardIdSuffix ?? secureBoardIdSuffix;
	}

	// --- discovery ---

	/** Discover every board in the vault; board identity is global. */
	discoverBoards(): BoardDiscovery {
		return this.enumerateBoards();
	}

	/**
	 * Enumerate every board in the vault (including empty container files).
	 */
	private enumerateBoards(): BoardDiscovery {
		const paths = new Set<string>();
		for (const t of this.deps.feed.getIndex().all()) {
			if (t.container === "board") paths.add(t.filePath);
		}
		// NUX: файл-доска с флагом, но без единой строки-задачи, в индексе задач
		// отсутствует — добавляем его по frontmatter-флагу (dedupe через Set).
		for (const p of this.deps.containerPaths()) paths.add(p);
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
		let rollbackMove: MoveColumn | null = null;
		if (fromColId !== toColId) {
			// Перенос = только теги (fromTag → toTag) + order; статус не трогается.
			const intent: MoveColumn = {
				type: "move-column",
				key: taskKey,
				fromTag: null,
				toTag: "#" + toSpec.tag,
			};
			const fromCol =
				fromColId !== null ? def.columns.find((c) => c.id === fromColId) : undefined;
			const fromSpec = fromCol !== undefined ? parseMatchSpec(fromCol.match) : null;
			if (fromSpec !== null) intent.fromTag = "#" + fromSpec.tag;
			intent.index = insertIndex;
			const res = await this.deps.dispatcher.dispatch(intent);
			if (!res.ok) return res; // фаза 1 не прошла — порядок не трогаем
			// Если запись order (фаза 2) не пройдёт, возвращаем теги ровно в
			// исходное состояние. Иначе карточка визуально и на диске расходятся:
			// строка уже в новой колонке, а ручной порядок не сохранён.
			rollbackMove = {
				type: "move-column",
				key: taskKey,
				fromTag: "#" + toSpec.tag,
				toTag: fromSpec === null ? null : "#" + fromSpec.tag,
			};
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
		try {
			await this.deps.patchFrontmatter(boardPath, (fm) => {
				fm["order"] = patchOrder(normalizeOrder(fm["order"]), toColId, orderedIds);
			});
		} catch (error) {
			if (rollbackMove !== null) {
				try {
					const rollback = await this.deps.dispatcher.dispatch(rollbackMove);
					if (!rollback.ok)
						return {
							ok: false,
							reason: `order-write-failed; column-rollback-failed:${rollback.reason ?? "unknown"}`,
						};
				} catch (rollbackError) {
					return {
						ok: false,
						reason: `order-write-failed; column-rollback-threw:${String(rollbackError)}`,
					};
				}
			}
			return { ok: false, reason: `order-write-failed:${String(error)}` };
		}
		return { ok: true };
	}

	/**
	 * One logical Tickler → Kanban operation. A deferred task must clear 🛫 to
	 * become visible on a board, but clearing it before moving used to leave the
	 * task in neither view when the second write failed. We record the exact
	 * start field, compensate the board move inside `moveCard`, then restore the
	 * start field when the move does not commit.
	 */
	async moveCardFromTickler(
		boardPath: string,
		def: BoardDef,
		taskKey: string,
		toColId: string,
		insertIndex: number,
	): Promise<IntentResult> {
		const task = this.deps.feed.getIndex().get(taskKey);
		if (task === undefined) return { ok: false, reason: "task-not-found" };
		if (task.start === null)
			return this.moveCard(boardPath, def, taskKey, toColId, insertIndex);

		const restoreStart: SetDate = {
			type: "set-date",
			key: taskKey,
			field: "start",
			date: task.start,
			time: task.startTime,
			timeEnd: task.startTimeEnd,
		};
		const clearStart: SetDate = { type: "set-date", key: taskKey, field: "start", date: null };
		let cleared = false;
		try {
			const clear = await this.deps.dispatcher.dispatch(clearStart);
			if (!clear.ok) return clear;
			cleared = true;
			const moved = await this.moveCard(boardPath, def, taskKey, toColId, insertIndex);
			if (moved.ok) return moved;
			const restored = await this.deps.dispatcher.dispatch(restoreStart);
			if (!restored.ok)
				return {
					ok: false,
					reason: `${moved.reason ?? "board-move-failed"}; start-rollback-failed:${restored.reason ?? "unknown"}`,
				};
			return moved;
		} catch (error) {
			if (!cleared) return { ok: false, reason: `tickler-move-failed:${String(error)}` };
			try {
				const restored = await this.deps.dispatcher.dispatch(restoreStart);
				if (!restored.ok)
					return {
						ok: false,
						reason: `tickler-move-threw:${String(error)}; start-rollback-failed:${restored.reason ?? "unknown"}`,
					};
				return { ok: false, reason: `tickler-move-threw:${String(error)}` };
			} catch (restoreError) {
				return {
					ok: false,
					reason: `tickler-move-threw:${String(error)}; start-rollback-threw:${String(restoreError)}`,
				};
			}
		}
	}

	/** Перестановка внутри колонки готовым списком 🆔 (ренормализация при каждом drag). */
	async reorderCard(
		boardPath: string,
		colId: string,
		orderedIds: readonly string[],
	): Promise<void> {
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

	/**
	 * Убрать колонку из доски: элемент из columns[] и ключ из order{}. Карточки
	 * с тегом колонки НЕ трогаем — осиротевший тег остаётся заботой пользователя
	 * (массовая правка строк была бы разрушительнее самой ошибки; UI предупредит).
	 */
	async deleteColumn(boardPath: string, colId: string): Promise<ColumnOpResult> {
		const fm = this.deps.readFrontmatter(boardPath);
		if (fm === null) return { ok: false, reason: "board-not-found" };
		const rawCols = fm["columns"];
		const exists =
			Array.isArray(rawCols) && rawCols.some((c) => isPlainRecord(c) && c["id"] === colId);
		if (!exists) return { ok: false, reason: "column-not-found" };

		await this.deps.patchFrontmatter(boardPath, (live) => {
			const cols = live["columns"];
			if (Array.isArray(cols)) {
				// точечно: чужие ключи колонок и их формы не трогаем
				live["columns"] = cols.filter((c) => !(isPlainRecord(c) && c["id"] === colId));
			}
			const order = live["order"];
			if (isPlainRecord(order)) delete order[colId];
		});
		return { ok: true, colId };
	}

	/**
	 * Переставить колонку в массиве columns на одну позицию (dir: -1 влево,
	 * +1 вправо). Кламп на краях: выход за границы — no-op {ok:true} без записи.
	 * Позиция ищется заново по живому frontmatter (устойчивость к гонке).
	 */
	async moveColumn(boardPath: string, colId: string, dir: -1 | 1): Promise<ColumnOpResult> {
		const fm = this.deps.readFrontmatter(boardPath);
		if (fm === null) return { ok: false, reason: "board-not-found" };
		const rawCols = fm["columns"];
		if (!Array.isArray(rawCols)) return { ok: false, reason: "column-not-found" };
		const idx = rawCols.findIndex((c) => isPlainRecord(c) && c["id"] === colId);
		if (idx === -1) return { ok: false, reason: "column-not-found" };
		// кламп: колонка уже с краю в сторону движения — переставлять нечего
		if (idx + dir < 0 || idx + dir >= rawCols.length) return { ok: true, colId };

		await this.deps.patchFrontmatter(boardPath, (live) => {
			const cols = live["columns"];
			if (!Array.isArray(cols)) return; // гонка: frontmatter переписан между чтением и patch
			const i = cols.findIndex((c) => isPlainRecord(c) && c["id"] === colId);
			if (i === -1) return;
			const j = i + dir;
			if (j < 0 || j >= cols.length) return;
			const [moved] = cols.splice(i, 1);
			cols.splice(j, 0, moved);
		});
		return { ok: true, colId };
	}

	// --- доска: создание и переименование ---

	/**
	 * Скаффолд новой доски (NUX): ensureFile + frontmatter gtd-board с тремя
	 * дефолтными тег-колонками. id — slug имени (fallback 'board' для эмодзи/CJK)
	 * + криптостойкий случайный UUID-суффикс. Членство карточек ключуется тегом
	 * #kanban/<id>/…; случайность защищает от двух независимых plugin-процессов,
	 * чьи metadata-кэши ещё не увидели доску друг друга.
	 *
	 * Идемпотентно: файл, УЖЕ помеченный gtd-board, не перезаписывается — иначе
	 * повторный вызов затёр бы пользовательские колонки/порядок. Возврат — путь.
	 */
	async createBoard(path: string, name: string): Promise<BoardCreateResult> {
		const trimmed = name.trim();
		if (trimmed === "") return { ok: false, reason: "empty-name" };
		const base = slugifyColumnName(trimmed) || "board";
		await this.deps.ensureFile(path);
		return this.serializeBoardCreation(async () => {
			// После каждого конфликта перечитываем global discovery прямо перед
			// commit. Лимит — аварийный предохранитель против постоянно меняющегося
			// внешним sync-клиентом frontmatter, а не штатный путь.
			for (let attempt = 0; attempt < MAX_BOARD_ID_ALLOCATION_ATTEMPTS; attempt++) {
				if (this.deps.readFrontmatter(path)?.["gtd-board"] === true)
					return { ok: true, path };
				const id = this.nextBoardId(base);
				if (id === null) return { ok: false, reason: "id-generation-failed" };
				// Обычно случайный UUID новый с первой попытки. Эта проверка сохраняет
				// корректность при тестовом/сломавшемся генераторе и при крайне редком
				// случайном совпадении, не делая лишнюю запись.
				if (this.occupiedBoardIds(path).has(id)) continue;
				this.reservedBoardIds.add(id);
				const outcome: { value: "created" | "existing" | "conflict" } = {
					value: "conflict",
				};
				try {
					await this.deps.patchFrontmatter(path, (fm) => {
						if (fm["gtd-board"] === true) {
							outcome.value = "existing"; // конкурент уже создал этот путь
							return;
						}
						// Последняя проверка непосредственно в transactional callback.
						// Исключаем только собственную reservation; все чужие — конфликт.
						if (this.occupiedBoardIds(path, id).has(id)) return;
						fm["gtd-board"] = true;
						fm["id"] = id;
						fm["name"] = trimmed;
						fm["columns"] = [
							{ id: "todo", name: "Очередь", match: `#kanban/${id}/todo` },
							{ id: "doing", name: "В работе", match: `#kanban/${id}/doing` },
							{ id: "done", name: "Готово", match: `#kanban/${id}/done` },
						];
						outcome.value = "created";
					});
				} finally {
					this.reservedBoardIds.delete(id);
				}
				if (outcome.value === "created") {
					this.locallyCreatedBoardIds.set(path, id);
					return { ok: true, path };
				}
				if (outcome.value === "existing") return { ok: true, path };
			}
			return { ok: false, reason: "id-allocation-conflict" };
		});
	}

	private async serializeBoardCreation<T>(operation: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const previous = this.boardCreationTail;
		this.boardCreationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	/** Compose a readable, tag-safe id. Invalid injected output fails closed rather
	 * than placing whitespace/punctuation into #kanban membership tags. */
	private nextBoardId(base: string): string | null {
		let suffix: string;
		try {
			suffix = this.genBoardIdSuffix();
		} catch {
			return null;
		}
		return BOARD_ID_SUFFIX_RE.test(suffix) ? `${base}-${suffix}` : null;
	}

	/** Current global ids plus reservations; an entry created locally remains
	 * visible even before metadataCache reports the new frontmatter. */
	private occupiedBoardIds(excludePath: string, excludeReservation?: string): Set<string> {
		const ids = new Set<string>();
		for (const board of this.enumerateBoards().boards) {
			if (board.path !== excludePath) ids.add(board.def.id);
		}
		for (const [path, id] of this.locallyCreatedBoardIds) {
			if (this.deps.readFrontmatter(path)?.["gtd-board"] !== true) {
				this.locallyCreatedBoardIds.delete(path);
				continue;
			}
			if (path !== excludePath) ids.add(id);
		}
		for (const id of this.reservedBoardIds) if (id !== excludeReservation) ids.add(id);
		return ids;
	}

	/** Переименование доски — только display-имя (frontmatter name); id и колонки не трогаем. */
	async renameBoard(path: string, name: string): Promise<{ ok: boolean; reason?: string }> {
		const trimmed = name.trim();
		if (trimmed === "") return { ok: false, reason: "empty-name" };
		if (this.deps.readFrontmatter(path) === null)
			return { ok: false, reason: "board-not-found" };
		await this.deps.patchFrontmatter(path, (live) => {
			live["name"] = trimmed;
		});
		return { ok: true };
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
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ё: "e",
	ж: "zh",
	з: "z",
	и: "i",
	й: "y",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ф: "f",
	х: "h",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "sch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
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
