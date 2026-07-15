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
import type { BoardDef, StatusBucket } from "../core/board/boardFile";
import { isBoardError, parseBoardFrontmatter, parseMatchSpec } from "../core/board/boardFile";
import { resolveColumn } from "../core/board/membership";
import { applyOrder, patchOrder } from "../core/board/ordering";
import type { MoveColumn } from "../core/intents/Intent";
import { isActive, isDone } from "../core/model/gtdState";
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

export interface BoardModel {
	path: string;
	def: BoardDef;
	columns: BoardColumnModel[];
}

/** Соответствие статус-бакета символу статуса для move-column (group-by: status). */
const STATUS_CHAR: Record<StatusBucket, string> = { todo: " ", doing: "/", done: "x" };

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
			if (isBoardError(parsed)) errors.push({ path, error: parsed.messages.join("; ") });
			else boards.push({ path, def: parsed });
		}
		return { boards, errors };
	}

	// --- модель доски ---

	boardModel(path: string, def: BoardDef): BoardModel {
		const today = this.deps.feed.today();
		// DONE-задачи видимы только когда доске есть куда их класть (status:done);
		// на тег-досках выполненная карточка уходит с доски (классика kanban-GTD)
		const hasDoneColumn = def.columns.some((c) => {
			const spec = parseMatchSpec(c.match);
			return spec !== null && spec.kind === "status" && spec.status === "done";
		});
		const byCol = new Map<string, Task[]>();
		for (const t of this.deps.feed.getIndex().all()) {
			if (!inScope(t, def.scope)) continue;
			if (!isActive(t, today) && !(hasDoneColumn && isDone(t) && isBoardEligible(t))) continue;
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
	 * 1. intent по строке задачи: move-column (снять/добавить тег колонки)
	 *    либо смена статуса при group-by: status. Внутриколоночный drop
	 *    строку не трогает — сразу фаза 2.
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
			const intent: MoveColumn = { type: "move-column", key: taskKey, fromTag: null, toTag: null };
			if (toSpec.kind === "tag") intent.toTag = "#" + toSpec.tag;
			else {
				intent.toStatusChar = STATUS_CHAR[toSpec.status];
				// drag в статус-колонку = смена статуса: сопутствующие даты ✅/❌
				// обязаны вести себя как у set-status (штамп при done, снятие при reopen)
				intent.date = this.deps.feed.today();
			}
			const fromCol = fromColId !== null ? def.columns.find((c) => c.id === fromColId) : undefined;
			const fromSpec = fromCol !== undefined ? parseMatchSpec(fromCol.match) : null;
			if (fromSpec !== null && fromSpec.kind === "tag") intent.fromTag = "#" + fromSpec.tag;
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
}

// ---------------------------------------------------------------------------
// Чистые помощники (экспортированы для тестов)
// ---------------------------------------------------------------------------

/** Охват доски: понимаем только префикс 'path:...'; прочие формы scope
 *  (теги и т.п.) — задел на будущее, сейчас не сужают охват. */
export function inScope(t: Task, scope: string | undefined): boolean {
	if (scope === undefined || !scope.startsWith("path:")) return true;
	return t.filePath.startsWith(scope.slice("path:".length));
}

/** На статус-доску DONE-задачи допускаются той же цепочкой исключений §1,
 *  что и active: шаблоны/чеклисты карточек на доску не протекают. */
function isBoardEligible(t: Task): boolean {
	return t.container !== "recurring" && t.container !== "card";
}

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
