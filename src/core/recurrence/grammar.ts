/**
 * Мини-грамматика правил повторения (ТЗ §6):
 *
 *   every [N] (day|days|week|weeks|month|months|year|years|weekday|<weekday>)
 *             [on <weekday-list>] [on the <ordinal> | on the last day]
 *             [on <month-name> <day>] [until YYYY-MM-DD]
 *
 * rrule.js отвергнут сознательно: RFC-семантика ПРОПУСКАЕТ несуществующие даты,
 * а нам нужен клампинг («on the 31st» → Feb 28/29). Регистронезависимо;
 * имена дней недели и месяцев — полные и трёхбуквенные.
 */
import type { IsoDate } from "../model/Task";
import { isValidIsoDate } from "./dateMath";

export type Rule =
	| { freq: "daily"; n: number; until?: IsoDate }
	| { freq: "weekdays"; until?: IsoDate }
	// byDay: 0=понедельник … 6=воскресенье (см. dateMath.dayOfWeek).
	// byDay=[] легально («every week until …») — шаг от курсора без привязки к дню.
	| { freq: "weekly"; n: number; byDay: number[]; until?: IsoDate }
	| { freq: "monthly"; n: number; day: number | "last"; until?: IsoDate }
	| { freq: "yearly"; n: number; month: number; day: number; until?: IsoDate };

export interface ParseError {
	error: string;
}

export function isParseError(r: Rule | ParseError): r is ParseError {
	return "error" in r;
}

const WEEKDAY_NAMES: ReadonlyMap<string, number> = new Map([
	["monday", 0],
	["mon", 0],
	["tuesday", 1],
	["tue", 1],
	["wednesday", 2],
	["wed", 2],
	["thursday", 3],
	["thu", 3],
	["friday", 4],
	["fri", 4],
	["saturday", 5],
	["sat", 5],
	["sunday", 6],
	["sun", 6],
]);

const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
	["january", 1],
	["jan", 1],
	["february", 2],
	["feb", 2],
	["march", 3],
	["mar", 3],
	["april", 4],
	["apr", 4],
	["may", 5],
	["june", 6],
	["jun", 6],
	["july", 7],
	["jul", 7],
	["august", 8],
	["aug", 8],
	["september", 9],
	["sep", 9],
	["october", 10],
	["oct", 10],
	["november", 11],
	["nov", 11],
	["december", 12],
	["dec", 12],
]);

// Максимум дня для yearly-правила: февралю разрешено 29 — на невисокосном
// году вычислитель клампит к 28.
const YEARLY_MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** «fridays» → «friday»; трёхбуквенные тоже терпят хвостовое s. */
function lookupWeekday(tok: string): number | null {
	const direct = WEEKDAY_NAMES.get(tok);
	if (direct !== undefined) return direct;
	if (tok.endsWith("s")) {
		const stripped = WEEKDAY_NAMES.get(tok.slice(0, -1));
		if (stripped !== undefined) return stripped;
	}
	return null;
}

const ORDINAL_RE = /^(\d+)(st|nd|rd|th)?$/;

export function parseRule(text: string): Rule | ParseError {
	const tokens = text.trim().toLowerCase().split(/[\s,]+/).filter((t) => t.length > 0);
	let i = 0;

	if (tokens[i] !== "every") return { error: "rule must start with 'every'" };
	i++;

	// необязательный интервал N
	let n = 1;
	let hasN = false;
	const nTok = tokens[i];
	if (nTok !== undefined && /^\d+$/.test(nTok)) {
		n = parseInt(nTok, 10);
		hasN = true;
		if (n < 1) return { error: "interval must be at least 1" };
		i++;
	}

	// единица
	const unitTok = tokens[i];
	if (unitTok === undefined) return { error: "expected a unit after 'every'" };
	i++;

	type UnitKind = "daily" | "weekly" | "monthly" | "yearly" | "weekdays" | "weekday-name";
	let kind: UnitKind;
	let unitWeekday = -1;
	if (unitTok === "day" || unitTok === "days") kind = "daily";
	else if (unitTok === "week" || unitTok === "weeks") kind = "weekly";
	else if (unitTok === "month" || unitTok === "months") kind = "monthly";
	else if (unitTok === "year" || unitTok === "years") kind = "yearly";
	else if (unitTok === "weekday" || unitTok === "weekdays") kind = "weekdays";
	else {
		const wd = lookupWeekday(unitTok);
		if (wd === null) return { error: `unknown unit '${unitTok}'` };
		kind = "weekday-name";
		unitWeekday = wd;
	}

	// клаузы on/until (порядок свободный, каждая — не более одного раза)
	let until: IsoDate | undefined;
	let onWeekdays: number[] | null = null;
	let onMonthDay: number | "last" | null = null;
	let onDate: { month: number; day: number } | null = null;

	while (i < tokens.length) {
		const t = tokens[i];
		if (t === "until") {
			i++;
			const dt = tokens[i];
			if (dt === undefined || !isValidIsoDate(dt)) {
				return { error: "expected a valid YYYY-MM-DD date after 'until'" };
			}
			if (until !== undefined) return { error: "duplicate 'until'" };
			until = dt;
			i++;
			continue;
		}
		if (t !== "on") return { error: `unexpected token '${t}'` };
		i++;
		const t2 = tokens[i];
		if (t2 === undefined) return { error: "expected a target after 'on'" };

		if (t2 === "the") {
			// on the <ordinal> | on the last day
			i++;
			const t3 = tokens[i];
			if (t3 === "last") {
				i++;
				if (tokens[i] !== "day") return { error: "expected 'day' after 'on the last'" };
				i++;
				if (onMonthDay !== null) return { error: "duplicate day-of-month clause" };
				onMonthDay = "last";
			} else {
				const m = t3 !== undefined ? ORDINAL_RE.exec(t3) : null;
				if (!m || m[1] === undefined) {
					return { error: "expected a day number or 'last day' after 'on the'" };
				}
				const dnum = parseInt(m[1], 10);
				if (dnum < 1 || dnum > 31) return { error: `day of month out of range: ${dnum}` };
				if (onMonthDay !== null) return { error: "duplicate day-of-month clause" };
				onMonthDay = dnum;
				i++;
			}
			continue;
		}

		const monthNum = MONTH_NAMES.get(t2);
		if (monthNum !== undefined) {
			// on <month-name> <day>
			i++;
			const dTok = tokens[i];
			const m = dTok !== undefined ? ORDINAL_RE.exec(dTok) : null;
			if (!m || m[1] === undefined) {
				return { error: `expected a day number after month name '${t2}'` };
			}
			const dnum = parseInt(m[1], 10);
			const maxDay = YEARLY_MAX_DAY[monthNum - 1];
			if (maxDay === undefined || dnum < 1 || dnum > maxDay) {
				return { error: `'${t2} ${dnum}' is not a valid date` };
			}
			if (onDate !== null) return { error: "duplicate month-day clause" };
			onDate = { month: monthNum, day: dnum };
			i++;
			continue;
		}

		// on <weekday-list>
		const list: number[] = [];
		while (i < tokens.length) {
			const wTok = tokens[i];
			const wd = wTok !== undefined ? lookupWeekday(wTok) : null;
			if (wd === null) break;
			list.push(wd);
			i++;
		}
		if (list.length === 0) return { error: `cannot parse 'on ${t2}'` };
		if (onWeekdays !== null) return { error: "duplicate weekday clause" };
		onWeekdays = [...new Set(list)].sort((a, b) => a - b);
	}

	const withUntil = (r: Rule): Rule => (until !== undefined ? { ...r, until } : r);

	switch (kind) {
		case "daily":
			if (onWeekdays !== null || onMonthDay !== null || onDate !== null) {
				return { error: "daily rules do not take an 'on' clause" };
			}
			return withUntil({ freq: "daily", n });
		case "weekdays":
			if (hasN) return { error: "'every weekday' does not take an interval" };
			if (onWeekdays !== null || onMonthDay !== null || onDate !== null) {
				return { error: "'every weekday' does not take an 'on' clause" };
			}
			return withUntil({ freq: "weekdays" });
		case "weekday-name":
			if (onWeekdays !== null || onMonthDay !== null || onDate !== null) {
				return { error: `'every ${unitTok}' does not take an 'on' clause` };
			}
			return withUntil({ freq: "weekly", n, byDay: [unitWeekday] });
		case "weekly":
			if (onMonthDay !== null || onDate !== null) {
				return { error: "weekly rules take only 'on <weekday, ...>'" };
			}
			return withUntil({ freq: "weekly", n, byDay: onWeekdays ?? [] });
		case "monthly":
			if (onWeekdays !== null || onDate !== null) {
				return { error: "monthly rules take only 'on the <day>' / 'on the last day'" };
			}
			// день обязателен: Rule.monthly без day не представим
			if (onMonthDay === null) {
				return { error: "monthly rule requires 'on the <day>' or 'on the last day'" };
			}
			return withUntil({ freq: "monthly", n, day: onMonthDay });
		case "yearly":
			if (onWeekdays !== null || onMonthDay !== null) {
				return { error: "yearly rules take only 'on <month-name> <day>'" };
			}
			if (onDate === null) return { error: "yearly rule requires 'on <month-name> <day>'" };
			return withUntil({ freq: "yearly", n, month: onDate.month, day: onDate.day });
	}
}
