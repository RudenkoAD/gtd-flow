/**
 * Вычислитель повторов (ТЗ §6): чистая {y,m,d}-математика, без Date.
 *
 * Семантика:
 * - nextOccurrence(rule, after) — минимальная дата вхождения СТРОГО ПОСЛЕ after.
 * - until ВКЛЮЧИТЕЛЬНО: вхождение, попадающее ровно на until, порождается;
 *   всё, что позже, — null.
 * - from ВКЛЮЧИТЕЛЬНО: нижняя граница серии — вхождений раньше from не бывает;
 *   курсор поиска клампится до from−1 (see below), until-семантика не меняется.
 * - КЛАМПИНГ: «on the 31st» → Jan 31, Feb 28/29, Mar 31… (не пропуск, как в RFC 5545).
 * - Месячный/годовой шаг привязан к дню ПРАВИЛА, а не к дню after:
 *   «every month on the 15th» после 2026-07-20 → 2026-08-15.
 * - daily и weekly-без-byDay при n=1 (или без якоря) не имеют абсолютного якоря:
 *   цепочку задаёт курсор 🔜 (следующее — просто after + шаг). При n>1 и
 *   известном якоре (rule.from либо anchor-аргумент) серия — арифметическая:
 *   якорь, якорь+n, якорь+2n… (для weekly шаг 7n); ПЕРВОЕ вхождение — сам якорь
 *   (from ВКЛЮЧИТЕЛЬНО и как граница, и как фаза), а не якорь+шаг.
 * - weekly с byDay при n>1: чётность недель детерминирует ЯКОРЬ (anchor) —
 *   rule.from либо базовая дата серии события. При известном якоре членами
 *   считаются перечисленные дни ТОЛЬКО в неделях, отстоящих от недели якоря
 *   (недели от понедельника) на кратное n. ФАЗА ОТ ПЕРВОГО ВХОЖДЕНИЯ: неделя
 *   якоря берётся как неделя ПЕРВОГО перечисленного (byDay) дня ≥ якоря, а не
 *   как неделя самой даты якоря (см. snapWeekAnchor) — иначе, когда якорь не на
 *   дне byDay, первый член серии выпадал бы из фазы и пропускался. Якоря нет
 *   (anchor === undefined) — прежняя семантика ЦЕПОЧКИ КУРСОРОВ: n-недельный шаг
 *   действует лишь от after-члена (курсоры — всегда члены); от не-члена (bootstrap
 *   after=today−1, снап) — ближайший перечисленный день следующей недели.
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
	fromEpochDays,
	toEpochDays,
	toParts,
	weeksBetween,
} from "./dateMath";

/** Жёсткий предел итераций для любых сканирующих циклов повторов. */
export const MAX_ITERATIONS = 1000;

/**
 * Нормализация якоря чётности недель к «фазе от первого вхождения» (ТЗ §6).
 *
 * Чётность недель weekly-правил с n>1 отсчитывается от недели ПЕРВОГО
 * перечисленного (byDay) дня ≥ якоря, а НЕ от недели самой даты якоря. Когда
 * якорь (from / базовая дата серии) не попадает на день из byDay, ближайшее
 * вхождение лежит уже в следующей неделе — именно она задаёт фазу; иначе первый
 * член серии выпадал бы из фазы и пропускался (`every 2 weeks on tue from <среда>`
 * без снапа дал бы вторник ЧЕРЕЗ неделю вместо ближайшего).
 *
 * Снап дешёвый, без циклов по датам: день недели якоря и byDay известны — чистая
 * арифметика недели. Идемпотентен: якорь уже на дне byDay → возвращается он сам
 * (снап внутри той же недели её понедельник — а с ним и фазу — не меняет). days
 * предполагается непустым и отсортированным по возрастанию (гарантия грамматики).
 */
export function snapWeekAnchor(anchor: IsoDate, days: readonly number[]): IsoDate {
	const first = days[0];
	if (first === undefined) return anchor; // недостижимо на byDay-правилах
	const dow = dayOfWeek(anchor);
	const weekStart = addDays(anchor, -dow); // понедельник недели якоря
	for (const wd of days) {
		if (wd >= dow) return addDays(weekStart, wd); // первый перечисленный день ≥ dow — здесь же
	}
	// перечисленных дней ≥ dow в неделе якоря нет — первый день СЛЕДУЮЩЕЙ недели
	return addDays(weekStart, 7 + first);
}

function capUntil(cand: IsoDate, until: IsoDate | undefined): IsoDate | null {
	if (until !== undefined && compare(cand, until) > 0) return null;
	return cand;
}

/** Положительный остаток: ((a % b) + b) % b — фазовые проверки не зависят от знака. */
function posMod(a: number, b: number): number {
	return ((a % b) + b) % b;
}

/**
 * Следующий член арифметической серии anchor + k*step (в днях эпохи) СТРОГО
 * ПОСЛЕ after. Основа фазовой семантики daily/weekly-без-byDay при n>1 и
 * известном якоре (rule.from либо anchor-аргумент): первый член — сам якорь,
 * дальше шаг ровно step дней; фаза детерминирована и не зависит от after.
 */
function nextInPhase(anchorDate: IsoDate, step: number, after: IsoDate): IsoDate {
	const anc = toEpochDays(anchorDate);
	const delta = toEpochDays(after) - anc;
	return fromEpochDays(anc + (Math.floor(delta / step) + 1) * step);
}

export function nextOccurrence(rule: Rule, after: IsoDate, anchor?: IsoDate): IsoDate | null {
	// клауза from (нижняя граница, §6): вхождений раньше from не бывает. Поднимаем
	// курсор поиска до from−1 — «строго после» тогда впервые попадёт на дату ≥ from.
	// until-семантику (верхняя граница) это не трогает — её держит capUntil.
	if (rule.from !== undefined && compare(after, addDays(rule.from, -1)) < 0) {
		after = addDays(rule.from, -1);
	}
	switch (rule.freq) {
		case "daily": {
			// фаза от якоря (rule.from приоритетнее anchor-аргумента): при n>1 члены —
			// anchor + k*n, первый — сам якорь (from ВКЛЮЧИТЕЛЬНО, а не from+n).
			// n=1 якоря не требует: любой день — член, шаг от курсора идентичен фазовому.
			const dailyAnchor = rule.from ?? anchor;
			if (dailyAnchor !== undefined && rule.n > 1) {
				return capUntil(nextInPhase(dailyAnchor, rule.n, after), rule.until);
			}
			return capUntil(addDays(after, rule.n), rule.until);
		}

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
				// как daily: при n>1 и якоре фаза anchor + k*7n, первый член — сам якорь
				const weeklyAnchor = rule.from ?? anchor;
				if (weeklyAnchor !== undefined && rule.n > 1) {
					return capUntil(nextInPhase(weeklyAnchor, 7 * rule.n, after), rule.until);
				}
				return capUntil(addDays(after, 7 * rule.n), rule.until);
			}
			const days = [...rule.byDay].sort((a, b) => a - b);
			const dow = dayOfWeek(after);
			const weekStart = addDays(after, -dow); // понедельник недели after
			const first = days[0];
			if (first === undefined) return null; // недостижимо: length > 0

			// Якорь (rule.from либо базовая дата серии) закрепляет чётность недель:
			// при n>1 члены — перечисленные дни лишь в неделях, кратно n отстоящих
			// от недели якоря. Фазовая неделя — неделя первого вхождения (snapWeekAnchor),
			// не самой даты якоря. off — смещение недели after от фазовой по модулю n.
			if (anchor !== undefined && rule.n > 1) {
				const eff = snapWeekAnchor(anchor, days);
				const off = ((weeksBetween(after, eff) % rule.n) + rule.n) % rule.n;
				if (off === 0) {
					// неделя «в фазе»: ближайший перечисленный день строго позже after —
					// здесь же; исчерпаны — прыжок ровно на n недель вперёд
					for (const wd of days) {
						if (wd > dow) return capUntil(addDays(weekStart, wd), rule.until);
					}
					return capUntil(addDays(weekStart, 7 * rule.n + first), rule.until);
				}
				// неделя не в фазе: до следующей фазовой (n − off) недель, первый день
				return capUntil(addDays(weekStart, 7 * (rule.n - off) + first), rule.until);
			}

			// без якоря — семантика цепочки курсоров (прежнее поведение):
			// n-недельный шаг только от члена правила; воскресный after (bootstrap
			// today−1) принадлежит ПРЕДЫДУЩЕЙ неделе — шаг 7*n перепрыгнул бы
			// ближайшее вхождение, сдвинув всю цепочку на неделю
			for (const wd of days) {
				if (wd > dow) return capUntil(addDays(weekStart, wd), rule.until);
			}
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
 * Для правил без абсолютного якоря (daily, weekly без byDay) любая дата — член.
 * Для weekly с byDay и n>1 чётность недель проверяется ТОЛЬКО при известном
 * якоре (anchor: rule.from либо базовая дата серии): дата — член, если её неделя
 * отстоит от недели якоря на кратное n. Фаза считается от недели первого
 * вхождения (snapWeekAnchor), как и в nextOccurrence, — единая нормализация в
 * обоих местах держит isOccurrence консистентным с nextOccurrence. Без якоря
 * (anchor === undefined) — лишь структурная совместимость (день недели).
 */
export function isOccurrence(rule: Rule, date: IsoDate, anchor?: IsoDate): boolean {
	if (rule.from !== undefined && compare(date, rule.from) < 0) return false;
	if (rule.until !== undefined && compare(date, rule.until) > 0) return false;
	switch (rule.freq) {
		case "daily": {
			// фазовая проверка ТОЛЬКО при известном якоре и n>1 — зеркало nextOccurrence:
			// член ⇔ (date − якорь) кратно n. Без якоря — прежняя структурная
			// совместимость (любая дата), как у weekly с byDay: двухступенчатая
			// проверка spawnPlan (структура → фаза) различает ветки снапа.
			if (anchor === undefined || rule.n <= 1) return true;
			return posMod(toEpochDays(date) - toEpochDays(anchor), rule.n) === 0;
		}
		case "weekdays":
			return dayOfWeek(date) <= 4;
		case "weekly":
			if (rule.byDay.length === 0) {
				// как daily: при якоре и n>1 член ⇔ (date − якорь) кратно 7n
				if (anchor === undefined || rule.n <= 1) return true;
				return posMod(toEpochDays(date) - toEpochDays(anchor), 7 * rule.n) === 0;
			}
			if (!rule.byDay.includes(dayOfWeek(date))) return false;
			// чётность недель — только при известном якоре и n>1; фаза от первого вхождения
			if (anchor === undefined || rule.n <= 1) return true;
			return weeksBetween(date, snapWeekAnchor(anchor, rule.byDay)) % rule.n === 0;
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
