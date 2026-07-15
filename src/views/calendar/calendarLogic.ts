/**
 * Чистая логика календаря (ТЗ §4): сетки месяц/неделя/агенда, размещение
 * событий по дням, навигация, быстрый ввод. Ноль obsidian/DOM — тестируется
 * в node. Даты — только IsoDate-строки (лексикографика == хронология).
 */
import type { IsoDate, Priority, Task } from "../../core/model/Task";
import { taskToCalendarEvent, type CalendarField } from "../../core/model/projections";
import { addDaysIso, dayOfWeekSun0, startOfWeek } from "../common/dates";

export type CalendarMode = "month" | "week" | "agenda";

/** Размер страницы агенды: две недели — обозримо и накрывает «эту и следующую». */
export const AGENDA_PAGE_DAYS = 14;

/** Персистентное состояние вида (getState/setState) — JSON-сериализуемое (ТЗ §4). */
export interface CalendarPersistedState {
	mode?: CalendarMode;
	anchor?: IsoDate;
}

export interface DateRange {
	from: IsoDate;
	to: IsoDate; // включительно
}

export interface MonthGrid {
	/** 6 недель по 7 дней — фиксированная высота сетки без скачков между месяцами. */
	weeks: IsoDate[][];
	daysInView: DateRange;
}

/** Структурный порт записи для быстрого ввода; совместим с VaultAdapter. */
export interface CalendarWritePort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
}

/** Первое число месяца, в котором лежит anchor. */
export function monthStart(anchor: IsoDate): IsoDate {
	return anchor.slice(0, 8) + "01";
}

export function monthGrid(anchor: IsoDate, firstDayOfWeek: number): MonthGrid {
	const gridStart = startOfWeek(monthStart(anchor), firstDayOfWeek);
	const weeks: IsoDate[][] = [];
	let d = gridStart;
	for (let w = 0; w < 6; w++) {
		const row: IsoDate[] = [];
		for (let i = 0; i < 7; i++) {
			row.push(d);
			d = addDaysIso(d, 1);
		}
		weeks.push(row);
	}
	return { weeks, daysInView: { from: gridStart, to: addDaysIso(gridStart, 41) } };
}

export function weekRange(anchor: IsoDate, firstDayOfWeek: number): DateRange {
	const from = startOfWeek(anchor, firstDayOfWeek);
	return { from, to: addDaysIso(from, 6) };
}

export function agendaDays(from: IsoDate, days: number): IsoDate[] {
	const out: IsoDate[] = [];
	for (let i = 0; i < days; i++) out.push(addDaysIso(from, i));
	return out;
}

// ---------------------------------------------------------------------------
// Навигация. Месячные шаги нормализуют anchor на 01 число — исключает
// клампинг 29–31-х чисел при листании.
// ---------------------------------------------------------------------------

function firstOf(y: number, m: number): IsoDate {
	return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-01";
}

export function prevMonth(anchor: IsoDate): IsoDate {
	const y = Number(anchor.slice(0, 4));
	const m = Number(anchor.slice(5, 7));
	return m === 1 ? firstOf(y - 1, 12) : firstOf(y, m - 1);
}

export function nextMonth(anchor: IsoDate): IsoDate {
	const y = Number(anchor.slice(0, 4));
	const m = Number(anchor.slice(5, 7));
	return m === 12 ? firstOf(y + 1, 1) : firstOf(y, m + 1);
}

export function prevWeek(anchor: IsoDate): IsoDate {
	return addDaysIso(anchor, -7);
}

export function nextWeek(anchor: IsoDate): IsoDate {
	return addDaysIso(anchor, 7);
}

export function prevAgenda(anchor: IsoDate, pageDays = AGENDA_PAGE_DAYS): IsoDate {
	return addDaysIso(anchor, -pageDays);
}

export function nextAgenda(anchor: IsoDate, pageDays = AGENDA_PAGE_DAYS): IsoDate {
	return addDaysIso(anchor, pageDays);
}

// ---------------------------------------------------------------------------
// Размещение событий
// ---------------------------------------------------------------------------

export interface PlacedEvent {
	task: Task;
	/** Поле, по которому задача попала в этот день (из placement). */
	field: CalendarField;
}

const PRIORITY_RANK: Record<Priority, number> = {
	highest: 0,
	high: 1,
	medium: 2,
	low: 3,
	lowest: 4,
	none: 5,
};

/**
 * Раскладка задач по дням через core taskToCalendarEvent (fallback полей —
 * порядок placement). Дни без событий в Map отсутствуют. Внутри дня:
 * приоритет по убыванию, затем описание.
 */
export function placeEvents(
	tasks: readonly Task[],
	placement: readonly CalendarField[],
): Map<IsoDate, PlacedEvent[]> {
	const out = new Map<IsoDate, PlacedEvent[]>();
	for (const task of tasks) {
		const ev = taskToCalendarEvent(task, placement);
		if (ev === null) continue;
		let list = out.get(ev.date);
		if (list === undefined) {
			list = [];
			out.set(ev.date, list);
		}
		list.push({ task, field: ev.field });
	}
	for (const list of out.values()) {
		list.sort((a, b) => {
			const pr = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
			if (pr !== 0) return pr;
			const da = a.task.description;
			const db = b.task.description;
			return da < db ? -1 : da > db ? 1 : 0;
		});
	}
	return out;
}

/**
 * Поле для drop на день (ТЗ §8): задача уже видна в календаре — двигаем ЕЁ
 * поле (то, по которому она размещена placement'ом); иначе первое из
 * placement; пустой placement — due.
 */
export function dropDateField(task: Task, placement: readonly CalendarField[]): CalendarField {
	return taskToCalendarEvent(task, placement)?.field ?? placement[0] ?? "due";
}

/** Не done/cancelled — счётчик просроченных и их список в агенде. */
export function openTasks(tasks: readonly Task[]): Task[] {
	return tasks.filter(
		(t) => t.statusChar !== "x" && t.statusChar !== "X" && t.statusChar !== "-",
	);
}

// ---------------------------------------------------------------------------
// Быстрый ввод (клик по пустой области дня)
// ---------------------------------------------------------------------------

/** Строка захвата `- [ ] <текст> 📅 <дата>`; пустой текст — null (не пишем). */
export function quickAddLine(text: string, date: IsoDate): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	return `- [ ] ${trimmed} 📅 ${date}`;
}

/** Append строки в конец файла — тот же паттерн '\n', что у WritebackService.moveLine. */
export function appendLine(content: string, line: string): string {
	return content.trimEnd() !== ""
		? content + (content.endsWith("\n") ? "" : "\n") + line + "\n"
		: line + "\n";
}

// ---------------------------------------------------------------------------
// Презентация шапки/ячеек
// ---------------------------------------------------------------------------

const MONTHS_RU = [
	"Январь",
	"Февраль",
	"Март",
	"Апрель",
	"Май",
	"Июнь",
	"Июль",
	"Август",
	"Сентябрь",
	"Октябрь",
	"Ноябрь",
	"Декабрь",
] as const;

const WEEKDAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] as const;

export function monthTitle(anchor: IsoDate): string {
	const m = Number(anchor.slice(5, 7));
	return `${MONTHS_RU[m - 1] ?? "?"} ${anchor.slice(0, 4)}`;
}

/** Заголовки колонок сетки, начиная с firstDayOfWeek. */
export function weekdayNames(firstDayOfWeek: number): string[] {
	const f = ((firstDayOfWeek % 7) + 7) % 7;
	const out: string[] = [];
	for (let i = 0; i < 7; i++) out.push(WEEKDAYS_RU[(f + i) % 7]!);
	return out;
}

/** Заголовок дня в агенде: «Ср 2026-07-15». */
export function agendaLabel(date: IsoDate): string {
	return `${WEEKDAYS_RU[dayOfWeekSun0(date)]!} ${date}`;
}

// ---------------------------------------------------------------------------
// viewState
// ---------------------------------------------------------------------------

const MODES: readonly CalendarMode[] = ["month", "week", "agenda"];
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Раскладка могла прийти чужая/битая (setViewState зовут и другие плагины). */
export function sanitizeCalendarState(state: unknown): CalendarPersistedState | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
	const s = state as Record<string, unknown>;
	const next: CalendarPersistedState = {};
	const mode = s["mode"];
	if (typeof mode === "string" && (MODES as readonly string[]).includes(mode)) {
		next.mode = mode as CalendarMode;
	}
	const anchor = s["anchor"];
	if (typeof anchor === "string" && ISO_RE.test(anchor)) next.anchor = anchor;
	return next;
}
