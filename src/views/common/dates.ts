/**
 * Мини-дата-хелперы слоя видов (бакеты тикля, defer-пресеты).
 * core/recurrence/dateMath закрыт для внешних импортов по контракту модуля,
 * поэтому здесь свой минимум: Date поверх полуночи UTC — ни таймзон, ни DST.
 */
import type { IsoDate } from "../../core/model/Task";

const DAY_MS = 86_400_000;

export function addDaysIso(date: IsoDate, days: number): IsoDate {
	return new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

/** День недели в нумерации настроек firstDayOfWeek: 0=вс … 6=сб. */
export function dayOfWeekSun0(date: IsoDate): number {
	return new Date(date + "T00:00:00Z").getUTCDay();
}

/** Последний день недели, содержащей date, при заданном первом дне недели. */
export function endOfWeek(date: IsoDate, firstDayOfWeek: number): IsoDate {
	const lastDow = (firstDayOfWeek + 6) % 7;
	const delta = (lastDow - dayOfWeekSun0(date) + 7) % 7;
	return addDaysIso(date, delta);
}

/** Первый день недели, содержащей date, при заданном первом дне недели. */
export function startOfWeek(date: IsoDate, firstDayOfWeek: number): IsoDate {
	const delta = (dayOfWeekSun0(date) - firstDayOfWeek + 7) % 7;
	return addDaysIso(date, -delta);
}
