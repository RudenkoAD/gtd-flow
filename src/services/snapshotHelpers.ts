/**
 * Чистые помощники построения FileSnapshot. Принимают плоские данные,
 * структурно совместимые с кэшами Obsidian (ListItemCache/HeadingCache/
 * frontmatter), но не импортируют 'obsidian' — тестируются в голом node.
 * Единственный потребитель — MetadataAdapter, который остаётся тонким.
 */
import {
	fileContextFromContainerFrontmatter,
	projectContainerFrontmatter,
} from "../core/frontmatter/containerFrontmatter";
import type { FileContext, IsoDate } from "../core/model/Task";
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

/**
 * FileContext из полного frontmatter-объекта. Семантика контейнеров живёт в
 * dependency-free core-проекции, которую также используют MCP и QuickJS-виджет.
 */
export function fileContextFromFrontmatter(
	path: string,
	fm: Record<string, unknown> | null | undefined,
): FileContext {
	return fileContextFromContainerFrontmatter(path, projectContainerFrontmatter(fm));
}

/** frontmatter gtd-namespace → override пространства (перебивает папку). Только
 *  НЕПУСТАЯ строка (после trim) даёт override; число/boolean/пусто/отсутствие ⇒
 *  null (мусор игнорируется, файл остаётся в пространстве своей папки). Экспорт —
 *  для discovery сервисов (Board/Project), фильтрующих по пространству напрямую
 *  из сырого frontmatter, минуя индекс. */
export function frontmatterNamespace(
	fm: Record<string, unknown> | null | undefined,
): string | null {
	return projectContainerFrontmatter(fm).nsOverride ?? null;
}

/** Локальная календарная дата (не UTC: день пользователя — день его таймзоны). */
export function localTodayIso(now: Date): IsoDate {
	const y = String(now.getFullYear()).padStart(4, "0");
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
