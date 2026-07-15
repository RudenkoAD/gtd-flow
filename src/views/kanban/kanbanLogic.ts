/**
 * Чистая логика вида Kanban (без DOM и obsidian): выбор доски и вью-модель
 * колонок. Всё, что можно проверить в node, — здесь; Kanban.svelte остаётся
 * тонкой обвязкой.
 */
import type { BoardColumnModel, DiscoveredBoard } from "../../services/BoardService";
import type { Task } from "../../core/model/Task";

/**
 * Какую доску показывать:
 * 1) текущая, если она ещё существует (смена выбора не сбрасывается индексом);
 * 2) предпочтение (settings.defaultBoardPath / сохранённое viewState);
 * 3) первая из обнаруженных; 4) досок нет — null.
 */
export function pickBoardPath(
	boards: readonly DiscoveredBoard[],
	preferred: string | null | undefined,
	current: string | null,
): string | null {
	const has = (p: string | null | undefined): p is string =>
		p !== null && p !== undefined && boards.some((b) => b.path === p);
	if (has(current)) return current;
	if (has(preferred)) return preferred;
	return boards.length > 0 ? boards[0]!.path : null;
}

/** Вью-модель колонки: счётчик и свёрнутость поверх модели BoardService. */
export interface ColumnVM {
	id: string;
	name: string;
	count: number;
	collapsed: boolean;
	tasks: Task[];
}

export function buildColumnVMs(
	columns: readonly BoardColumnModel[],
	collapsed: Readonly<Record<string, boolean>>,
): ColumnVM[] {
	return columns.map((c) => ({
		id: c.id,
		name: c.name,
		count: c.tasks.length,
		collapsed: collapsed[c.id] === true,
		tasks: c.tasks,
	}));
}

/** JSON-сериализуемое состояние вида для workspace-раскладки (ТЗ §4). */
export interface KanbanPersistedState {
	boardPath?: string;
	collapsed?: Record<string, boolean>;
}

/**
 * Человекочитаемое уведомление при отказе moveCard. Раунд 3: перенос
 * развязан со статусом — карточка любого статуса едет в любую колонку,
 * поэтому специальных отказов больше нет, причина показывается как есть.
 */
export function moveRefusalNotice(reason: string | undefined): string {
	return `GTD Flow: ${reason ?? "не удалось перенести карточку"}`;
}

/** Новое состояние свёрнутости после клика по шапке колонки (вход не мутируется). */
export function toggleCollapsed(
	collapsed: Readonly<Record<string, boolean>>,
	colId: string,
): Record<string, boolean> {
	return { ...collapsed, [colId]: collapsed[colId] !== true };
}
