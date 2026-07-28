/**
 * Дата-математика для движка повторов (ТЗ §6).
 * Только целочисленная арифметика над {y,m,d} — никаких Date:
 * нет таймзон, нет DST, IsoDate сравнивается лексикографически.
 * Используется ТОЛЬКО внутри core/recurrence.
 */
import type { IsoDate } from "../model/Task";

/** m: 1..12, d: 1..31. */
export interface DateParts {
	y: number;
	m: number;
	d: number;
}

export function isLeap(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(y: number, m: number): number {
	const base = MONTH_LENGTHS[m - 1];
	if (base === undefined) throw new RangeError(`month out of range: ${m}`);
	return m === 2 && isLeap(y) ? 29 : base;
}

/** Клампинг дня к длине месяца: (2026, 2, 31) → 28. Ядро семантики «on the 31st». */
export function clampDay(y: number, m: number, d: number): number {
	const max = daysInMonth(y, m);
	return d > max ? max : d;
}

export function toParts(date: IsoDate): DateParts {
	return {
		y: parseInt(date.slice(0, 4), 10),
		m: parseInt(date.slice(5, 7), 10),
		d: parseInt(date.slice(8, 10), 10),
	};
}

export function fromParts(p: DateParts): IsoDate {
	const yy = String(p.y).padStart(4, "0");
	const mm = String(p.m).padStart(2, "0");
	const dd = String(p.d).padStart(2, "0");
	return `${yy}-${mm}-${dd}`;
}

/** -1 | 0 | 1; лексикографика == хронология для IsoDate. */
export function compare(a: IsoDate, b: IsoDate): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Строгая проверка формата и календарной корректности (2026-02-30 → false). */
export function isValidIsoDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const { y, m, d } = toParts(s);
	return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * Дни от эпохи 1970-01-01 (алгоритм Говарда Хиннанта, пролептический
 * григорианский календарь). Целочисленно, работает и для отрицательных значений.
 */
export function toEpochDays(date: IsoDate): number {
	const { y, m, d } = toParts(date);
	const yy = m <= 2 ? y - 1 : y;
	const era = Math.floor(yy / 400);
	const yoe = yy - era * 400; // [0, 399]
	const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
	return era * 146097 + doe - 719468;
}

export function fromEpochDays(z: number): IsoDate {
	const zz = z + 719468;
	const era = Math.floor(zz / 146097);
	const doe = zz - era * 146097; // [0, 146096]
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
	); // [0, 399]
	const y = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
	const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
	const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
	const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
	return fromParts({ y: m <= 2 ? y + 1 : y, m, d });
}

export function addDays(date: IsoDate, days: number): IsoDate {
	return fromEpochDays(toEpochDays(date) + days);
}

/**
 * День недели: 0 = понедельник … 6 = воскресенье (ISO).
 * Эта же нумерация используется в Rule.byDay (grammar.ts).
 */
export function dayOfWeek(date: IsoDate): number {
	const z = toEpochDays(date);
	// 1970-01-01 — четверг: z=0 → 3
	return ((((z % 7) + 7) % 7) + 3) % 7;
}

/**
 * Число ISO-недель (недели считаются от понедельника) между датами a и b:
 * (понедельник недели a − понедельник недели b) / 7. Всегда целое; знак — как у
 * a−b. Основа проверки чётности недель для weekly-правил с n>1 и якорем
 * (см. nextOccurrence/isOccurrence): дата «в фазе» ⇔ weeksBetween(date, anchor) % n === 0.
 */
export function weeksBetween(a: IsoDate, b: IsoDate): number {
	const mondayA = toEpochDays(a) - dayOfWeek(a);
	const mondayB = toEpochDays(b) - dayOfWeek(b);
	return (mondayA - mondayB) / 7;
}
