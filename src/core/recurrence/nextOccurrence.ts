/**
 * Вычислитель повторов (ТЗ §6): чистая {y,m,d}-математика, без Date.
 *
 * Семантика:
 * - nextOccurrence(rule, after) — минимальная дата вхождения СТРОГО ПОСЛЕ after.
 * - until ВКЛЮЧИТЕЛЬНО: вхождение, попадающее ровно на until, порождается;
 *   всё, что позже, — null.
 * - КЛАМПИНГ: «on the 31st» → Jan 31, Feb 28/29, Mar 31… (не пропуск, как в RFC 5545).
 * - Месячный/годовой шаг привязан к дню ПРАВИЛА, а не к дню after:
 *   «every month on the 15th» после 2026-07-20 → 2026-08-15.
 * - daily и weekly-без-byDay не имеют абсолютного якоря: цепочку задаёт курсор 🔜
 *   (следующее — просто after + шаг). Для weekly с byDay при n>1 чётность недель
 *   привязана к ЦЕПОЧКЕ КУРСОРОВ, а не к неделе произвольного after: n-недельный
 *   шаг действует только от after-члена правила (курсоры — всегда члены);
 *   от не-члена (bootstrap after=today−1, снап) — ближайший перечисленный день
 *   следующей недели (понедельник — начало недели).
 */
import type { IsoDate } from "../model/Task";
import type { Rule } from "./grammar";
import {
	addDays,
	clampDay,
	compare,
	dayOfWeek,
	daysInMonth,
	fromParts,
	toParts,
} from "./dateMath";

/** Жёсткий предел итераций для любых сканирующих циклов повторов. */
export const MAX_ITERATIONS = 1000;

function capUntil(cand: IsoDate, until: IsoDate | undefined): IsoDate | null {
	if (until !== undefined && compare(cand, until) > 0) return null;
	return cand;
}

export function nextOccurrence(rule: Rule, after: IsoDate): IsoDate | null {
	switch (rule.freq) {
		case "daily":
			return capUntil(addDays(after, rule.n), rule.until);

		case "weekdays": {
			let d = addDays(after, 1);
			for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
				if (dayOfWeek(d) <= 4) return capUntil(d, rule.until);
				d = addDays(d, 1);
			}
			return null;
		}

		case "weekly": {
			if (rule.byDay.length === 0) {
				return capUntil(addDays(after, 7 * rule.n), rule.until);
			}
			const days = [...rule.byDay].sort((a, b) => a - b);
			const dow = dayOfWeek(after);
			const weekStart = addDays(after, -dow); // понедельник недели after
			for (const wd of days) {
				if (wd > dow) return capUntil(addDays(weekStart, wd), rule.until);
			}
			const first = days[0];
			if (first === undefined) return null; // недостижимо: length > 0
			// n-недельный шаг только от члена правила: воскресный after (bootstrap
			// today−1) принадлежит ПРЕДЫДУЩЕЙ неделе, и шаг 7*n перепрыгнул бы
			// сегодняшнее вхождение, сдвинув всю цепочку на неделю
			const stride = days.includes(dow) ? 7 * rule.n : 7;
			return capUntil(addDays(weekStart, stride + first), rule.until);
		}

		case "monthly": {
			const p = toParts(after);
			let y = p.y;
			let m = p.m;
			for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
				const dom = rule.day === "last" ? daysInMonth(y, m) : clampDay(y, m, rule.day);
				const cand = fromParts({ y, m, d: dom });
				if (compare(cand, after) > 0) return capUntil(cand, rule.until);
				m += rule.n;
				y += Math.floor((m - 1) / 12);
				m = ((m - 1) % 12) + 1;
			}
			return null;
		}

		case "yearly": {
			let y = toParts(after).y;
			for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
				// 29 февраля на невисокосном году клампится к 28-му
				const cand = fromParts({ y, m: rule.month, d: clampDay(y, rule.month, rule.day) });
				if (compare(cand, after) > 0) return capUntil(cand, rule.until);
				y += rule.n;
			}
			return null;
		}
	}
}

/**
 * Тест членства даты в правиле — валидация курсора 🔜 (ТЗ §6).
 * Для правил без абсолютного якоря (daily, weekly без byDay) любая дата — член;
 * для weekly с n>1 чётность недель не проверяется (якоря нет). Проверяется
 * только структурная совместимость: день недели / день месяца / месяц+день, until.
 */
export function isOccurrence(rule: Rule, date: IsoDate): boolean {
	if (rule.until !== undefined && compare(date, rule.until) > 0) return false;
	switch (rule.freq) {
		case "daily":
			return true;
		case "weekdays":
			return dayOfWeek(date) <= 4;
		case "weekly":
			return rule.byDay.length === 0 || rule.byDay.includes(dayOfWeek(date));
		case "monthly": {
			const p = toParts(date);
			const dom = rule.day === "last" ? daysInMonth(p.y, p.m) : clampDay(p.y, p.m, rule.day);
			return p.d === dom;
		}
		case "yearly": {
			const p = toParts(date);
			return p.m === rule.month && p.d === clampDay(p.y, rule.month, rule.day);
		}
	}
}
