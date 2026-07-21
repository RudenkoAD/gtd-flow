/**
 * Мини-грамматика правил повторения (ТЗ §6):
 *
 *   (every|every!) [N] (day|days|week|weeks|month|months|year|years|weekday|<weekday>)
 *             [on <weekday-list>] [on the <ordinal> | on the last day]
 *             [on <month-name> <day>] [at HH:mm[-HH:mm]]
 *             [from YYYY-MM-DD] [until YYYY-MM-DD]
 *
 * Префикс-модификатор «every!» (Todoist-подобный, ТЗ §every!) переключает правило
 * в режим «от выполнения»: следующее вхождение отсчитывается от ДАТЫ ВЫПОЛНЕНИЯ
 * предыдущей копии, а не по календарной сетке (fromCompletion: true). Допустим для
 * ВСЕХ частот, но НЕСОВМЕСТИМ с любой «on»-клаузой и с byDay-единицей (every! week
 * on tue / every! friday бессмысленны — от выполнения нет фиксированного дня);
 * monthly/yearly в этом режиме НЕ требуют и НЕ принимают день/дату (день считается
 * от даты выполнения). from/until совместимы (until — верхняя граница как обычно;
 * from — не раньше). Только для задач: серии СОБЫТИЙ с every! запрещены (событие
 * не «выполняется»; см. валидацию в §события). Разворот по календарю
 * (nextOccurrence/occurrences) для таких правил не определён — там они дают
 * пусто/null, чтобы циклы не зацикливались; их движок — spawnPlan.
 *
 * Хвост "at HH:mm[-HH:mm]" — время вхождения повторяющегося события календаря
 * (ТЗ §события): 'every tuesday at 19:00-20:30', 'every day at 09:00'. Для
 * шаблонов регулярного ящика он игнорируется движком спавна (date-уровень).
 *
 * Клаузы "from YYYY-MM-DD" (нижняя граница, включительно) и "until YYYY-MM-DD"
 * (верхняя граница, включительно) ограничивают серию с обеих сторон; порядок
 * относительно on/at свободный, каждая — не более одного раза, from ≤ until.
 *
 * rrule.js отвергнут сознательно: RFC-семантика ПРОПУСКАЕТ несуществующие даты,
 * а нам нужен клампинг («on the 31st» → Feb 28/29). Регистронезависимо;
 * имена дней недели и месяцев — полные и трёхбуквенные.
 */
import type { IsoDate } from "../model/Task";
import { compare, isValidIsoDate } from "./dateMath";

/**
 * Опциональное время вхождения (ТЗ §события): хвост " at HH:mm[-HH:mm]" правила.
 * Значимо ТОЛЬКО для повторяющихся событий календаря; для шаблонов регулярного
 * ящика игнорируется движком спавна (nextOccurrence/isOccurrence — date-уровень).
 * eventTimeEnd валиден только вместе с eventTime и строго позже него.
 */
export interface EventTime {
	/** "HH:mm" начала вхождения; отсутствие — «Весь день». */
	eventTime?: string;
	/** "HH:mm" конца интервала; только при eventTime и строго позже него. */
	eventTimeEnd?: string;
}

// Хвостовые опции, общие для всех частот:
// - from:  нижняя граница серии (включительно, §6) — вхождений раньше неё не бывает.
// - until: верхняя граница (включительно). Обе опциональны и валидны на любом freq.
// - fromCompletion: режим «от выполнения» (§every!). true ⇒ следующее вхождение
//   считается от даты ✅ предыдущей копии (spawnPlan.nextFromCompletion), а не по
//   календарю; ключ отсутствует у обычных правил (never `false`), чтобы round-trip
//   тесты сравнивали ровно {freq,n,…} без лишних полей.
type RuleTail = { from?: IsoDate; until?: IsoDate; fromCompletion?: true } & EventTime;
export type Rule =
	| ({ freq: "daily"; n: number } & RuleTail)
	| ({ freq: "weekdays" } & RuleTail)
	// byDay: 0=понедельник … 6=воскресенье (см. dateMath.dayOfWeek).
	// byDay=[] легально («every week until …») — шаг от курсора без привязки к дню.
	| ({ freq: "weekly"; n: number; byDay: number[] } & RuleTail)
	// day/month опциональны ТОЛЬКО ради fromCompletion (у every! month/year нет
	// фиксированного дня — он от даты выполнения). Календарный парс их всегда
	// заполняет, календарные потребители (nextOccurrence/isOccurrence) защищены
	// ранним выходом на fromCompletion и точечными guard'ами.
	| ({ freq: "monthly"; n: number; day?: number | "last" } & RuleTail)
	| ({ freq: "yearly"; n: number; month?: number; day?: number } & RuleTail);

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

/** Валидное время "HH:mm", 24 часа — тот же гейт, что у парсера задач (tokenizer.TIME_RE);
 *  дублируется локально: core/recurrence не зависит от core/parser. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseRule(text: string): Rule | ParseError {
	const tokens = text.trim().toLowerCase().split(/[\s,]+/).filter((t) => t.length > 0);
	let i = 0;

	// префикс: «every» (календарь) либо «every!» (от выполнения, §every!)
	let fromCompletion = false;
	if (tokens[i] === "every!") {
		fromCompletion = true;
		i++;
	} else if (tokens[i] === "every") {
		i++;
	} else {
		return { error: "rule must start with 'every' (or 'every!' for from-completion)" };
	}

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

	// клаузы on/from/until/at (порядок свободный, каждая — не более одного раза)
	let from: IsoDate | undefined;
	let until: IsoDate | undefined;
	let onWeekdays: number[] | null = null;
	let onMonthDay: number | "last" | null = null;
	let onDate: { month: number; day: number } | null = null;
	let eventTime: string | undefined;
	let eventTimeEnd: string | undefined;

	while (i < tokens.length) {
		const t = tokens[i];
		if (t === "at") {
			// хвост времени вхождения: "at HH:mm" | "at HH:mm-HH:mm"
			i++;
			const spec = tokens[i];
			if (spec === undefined) return { error: "expected a time after 'at'" };
			if (eventTime !== undefined) return { error: "duplicate 'at'" };
			const dash = spec.indexOf("-");
			if (dash === -1) {
				if (!TIME_RE.test(spec)) return { error: `invalid time '${spec}' after 'at'` };
				eventTime = spec;
			} else {
				const startPart = spec.slice(0, dash);
				const endPart = spec.slice(dash + 1);
				if (!TIME_RE.test(startPart) || !TIME_RE.test(endPart)) {
					return { error: `invalid time range '${spec}' after 'at'` };
				}
				// лексикографика "HH:mm" == хронология: конец строго позже начала
				if (endPart <= startPart) return { error: "'at' end time must be after start time" };
				eventTime = startPart;
				eventTimeEnd = endPart;
			}
			i++;
			continue;
		}
		if (t === "from") {
			i++;
			const dt = tokens[i];
			if (dt === undefined || !isValidIsoDate(dt)) {
				return { error: "expected a valid YYYY-MM-DD date after 'from'" };
			}
			if (from !== undefined) return { error: "duplicate 'from'" };
			from = dt;
			i++;
			continue;
		}
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

	// нижняя граница не может быть позже верхней (обе включительно)
	if (from !== undefined && until !== undefined && compare(from, until) > 0) {
		return { error: "'from' must not be after 'until'" };
	}

	// хвостовые опции (from + until + время вхождения + fromCompletion) — единым
	// спредом на любой freq. fromCompletion пишется только когда true: обычные
	// правила остаются ровно {freq,n,…} (round-trip тесты сравнивают toEqual).
	const withTail = (r: Rule): Rule => {
		const out = { ...r };
		if (from !== undefined) out.from = from;
		if (until !== undefined) out.until = until;
		if (eventTime !== undefined) out.eventTime = eventTime;
		if (eventTimeEnd !== undefined) out.eventTimeEnd = eventTimeEnd;
		if (fromCompletion) out.fromCompletion = true;
		return out;
	};

	switch (kind) {
		case "daily":
			if (onWeekdays !== null || onMonthDay !== null || onDate !== null) {
				return { error: "daily rules do not take an 'on' clause" };
			}
			return withTail({ freq: "daily", n });
		case "weekdays":
			if (hasN) return { error: "'every weekday' does not take an interval" };
			if (onWeekdays !== null || onMonthDay !== null || onDate !== null) {
				return { error: "'every weekday' does not take an 'on' clause" };
			}
			return withTail({ freq: "weekdays" });
		case "weekday-name":
			// byDay-единица (every! friday) несовместима с «от выполнения»: нет
			// фиксированного дня, от которого считать (§every!).
			if (fromCompletion) {
				return {
					error: `'every! ${unitTok}' is ambiguous — from-completion has no fixed weekday; use 'every! week' or 'every! N weeks'`,
				};
			}
			if (onWeekdays !== null || onMonthDay !== null || onDate !== null) {
				return { error: `'every ${unitTok}' does not take an 'on' clause` };
			}
			return withTail({ freq: "weekly", n, byDay: [unitWeekday] });
		case "weekly":
			if (onMonthDay !== null || onDate !== null) {
				return { error: "weekly rules take only 'on <weekday, ...>'" };
			}
			// «every! week on tue» бессмысленно (от выполнения нет фиксированного дня)
			if (fromCompletion && onWeekdays !== null) {
				return {
					error: "'every! week on <weekday>' is contradictory — from-completion has no fixed weekday; drop the 'on' clause",
				};
			}
			return withTail({ freq: "weekly", n, byDay: onWeekdays ?? [] });
		case "monthly":
			if (onWeekdays !== null || onDate !== null) {
				return { error: "monthly rules take only 'on the <day>' / 'on the last day'" };
			}
			// «от выполнения»: день считается от даты ✅ — клауза дня не нужна и
			// запрещена; календарный monthly же требует день (Rule без day не развернуть)
			if (fromCompletion) {
				if (onMonthDay !== null) {
					return {
						error: "'every! month on the <day>' is contradictory — from-completion counts the day from the completion date; drop the 'on' clause",
					};
				}
				return withTail({ freq: "monthly", n });
			}
			if (onMonthDay === null) {
				return { error: "monthly rule requires 'on the <day>' or 'on the last day'" };
			}
			return withTail({ freq: "monthly", n, day: onMonthDay });
		case "yearly":
			if (onWeekdays !== null || onMonthDay !== null) {
				return { error: "yearly rules take only 'on <month-name> <day>'" };
			}
			// «от выполнения»: месяц/день от даты ✅ — клауза даты не нужна и запрещена
			if (fromCompletion) {
				if (onDate !== null) {
					return {
						error: "'every! year on <month> <day>' is contradictory — from-completion counts the date from the completion date; drop the 'on' clause",
					};
				}
				return withTail({ freq: "yearly", n });
			}
			if (onDate === null) return { error: "yearly rule requires 'on <month-name> <day>'" };
			return withTail({ freq: "yearly", n, month: onDate.month, day: onDate.day });
	}
}
