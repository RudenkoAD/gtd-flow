/**
 * Чистые помощники построения FileSnapshot. Принимают плоские данные,
 * структурно совместимые с кэшами Obsidian (ListItemCache/HeadingCache/
 * frontmatter), но не импортируют 'obsidian' — тестируются в голом node.
 * Единственный потребитель — MetadataAdapter, который остаётся тонким.
 */
import type { FileContext, IsoDate, ProjectStatus } from "../core/model/Task";
import type { SnapshotListItem } from "./types";

/** Минимальный структурный срез obsidian Pos (col/offset не нужны). */
export interface PosLike {
	start: { line: number };
	end: { line: number };
}

/** Срез obsidian ListItemCache. */
export interface ListItemLike {
	position: PosLike;
	/** Символ статуса задачи; undefined — обычный пункт списка. */
	task?: string | undefined;
	/** Строка родительского пункта; отрицательное значение — корневой пункт. */
	parent: number;
}

/** Срез obsidian HeadingCache. */
export interface HeadingLike {
	position: PosLike;
	heading: string;
}

/** Ближайший заголовок выше строки; headings — в порядке документа. */
export function nearestHeadingAbove(headings: readonly HeadingLike[], line: number): string | null {
	let found: string | null = null;
	for (const h of headings) {
		if (h.position.start.line <= line) found = h.heading;
		else break;
	}
	return found;
}

/** Проекция кэша метаданных на плоские пункты списка с номерами строк. */
export function snapshotListItems(
	items: readonly ListItemLike[],
	headings: readonly HeadingLike[],
): SnapshotListItem[] {
	return items.map((it) => ({
		lineStart: it.position.start.line,
		lineEnd: it.position.end.line,
		taskChar: it.task ?? null,
		parentLine: it.parent >= 0 ? it.parent : null,
		heading: nearestHeadingAbove(headings, it.position.start.line),
	}));
}

const PROJECT_STATUSES: ReadonlySet<string> = new Set(["active", "on-hold", "done", "archived"]);

/**
 * FileContext из frontmatter-объекта. Приоритет флагов повторяет цепочку
 * состояний §1: TEMPLATE (gtd-recurring) > DETAIL (gtd-card-of) > project > board.
 */
export function fileContextFromFrontmatter(
	path: string,
	fm: Record<string, unknown> | null | undefined,
): FileContext {
	if (fm === null || fm === undefined) return { path, container: "plain" };
	if (fm["gtd-recurring"] === true) return { path, container: "recurring" };
	const cardOf = fm["gtd-card-of"];
	if (cardOf !== null && cardOf !== undefined && cardOf !== false && String(cardOf).trim() !== "")
		return { path, container: "card" };
	if (fm["gtd-project"] === true) {
		const status = normalizeProjectStatus(fm["status"]);
		return status === undefined
			? { path, container: "project" }
			: { path, container: "project", projectStatus: status };
	}
	if (fm["gtd-board"] === true) return { path, container: "board" };
	return { path, container: "plain" };
}

/** Отсутствие/пустой статус ⇒ undefined (трактуется как active, §1).
 *  Неизвестное значение — fail-closed «не активен», кодируем как on-hold. */
function normalizeProjectStatus(raw: unknown): ProjectStatus | undefined {
	if (raw === null || raw === undefined) return undefined;
	const s = String(raw).trim();
	if (s === "") return undefined;
	return PROJECT_STATUSES.has(s) ? (s as ProjectStatus) : "on-hold";
}

/** Локальная календарная дата (не UTC: день пользователя — день его таймзоны). */
export function localTodayIso(now: Date): IsoDate {
	const y = String(now.getFullYear()).padStart(4, "0");
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
