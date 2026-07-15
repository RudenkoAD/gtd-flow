/**
 * Чистые проекции Task для видов (ТЗ §2, §4): входящая, событие календаря, карточка доски.
 * Модуль намеренно не импортирует другие подсистемы core — виды остаются развязанными.
 */
import type { IsoDate, Priority, Task } from "./Task";

/** Поле размещения в календаре. Структурно совпадает с CalendarField настроек (§9);
 *  дублируем локально: core не импортирует ничего вне core. */
export type CalendarField = "due" | "scheduled" | "start";

// ---------------------------------------------------------------------------
// Входящие
// ---------------------------------------------------------------------------

export interface InboxItem {
	key: string;
	taskId: string | null;
	description: string;
	priority: Priority;
	due: IsoDate | null;
	scheduled: IsoDate | null;
	start: IsoDate | null;
	created: IsoDate | null;
	tags: string[];
	filePath: string;
	lineStart: number;
	heading: string | null;
	/** Задача всплыла из проекта по готовности (§1, третья ветка inbox-запроса). */
	fromProject: boolean;
}

export function taskToInboxItem(t: Task): InboxItem {
	return {
		key: t.key,
		taskId: t.taskId,
		description: t.description,
		priority: t.priority,
		due: t.due,
		scheduled: t.scheduled,
		start: t.start,
		created: t.created,
		tags: [...t.tags],
		filePath: t.filePath,
		lineStart: t.lineStart,
		heading: t.heading,
		fromProject: t.container === "project",
	};
}

// ---------------------------------------------------------------------------
// Календарь
// ---------------------------------------------------------------------------

export interface CalendarEvent {
	date: IsoDate;
	field: CalendarField;
}

/** Первое непустое поле по приоритету placement (по умолчанию due → scheduled → start, §9).
 *  null — у задачи нет ни одного из полей placement, в календаре не показывается. */
export function taskToCalendarEvent(
	task: Task,
	placement: readonly CalendarField[],
): CalendarEvent | null {
	for (const field of placement) {
		const date = task[field];
		if (date !== null) return { date, field };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Доска (kanban)
// ---------------------------------------------------------------------------

/**
 * Минимальные локальные типы колонки. Импорта core/board нет (развязка), поэтому
 * tag-семантика ОБЯЗАНА совпадать с board/membership.matchesSpec: tag принимается
 * с '#' и без (boardFile.parseMatchSpec отдаёт без '#'), вложенный тег #a/b —
 * член колонки '#a'.
 */
export type ColumnMatch =
	| { kind: "tag"; tag: string } // колонка = тег #kanban/<board>/<col>
	| { kind: "status"; statusChar: string }; // per-board group-by: status

export interface MinimalColumnSpec {
	id: string;
	match: ColumnMatch;
}

export interface BoardCard {
	key: string;
	taskId: string | null;
	description: string;
	priority: Priority;
	due: IsoDate | null;
	tags: string[];
	/** id первой подошедшей колонки; null — не попала ни в одну. */
	columnId: string | null;
}

/** Заглушка-проекция для доски: раскладку/порядок делает core/board, здесь только маппинг. */
export function taskToBoardCard(task: Task, columns: readonly MinimalColumnSpec[]): BoardCard {
	let columnId: string | null = null;
	for (const col of columns) {
		if (matchesColumn(task, col.match)) {
			columnId = col.id;
			break;
		}
	}
	return {
		key: task.key,
		taskId: task.taskId,
		description: task.description,
		priority: task.priority,
		due: task.due,
		tags: [...task.tags],
		columnId,
	};
}

function matchesColumn(task: Task, match: ColumnMatch): boolean {
	switch (match.kind) {
		case "tag": {
			// нормализуем '#' с обеих сторон и матчим вложенные теги —
			// та же семантика, что в board/membership.matchesSpec
			const want = match.tag.startsWith("#") ? match.tag.slice(1) : match.tag;
			return task.tags.some((raw) => {
				const t = raw.startsWith("#") ? raw.slice(1) : raw;
				return t === want || t.startsWith(want + "/");
			});
		}
		case "status":
			return task.statusChar === match.statusChar;
	}
}
