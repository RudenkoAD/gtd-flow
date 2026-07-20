/**
 * Чистая логика календаря (ТЗ §4): сетки месяц/неделя/агенда, размещение
 * событий по дням, навигация, быстрый ввод. Ноль obsidian/DOM — тестируется
 * в node. Даты — только IsoDate-строки (лексикографика == хронология).
 */
import type { IsoDate, Priority, Task } from "../../core/model/Task";
import { taskToCalendarEvent, type CalendarField } from "../../core/model/projections";
import { setValueField } from "../../core/parser/serializeTaskLine";
import {
	ALL_NS,
	NS_CONVENTION,
	nsCommonTarget,
	nsTargetPath,
	type NamespaceDef,
} from "../../core/namespace/namespace";
import { isInTickler } from "../../core/query/QueryEngine";
import { isParseError, parseRule } from "../../core/recurrence/grammar";
import { expandOccurrences } from "../../core/recurrence/occurrences";
import { addDaysIso, dayOfWeekSun0, startOfWeek } from "../common/dates";
import { timeToMinutes } from "./timeGrid";

export type CalendarMode = "month" | "week" | "agenda" | "3days" | "day";

/** Ширина страницы режима «3 дня»: якорь + два следующих дня. */
export const DAYS3_PAGE_DAYS = 3;

/** Дней в неделе — число колонок почасовой сетки режима «Неделя». */
export const WEEK_DAYS = 7;

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

/** Структурный порт записи для быстрого ввода и событий; совместим с VaultAdapter. */
export interface CalendarWritePort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
	/** Создание/правка frontmatter файла событий (gtd-events: true). */
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<unknown>;
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

/** Время ("HH:mm") ИМЕННО поля-размещения — того, по которому чип попал в день. */
export function placedTime(task: Task, field: CalendarField): string | null {
	switch (field) {
		case "due":
			return task.dueTime;
		case "scheduled":
			return task.scheduledTime;
		case "start":
			return task.startTime;
	}
}

/** Конец интервала поля-размещения (парно placedTime; null — длительности нет). */
export function placedTimeEnd(task: Task, field: CalendarField): string | null {
	switch (field) {
		case "due":
			return task.dueTimeEnd;
		case "scheduled":
			return task.scheduledTimeEnd;
		case "start":
			return task.startTimeEnd;
	}
}

/**
 * Бейдж времени записи для чипа/агенды: «HH:mm–HH:mm», когда конец задан и строго
 * позже начала, иначе только начало «HH:mm»; null — времени нет (без бейджа).
 * "HH:mm" лексикографика == хронология — конец сверяется сравнением строк (как
 * layoutDay.hasEnd), вырожденный конец (≤ начала) выпадает, остаётся начало.
 * Тире — en-dash (U+2013), как в блоках тайм-сетки.
 */
export function agendaTimeLabel(time: string | null, timeEnd: string | null): string | null {
	if (time === null) return null;
	return timeEnd !== null && timeEnd > time ? `${time}–${timeEnd}` : time;
}

/**
 * Разбор поля времени модала одноразового события в пару начало/конец.
 * Формы: "" → без времени (обе null); "HH:mm" → только начало; "HH:mm-HH:mm" →
 * начало и конец. Каждая часть валидируется как время суток (timeToMinutes,
 * 00:00–23:59). Любая иная форма/битое время → null (модал не пускает submit).
 * Вырожденный конец (≤ начала) здесь НЕ отбраковывается — его снимает
 * buildSingleOccurrenceLine (канон парсера), как и при переносе вхождения.
 */
export function parseTimeRange(
	input: string,
): { time: string | null; timeEnd: string | null } | null {
	const s = input.trim();
	if (s === "") return { time: null, timeEnd: null };
	const parts = s.split("-");
	if (parts.length === 1) {
		const t = parts[0]!.trim();
		return timeToMinutes(t) === null ? null : { time: t, timeEnd: null };
	}
	if (parts.length === 2) {
		const a = parts[0]!.trim();
		const b = parts[1]!.trim();
		if (timeToMinutes(a) === null || timeToMinutes(b) === null) return null;
		return { time: a, timeEnd: b };
	}
	return null;
}

/**
 * Обратно parseTimeRange: пара начало/конец → строка для преднаполнения поля
 * времени модала. Дефис ASCII (не en-dash agendaTimeLabel) — чтобы parseTimeRange
 * прочитал результат обратно. Конец пишется только строго позже начала (иначе
 * выпадает, как в бейдже/строке события); без начала — пустая строка.
 */
export function formatTimeRange(time: string | null, timeEnd: string | null): string {
	if (time === null) return "";
	return timeEnd !== null && timeEnd > time ? `${time}-${timeEnd}` : time;
}

/**
 * «Отложена до»: дата 🛫 задачи в состоянии TICKLER (§1: не done/cancelled,
 * не шаблон/деталь, start > today), иначе null. Для приглушённого чипа с ⏰.
 */
export function deferredUntil(task: Task, today: IsoDate): IsoDate | null {
	return isInTickler(task, today) ? task.start : null;
}

/**
 * Раскладка задач по дням через core taskToCalendarEvent (fallback полей —
 * порядок placement). Дни без событий в Map отсутствуют. Внутри дня:
 * сначала события со временем (по времени asc), затем без времени;
 * внутри групп — приоритет по убыванию, затем описание.
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
			// "HH:mm" лексикографически == хронологически; null (без времени) — в хвост
			const ta = placedTime(a.task, a.field);
			const tb = placedTime(b.task, b.field);
			if (ta !== null || tb !== null) {
				if (ta === null) return 1;
				if (tb === null) return -1;
				if (ta !== tb) return ta < tb ? -1 : 1;
			}
			const pr = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
			if (pr !== 0) return pr;
			const da = a.task.description;
			const db = b.task.description;
			return da < db ? -1 : da > db ? 1 : 0;
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Повторяющиеся события (виртуальные вхождения, §события)
// ---------------------------------------------------------------------------

/**
 * Одно вхождение события календаря на конкретную дату (§события). Не обычная
 * задача: рендерится, но не кликается чекбоксом.
 * - kind "series" — виртуальное вхождение повторяющейся серии (🔁); `task` —
 *   строка-серия, якорь меню «Изменить/Удалить серию» и переноса вхождения.
 * - kind "single" — одноразовое событие (строка в gtd-events БЕЗ 🔁, но с 📅);
 *   `task` — сама эта строка (перенос правит её собственную дату/время).
 */
export interface EventOccurrence {
	/** Строка события (container events) — якорь меню и правок. */
	task: Task;
	/** Серия (виртуальное вхождение) или одноразовое событие. */
	kind: "series" | "single";
	date: IsoDate;
	/** Название = описание строки события. */
	title: string;
	/** "HH:mm" начала (rule.eventTime / dueTime) или null — «Весь день». */
	time: string | null;
	/** "HH:mm" конца интервала (rule.eventTimeEnd / dueTimeEnd) или null. */
	timeEnd: string | null;
	/** 📍 место/адрес строки события (task.location) или null — показывается
	 *  подсказкой при наведении на чип/блок. Общий для серии и одноразового. */
	location: string | null;
}

/**
 * Развернуть события (container events) в вхождения по видимому диапазону:
 * - строка с 🔁 → виртуальные вхождения серии; даты из 🚫 (task.excludedDates)
 *   пропускаются (перенос/отмена одного занятия). Битое/пустое правило молча
 *   пропускается (бейдж ошибки — v2).
 * - строка БЕЗ 🔁, но с 📅 → одноразовое событие на своей дате (📅/dueTime/
 *   dueTimeEnd), если дата в диапазоне.
 * Внутри дня сортировка как у placeEvents: со временем по времени asc, без
 * времени — в хвост, затем по названию. Ключ вхождения для рендера — task.key
 * (одна строка даёт не более одного вхождения на дату).
 */
export function expandEventOccurrences(
	events: readonly Task[],
	from: IsoDate,
	to: IsoDate,
): Map<IsoDate, EventOccurrence[]> {
	const out = new Map<IsoDate, EventOccurrence[]>();
	const push = (occ: EventOccurrence): void => {
		let list = out.get(occ.date);
		if (list === undefined) {
			list = [];
			out.set(occ.date, list);
		}
		list.push(occ);
	};
	for (const task of events) {
		if (task.recurrence !== null) {
			const rule = parseRule(task.recurrence);
			if (isParseError(rule)) continue;
			const time = rule.eventTime ?? null;
			const timeEnd = rule.eventTimeEnd ?? null;
			const exclude =
				task.excludedDates.length > 0 ? new Set(task.excludedDates) : undefined;
			for (const date of expandOccurrences(rule, from, to, undefined, exclude)) {
				push({
					task,
					kind: "series",
					date,
					title: task.description,
					time,
					timeEnd,
					location: task.location,
				});
			}
		} else if (task.due !== null && task.due >= from && task.due <= to) {
			// одноразовое событие: строка события без 🔁, но с 📅 — на своей дате
			push({
				task,
				kind: "single",
				date: task.due,
				title: task.description,
				time: task.dueTime,
				timeEnd: task.dueTimeEnd,
				location: task.location,
			});
		}
	}
	for (const list of out.values()) {
		list.sort((a, b) => {
			if (a.time !== null || b.time !== null) {
				if (a.time === null) return 1;
				if (b.time === null) return -1;
				if (a.time !== b.time) return a.time < b.time ? -1 : 1;
			}
			return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
		});
	}
	return out;
}

/**
 * Единый элемент дня агенды/ячейки: задача (чип задачи) ИЛИ вхождение события
 * (чип события) — чтобы рендерить оба типа из ОДНОГО отсортированного списка.
 */
export type AgendaDayItem =
	| { kind: "task"; ev: PlacedEvent }
	| { kind: "event"; occ: EventOccurrence };

/**
 * Слить задачи дня (placeEvents) и вхождения событий дня (expandEventOccurrences)
 * в ЕДИНЫЙ список с общей сортировкой по времени — без группировки по типу
 * (баг: «○ 13:45 задача» стояла выше «◇ 09:00 события»). Инвариант:
 *  • элементы без времени / «на весь день» — ПЕРВЫМИ (событие перед задачей);
 *  • затем всё остальное по возрастанию времени начала, НЕЗАВИСИМО от типа;
 *  • при равном времени — событие перед задачей, далее стабильно (исходный
 *    порядок внутри каждого списка: у задач — приоритет/описание placeEvents,
 *    у событий — название expandEventOccurrences).
 * Время задачи — поля-размещения (placedTime); "HH:mm" лексикографика ==
 * хронология. sort стабилен (Node ≥ 11) — секундарные ключи входов сохраняются.
 */
export function mergeDayItems(
	events: readonly PlacedEvent[],
	occurrences: readonly EventOccurrence[],
): AgendaDayItem[] {
	// typeRank: событие (0) раньше задачи (1) при равенстве времени — «событие перед задачей»
	const rows: { item: AgendaDayItem; time: string | null; typeRank: number }[] = [];
	for (const occ of occurrences) rows.push({ item: { kind: "event", occ }, time: occ.time, typeRank: 0 });
	for (const ev of events)
		rows.push({ item: { kind: "task", ev }, time: placedTime(ev.task, ev.field), typeRank: 1 });
	rows.sort((a, b) => {
		const an = a.time === null;
		const bn = b.time === null;
		if (an !== bn) return an ? -1 : 1; // без времени — вперёд группой
		if (!an && a.time !== b.time) return a.time! < b.time! ? -1 : 1; // оба со временем — asc
		return a.typeRank - b.typeRank; // равенство (оба без времени / равное время): событие раньше, далее стабильно
	});
	return rows.map((r) => r.item);
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

/** Строка захвата `- [ ] <текст> 📅 <дата>[ HH:mm[-HH:mm]] [📍 <место>]`; пустой
 *  текст — null. time/timeEnd приходят из клика или click-drag по слоту time-grid —
 *  формат хвоста тот же, что у парсера (конец интервала только вместе со временем
 *  начала). location — из отдельного поля «Место» quick-add: непустое дописывается
 *  полем 📍 (setValueField ядра, тот же путь, что у событий). Недопустимое место
 *  (эмодзи поля в значении) не роняет захват — строка возвращается без 📍 (совместимо
 *  с принципом «рядовой юзер не пишет эмодзи полей руками»). */
export function quickAddLine(
	text: string,
	date: IsoDate,
	time: string | null = null,
	timeEnd: string | null = null,
	location: string | null = null,
): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const timePart = time !== null ? ` ${time}${timeEnd !== null ? `-${timeEnd}` : ""}` : "";
	const base = `- [ ] ${trimmed} 📅 ${date}${timePart}`;
	const loc = (location ?? "").trim();
	if (loc === "") return base;
	try {
		return setValueField(base, "location", loc);
	} catch {
		return base; // эмодзи поля в месте — задача без 📍, а не отказ захвата
	}
}

/** Append строки в конец файла — тот же паттерн '\n', что у WritebackService.moveLine. */
export function appendLine(content: string, line: string): string {
	return content.trimEnd() !== ""
		? content + (content.endsWith("\n") ? "" : "\n") + line + "\n"
		: line + "\n";
}

/**
 * Файл событий (container events) для ИНЛАЙН-создания события в календаре по
 * ЛОКАЛЬНОМУ пространству вида:
 *  • именованное / «Общее» (local ≠ ALL_NS) — <root>/События.md (nsTargetPath),
 *    фолбэк «Общего» (root не выделен) — eventsFileFallback (settings.eventsFile);
 *  • вкладка «Все» (local === ALL_NS) — конкретного пространства нет, поэтому файл
 *    событий ОБЩЕЙ папки <commonRoot>/События.md (nsCommonTarget): общий календарь
 *    пишет в «дом» «Общего», а не в глобальный дефолт.
 * Настроек ядро не знает — eventsFileFallback и commonRoot приходят снаружи.
 */
export function eventTargetForNamespace(
	local: string,
	defs: readonly NamespaceDef[],
	eventsFileFallback: string,
	commonRoot: string,
): string {
	return local === ALL_NS
		? nsCommonTarget(ALL_NS, defs, NS_CONVENTION.events, commonRoot)
		: nsTargetPath(local, defs, NS_CONVENTION.events, eventsFileFallback);
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

// Старые сохранённые state (mode ∈ month/week/agenda) остаются валидными —
// новые режимы только расширяют множество допустимых значений.
const MODES: readonly CalendarMode[] = ["month", "week", "agenda", "3days", "day"];
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
