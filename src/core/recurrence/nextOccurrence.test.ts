import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clampDay, compare, fromParts, weeksBetween } from "./dateMath";
import type { Rule } from "./grammar";
import { isOccurrence, nextFromCompletion, nextOccurrence, snapWeekAnchor } from "./nextOccurrence";

// Календарные ориентиры 2026: 07-13 понедельник, 07-15 среда, 07-17 пятница,
// 12-31 четверг. 2027 — невисокосный, 2028 — високосный.

describe("nextOccurrence — daily", () => {
	it("steps by n from the cursor", () => {
		expect(nextOccurrence({ freq: "daily", n: 1 }, "2026-07-15")).toBe("2026-07-16");
		expect(nextOccurrence({ freq: "daily", n: 3 }, "2026-07-15")).toBe("2026-07-18");
		expect(nextOccurrence({ freq: "daily", n: 1 }, "2026-12-31")).toBe("2027-01-01");
	});
});

describe("nextOccurrence — eventTime игнорируется (date-уровень, §события)", () => {
	it("время вхождения не влияет на выбор даты", () => {
		expect(
			nextOccurrence(
				{ freq: "daily", n: 1, eventTime: "09:00", eventTimeEnd: "10:00" },
				"2026-07-15",
			),
		).toBe("2026-07-16");
		const r: Rule = { freq: "weekly", n: 1, byDay: [4], eventTime: "19:00" };
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-17"); // как без времени
		expect(isOccurrence(r, "2026-07-17")).toBe(true);
	});
});

describe("nextOccurrence — weekdays", () => {
	it("skips weekends", () => {
		expect(nextOccurrence({ freq: "weekdays" }, "2026-07-15")).toBe("2026-07-16"); // ср → чт
		expect(nextOccurrence({ freq: "weekdays" }, "2026-07-16")).toBe("2026-07-17"); // чт → пт
		expect(nextOccurrence({ freq: "weekdays" }, "2026-07-17")).toBe("2026-07-20"); // пт → пн
		expect(nextOccurrence({ freq: "weekdays" }, "2026-07-18")).toBe("2026-07-20"); // сб → пн
		expect(nextOccurrence({ freq: "weekdays" }, "2026-07-19")).toBe("2026-07-20"); // вс → пн
	});
});

describe("nextOccurrence — weekly", () => {
	it("finds the next listed weekday within the week", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [4] }; // friday
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-17");
		expect(nextOccurrence(r, "2026-07-17")).toBe("2026-07-24");
	});
	it("crosses the week boundary with stride n", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [0, 3] }; // mon, thu
		expect(nextOccurrence(r, "2026-07-13")).toBe("2026-07-16"); // пн → чт той же недели
		expect(nextOccurrence(r, "2026-07-16")).toBe("2026-07-27"); // чт → пн через 2 недели
	});
	it("crosses the year boundary", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [0, 3] };
		expect(nextOccurrence(r, "2026-12-31")).toBe("2027-01-04"); // чт → пн следующего года
	});
	it("with empty byDay steps 7*n days from the cursor", () => {
		expect(nextOccurrence({ freq: "weekly", n: 1, byDay: [] }, "2026-07-15")).toBe(
			"2026-07-22",
		);
		expect(nextOccurrence({ freq: "weekly", n: 2, byDay: [] }, "2026-07-15")).toBe(
			"2026-07-29",
		);
	});
	it("n>1 from a non-member 'after' does not skip the nearest listed day (regression)", () => {
		// after = вс 2026-07-12 (bootstrap today−1) принадлежит ПРЕДЫДУЩЕЙ неделе:
		// шаг 7*n от неё перепрыгивал бы пн 2026-07-13 на неделю вперёд
		const r: Rule = { freq: "weekly", n: 2, byDay: [0] }; // every 2 weeks on monday
		expect(nextOccurrence(r, "2026-07-12")).toBe("2026-07-13");
		// от члена правила шаг остаётся n-недельным (чётность задаёт цепочка курсоров)
		expect(nextOccurrence(r, "2026-07-13")).toBe("2026-07-27");
		// не-член внутри недели после последнего перечисленного дня → ближайший
		// перечисленный день СЛЕДУЮЩЕЙ недели, не через n недель
		const r2: Rule = { freq: "weekly", n: 2, byDay: [0, 3] }; // mon, thu
		expect(nextOccurrence(r2, "2026-07-17")).toBe("2026-07-20"); // пт → пн следующей недели
	});
});

describe("nextOccurrence — weekly n>1 с якорем (чётность недель)", () => {
	// Ориентиры 2026: 07-13 пн, 07-14 вт, 07-17 пт, 07-21 вт, 07-28 вт, 08-11 вт.
	it("'every 2 weeks on tue from 2026-07-14': только чётные (от from) недели", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-14" };
		expect(nextOccurrence(r, "2026-07-13", r.from)).toBe("2026-07-14"); // первое = сам from
		expect(nextOccurrence(r, "2026-07-14", r.from)).toBe("2026-07-28"); // +2 недели
		expect(nextOccurrence(r, "2026-07-28", r.from)).toBe("2026-08-11");
		// НЕ даёт 2026-07-21: неделя не в фазе
		expect(nextOccurrence(r, "2026-07-15", r.from)).toBe("2026-07-28");
	});
	it("снап от не-члена «не той» недели уходит на ближайшую фазовую (не +1 неделя)", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-14" };
		// bootstrap after=today−1=07-19 (вс нечётной недели) → 07-28, НЕ 07-21
		expect(nextOccurrence(r, "2026-07-19", r.from)).toBe("2026-07-28");
		// пн 07-20 нечётной недели → 07-28
		expect(nextOccurrence(r, "2026-07-20", r.from)).toBe("2026-07-28");
		// сам вторник 07-21 нечётной недели (был бы «членом» без якоря) → 07-28
		expect(nextOccurrence(r, "2026-07-21", r.from)).toBe("2026-07-28");
	});
	it("несколько дней в неделю: tue,fri сохраняют фазу", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1, 4], from: "2026-07-14" };
		expect(nextOccurrence(r, "2026-07-14", r.from)).toBe("2026-07-17"); // вт → пт той же недели
		expect(nextOccurrence(r, "2026-07-17", r.from)).toBe("2026-07-28"); // пт → вт через 2 недели
		expect(nextOccurrence(r, "2026-07-28", r.from)).toBe("2026-07-31"); // вт → пт
		// пт 07-24 нечётной недели → вт 07-28 (следующая фазовая)
		expect(nextOccurrence(r, "2026-07-24", r.from)).toBe("2026-07-28");
	});
	it("переход через границу года", () => {
		// 2026-12-31 — четверг (dow=3)
		const r: Rule = { freq: "weekly", n: 2, byDay: [3], from: "2026-12-31" };
		expect(nextOccurrence(r, "2026-12-31", r.from)).toBe("2027-01-14"); // +2 недели
		expect(nextOccurrence(r, "2027-01-01", r.from)).toBe("2027-01-14"); // НЕ 2027-01-07
	});
	it("every 3 weeks: шаг ровно 3 недели от якоря", () => {
		const r: Rule = { freq: "weekly", n: 3, byDay: [0], from: "2026-07-13" }; // пн
		expect(nextOccurrence(r, "2026-07-13", r.from)).toBe("2026-08-03"); // +3 недели
		expect(nextOccurrence(r, "2026-08-03", r.from)).toBe("2026-08-24");
		expect(nextOccurrence(r, "2026-07-20", r.from)).toBe("2026-08-03"); // НЕ 07-20/07-27
		expect(nextOccurrence(r, "2026-07-27", r.from)).toBe("2026-08-03");
	});
	it("from+until вместе: серия ограничена с обеих сторон, фаза сохранена", () => {
		const r: Rule = {
			freq: "weekly",
			n: 2,
			byDay: [1],
			from: "2026-07-14",
			until: "2026-07-28",
		};
		expect(nextOccurrence(r, "2026-07-13", r.from)).toBe("2026-07-14");
		expect(nextOccurrence(r, "2026-07-14", r.from)).toBe("2026-07-28"); // ровно until
		expect(nextOccurrence(r, "2026-07-28", r.from)).toBeNull(); // за until
	});
	it("обратная совместимость: n=1 — все перечисленные дни (якорь ничего не режет)", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [1], from: "2026-07-14" };
		expect(nextOccurrence(r, "2026-07-14", r.from)).toBe("2026-07-21");
		expect(nextOccurrence(r, "2026-07-21", r.from)).toBe("2026-07-28");
	});
	it("weekly без byDay с якорем: фаза от from — шаг кратен 7*n от якоря (фикс границы from)", () => {
		// раньше шаг шёл от after (07-15 → 07-29 вне фазы серии 07-14, 07-28…);
		// теперь фаза детерминирована якорем: ближайший член после 07-15 — 07-28
		const r: Rule = { freq: "weekly", n: 2, byDay: [], from: "2026-07-14" };
		expect(nextOccurrence(r, "2026-07-15", r.from)).toBe("2026-07-28");
	});
	it("без якоря (anchor undefined) — прежняя семантика цепочки курсоров", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1] };
		// от члена — шаг 2 недели; от не-члена — ближайший вторник следующей недели
		expect(nextOccurrence(r, "2026-07-14")).toBe("2026-07-28");
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-21");
	});
});

describe("nextOccurrence — фаза от ПЕРВОГО вхождения (якорь не на дне byDay)", () => {
	// Ориентиры 2026: 07-13 пн, 07-14 вт, 07-15 ср, 07-16 чт, 07-17 пт, 07-21 вт.
	it("'every 2 weeks on tue from 2026-07-15' (среда): 07-21, 08-04, 08-18 — НЕ 07-28", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-15" };
		// первое вхождение = ближайший вторник ≥ from (07-21), НЕ вторник недели from (07-14)
		expect(nextOccurrence(r, "2026-07-14", r.from)).toBe("2026-07-21");
		expect(nextOccurrence(r, "2026-07-21", r.from)).toBe("2026-08-04"); // +2 недели, НЕ 07-28
		expect(nextOccurrence(r, "2026-08-04", r.from)).toBe("2026-08-18");
	});
	it("from на самом дне byDay (07-14, вторник): прежняя фаза не сломана", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-14" };
		expect(nextOccurrence(r, "2026-07-13", r.from)).toBe("2026-07-14"); // первое = сам from
		expect(nextOccurrence(r, "2026-07-14", r.from)).toBe("2026-07-28");
	});
	it("несколько дней, from между ними: 'tue,fri from 2026-07-16' (чт) → 07-17, 07-28, 07-31", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1, 4], from: "2026-07-16" };
		// фазовая неделя = неделя первого вхождения (пт 07-17); вт 07-14 < from и вне серии
		expect(nextOccurrence(r, "2026-07-16", r.from)).toBe("2026-07-17");
		expect(nextOccurrence(r, "2026-07-17", r.from)).toBe("2026-07-28"); // след. фазовая неделя, вт
		expect(nextOccurrence(r, "2026-07-28", r.from)).toBe("2026-07-31"); // пт той же недели
	});
});

describe("isOccurrence — weekly n>1 чётность недель при якоре", () => {
	it("с якорем режет «не ту» неделю, без якоря — любой перечисленный день", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-14" };
		expect(isOccurrence(r, "2026-07-14", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-07-21", r.from)).toBe(false); // не та неделя
		expect(isOccurrence(r, "2026-07-28", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-08-11", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-07-15", r.from)).toBe(false); // не вторник
		// без якоря — прежнее поведение (любой вторник — член)
		expect(isOccurrence(r, "2026-07-21")).toBe(true);
	});
	it("n=1 с якорем: все перечисленные дни — члены", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [1], from: "2026-07-14" };
		expect(isOccurrence(r, "2026-07-14", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-07-21", r.from)).toBe(true);
	});
	it("фаза от первого вхождения: from не на дне byDay — консистентно с nextOccurrence", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-15" }; // среда
		expect(isOccurrence(r, "2026-07-21", r.from)).toBe(true); // первое вхождение (фазовая неделя)
		expect(isOccurrence(r, "2026-07-28", r.from)).toBe(false); // соседняя неделя — вне фазы
		expect(isOccurrence(r, "2026-08-04", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-08-18", r.from)).toBe(true);
	});
});

describe("nextOccurrence — monthly clamping", () => {
	it("clamps the 31st across short months (incl. leap February 2028)", () => {
		const r: Rule = { freq: "monthly", n: 1, day: 31 };
		expect(nextOccurrence(r, "2026-01-31")).toBe("2026-02-28");
		expect(nextOccurrence(r, "2026-02-28")).toBe("2026-03-31");
		expect(nextOccurrence(r, "2026-03-31")).toBe("2026-04-30");
		expect(nextOccurrence(r, "2028-01-31")).toBe("2028-02-29"); // високосный
		expect(nextOccurrence(r, "2028-02-29")).toBe("2028-03-31");
	});
	it("clamps the 30th across February", () => {
		const r: Rule = { freq: "monthly", n: 1, day: 30 };
		expect(nextOccurrence(r, "2027-01-30")).toBe("2027-02-28");
		expect(nextOccurrence(r, "2027-02-28")).toBe("2027-03-30");
	});
	it("handles 'last day'", () => {
		const r: Rule = { freq: "monthly", n: 1, day: "last" };
		expect(nextOccurrence(r, "2026-01-31")).toBe("2026-02-28");
		expect(nextOccurrence(r, "2026-02-15")).toBe("2026-02-28");
		expect(nextOccurrence(r, "2026-07-31")).toBe("2026-08-31");
		expect(nextOccurrence(r, "2028-01-31")).toBe("2028-02-29");
	});
	it("anchors the day to the rule, not to 'after'", () => {
		const r: Rule = { freq: "monthly", n: 1, day: 15 };
		expect(nextOccurrence(r, "2026-07-20")).toBe("2026-08-15"); // не 08-20
		expect(nextOccurrence(r, "2026-07-10")).toBe("2026-07-15");
	});
	it("strides n>1 months from the month of 'after'", () => {
		const r: Rule = { freq: "monthly", n: 3, day: 1 };
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-10-01"); // не 08-01
		expect(nextOccurrence(r, "2026-10-01")).toBe("2027-01-01"); // через границу года
		const r2: Rule = { freq: "monthly", n: 2, day: 15 };
		expect(nextOccurrence(r2, "2026-07-20")).toBe("2026-09-15");
	});
});

describe("nextOccurrence — yearly", () => {
	it("steps years and crosses the boundary", () => {
		const r: Rule = { freq: "yearly", n: 1, month: 4, day: 1 };
		expect(nextOccurrence(r, "2026-03-31")).toBe("2026-04-01");
		expect(nextOccurrence(r, "2026-04-01")).toBe("2027-04-01");
	});
	it("clamps Feb 29 to Feb 28 on non-leap years", () => {
		const r: Rule = { freq: "yearly", n: 1, month: 2, day: 29 };
		expect(nextOccurrence(r, "2027-01-01")).toBe("2027-02-28"); // 2027 невисокосный
		expect(nextOccurrence(r, "2027-02-28")).toBe("2028-02-29"); // 2028 високосный
		expect(nextOccurrence(r, "2028-02-29")).toBe("2029-02-28");
	});
	it("strides n>1 years", () => {
		const r: Rule = { freq: "yearly", n: 2, month: 4, day: 1 };
		expect(nextOccurrence(r, "2026-04-01")).toBe("2028-04-01");
	});
});

describe("nextOccurrence — until (ВКЛЮЧИТЕЛЬНО)", () => {
	it("returns an occurrence landing exactly on until", () => {
		const r: Rule = { freq: "daily", n: 1, until: "2026-12-31" };
		expect(nextOccurrence(r, "2026-12-30")).toBe("2026-12-31");
	});
	it("returns null past until", () => {
		const r: Rule = { freq: "daily", n: 1, until: "2026-12-31" };
		expect(nextOccurrence(r, "2026-12-31")).toBeNull();
		const m: Rule = { freq: "monthly", n: 1, day: 15, until: "2026-08-15" };
		expect(nextOccurrence(m, "2026-07-15")).toBe("2026-08-15");
		expect(nextOccurrence(m, "2026-08-15")).toBeNull();
	});
});

describe("nextOccurrence — from (нижняя граница, ВКЛЮЧИТЕЛЬНО)", () => {
	it("daily: первое вхождение приходится ровно на from", () => {
		const r: Rule = { freq: "daily", n: 1, from: "2026-07-15" };
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15"); // курсор до from поднят
		expect(nextOccurrence(r, "2026-07-14")).toBe("2026-07-15"); // ровно from−1
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-16"); // от самого from — штатный шаг
	});
	it("weekly: пропускает перечисленные дни раньше from", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [2], from: "2026-07-15" }; // среды
		// среды 07-01, 07-08 до from не отдаются; первая — 07-15
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15");
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-22");
	});
	it("monthly: якорный день раньше from пропускается", () => {
		const r: Rule = { freq: "monthly", n: 1, day: 15, from: "2026-07-15" };
		expect(nextOccurrence(r, "2026-05-01")).toBe("2026-07-15"); // не 05-15 / 06-15
	});
	it("не влияет, когда after уже позже from", () => {
		const r: Rule = { freq: "daily", n: 1, from: "2026-01-01" };
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-16"); // клампа нет
	});
	it("сочетается с until с обеих сторон", () => {
		const r: Rule = { freq: "daily", n: 1, from: "2026-07-15", until: "2026-07-17" };
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15");
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-16");
		expect(nextOccurrence(r, "2026-07-16")).toBe("2026-07-17");
		expect(nextOccurrence(r, "2026-07-17")).toBeNull(); // за until
	});
	it("daily n>1: from — якорь фазы, первое вхождение — сам from", () => {
		// 'every 2 days from 2026-07-15': 07-15, 07-17, 07-19… (а не 07-16)
		const r: Rule = { freq: "daily", n: 2, from: "2026-07-15" };
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15"); // клампинг → сам from
		expect(nextOccurrence(r, "2026-07-14")).toBe("2026-07-15"); // ровно from−1
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-17"); // фазовый шаг
		expect(nextOccurrence(r, "2026-07-16")).toBe("2026-07-17"); // не-член → ближайший член
		expect(nextOccurrence(r, "2026-07-17")).toBe("2026-07-19");
	});
	it("daily n>1: from и until вместе, until ВКЛЮЧИТЕЛЬНО на члене фазы", () => {
		const r: Rule = { freq: "daily", n: 3, from: "2026-07-15", until: "2026-07-21" };
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15");
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-18");
		expect(nextOccurrence(r, "2026-07-18")).toBe("2026-07-21"); // ровно until
		expect(nextOccurrence(r, "2026-07-21")).toBeNull();
	});
	it("weekly без byDay, n>1: from — якорь фазы, первое вхождение — сам from", () => {
		// 'every 2 weeks from 2026-07-15': 07-15, 07-29, 08-12… (а не 07-29 первым)
		const r: Rule = { freq: "weekly", n: 2, byDay: [], from: "2026-07-15" };
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15");
		expect(nextOccurrence(r, "2026-07-15")).toBe("2026-07-29");
		expect(nextOccurrence(r, "2026-07-20")).toBe("2026-07-29"); // не-член → ближайший член
		expect(nextOccurrence(r, "2026-07-29")).toBe("2026-08-12");
	});
	it("weekly без byDay, n>1: from и until вместе", () => {
		const r: Rule = {
			freq: "weekly",
			n: 2,
			byDay: [],
			from: "2026-07-15",
			until: "2026-08-12",
		};
		expect(nextOccurrence(r, "2026-07-01")).toBe("2026-07-15");
		expect(nextOccurrence(r, "2026-07-29")).toBe("2026-08-12"); // ровно until
		expect(nextOccurrence(r, "2026-08-12")).toBeNull();
	});
	it("n=1 с from: поведение прежнее — шаг от курсора (байт-в-байт совместимость)", () => {
		const d: Rule = { freq: "daily", n: 1, from: "2026-07-15" };
		expect(nextOccurrence(d, "2026-07-15")).toBe("2026-07-16");
		const w: Rule = { freq: "weekly", n: 1, byDay: [], from: "2026-07-15" };
		expect(nextOccurrence(w, "2026-07-15")).toBe("2026-07-22");
	});
});

describe("isOccurrence — from", () => {
	it("отвергает даты раньше from, принимает from и позже", () => {
		const r: Rule = { freq: "daily", n: 1, from: "2026-07-15" };
		expect(isOccurrence(r, "2026-07-14")).toBe(false);
		expect(isOccurrence(r, "2026-07-15")).toBe(true);
		expect(isOccurrence(r, "2026-07-16")).toBe(true);
	});
	it("отвергает структурный член раньше from (weekly)", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [2], from: "2026-07-15" };
		expect(isOccurrence(r, "2026-07-08")).toBe(false); // среда до from
		expect(isOccurrence(r, "2026-07-15")).toBe(true);
		expect(isOccurrence(r, "2026-07-22")).toBe(true);
	});
});

describe("isOccurrence — фаза daily/weekly-без-byDay при n>1 и якоре", () => {
	it("daily n>1 с якорем: член ⇔ (date − якорь) кратно n", () => {
		const r: Rule = { freq: "daily", n: 2, from: "2026-07-15" };
		expect(isOccurrence(r, "2026-07-15", r.from)).toBe(true); // сам якорь
		expect(isOccurrence(r, "2026-07-16", r.from)).toBe(false); // не в фазе
		expect(isOccurrence(r, "2026-07-17", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-07-19", r.from)).toBe(true);
		// без якоря — прежняя структурная совместимость (любая дата ≥ from)
		expect(isOccurrence(r, "2026-07-16")).toBe(true);
	});
	it("weekly без byDay, n>1 с якорем: член ⇔ (date − якорь) кратно 7n", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [], from: "2026-07-15" };
		expect(isOccurrence(r, "2026-07-15", r.from)).toBe(true);
		expect(isOccurrence(r, "2026-07-22", r.from)).toBe(false); // +1 неделя — не в фазе
		expect(isOccurrence(r, "2026-07-29", r.from)).toBe(true); // +2 недели
		expect(isOccurrence(r, "2026-07-30", r.from)).toBe(false);
	});
	it("n=1: якорь фазу не режет (обратная совместимость)", () => {
		expect(isOccurrence({ freq: "daily", n: 1 }, "2026-07-16", "2026-07-15")).toBe(true);
		expect(isOccurrence({ freq: "weekly", n: 1, byDay: [] }, "2026-07-20", "2026-07-15")).toBe(
			true,
		);
	});
});

describe("isOccurrence", () => {
	it("matches clamped monthly days", () => {
		const r: Rule = { freq: "monthly", n: 1, day: 31 };
		expect(isOccurrence(r, "2026-01-31")).toBe(true);
		expect(isOccurrence(r, "2026-02-28")).toBe(true); // клампнутое вхождение
		expect(isOccurrence(r, "2026-02-27")).toBe(false);
		expect(isOccurrence(r, "2026-03-30")).toBe(false);
		expect(isOccurrence(r, "2028-02-29")).toBe(true);
		expect(isOccurrence(r, "2028-02-28")).toBe(false); // в високосном феврале кламп = 29
	});
	it("matches 'last day'", () => {
		const r: Rule = { freq: "monthly", n: 1, day: "last" };
		expect(isOccurrence(r, "2026-02-28")).toBe(true);
		expect(isOccurrence(r, "2026-04-30")).toBe(true);
		expect(isOccurrence(r, "2026-04-29")).toBe(false);
	});
	it("matches weekdays and weekly byDay", () => {
		expect(isOccurrence({ freq: "weekdays" }, "2026-07-17")).toBe(true); // пт
		expect(isOccurrence({ freq: "weekdays" }, "2026-07-18")).toBe(false); // сб
		const w: Rule = { freq: "weekly", n: 1, byDay: [0, 3] };
		expect(isOccurrence(w, "2026-07-13")).toBe(true); // пн
		expect(isOccurrence(w, "2026-07-15")).toBe(false); // ср
	});
	it("matches yearly with leap clamping", () => {
		const r: Rule = { freq: "yearly", n: 1, month: 2, day: 29 };
		expect(isOccurrence(r, "2027-02-28")).toBe(true);
		expect(isOccurrence(r, "2028-02-29")).toBe(true);
		expect(isOccurrence(r, "2028-02-28")).toBe(false);
		expect(isOccurrence(r, "2027-03-28")).toBe(false);
	});
	it("rejects dates past until", () => {
		const r: Rule = { freq: "daily", n: 1, until: "2026-12-31" };
		expect(isOccurrence(r, "2026-12-31")).toBe(true);
		expect(isOccurrence(r, "2027-01-01")).toBe(false);
	});
});

// --- property: результат nextOccurrence всегда член правила и строго позже after ---

const arbDate = fc
	.tuple(
		fc.integer({ min: 1990, max: 2100 }),
		fc.integer({ min: 1, max: 12 }),
		fc.integer({ min: 1, max: 31 }),
	)
	.map(([y, m, d]) => fromParts({ y, m, d: clampDay(y, m, d) }));

const arbByDay = fc
	.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 })
	.map((a) => [...a].sort((x, y) => x - y));

const YEARLY_MAX = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const arbRuleBase: fc.Arbitrary<Rule> = fc.oneof(
	fc.integer({ min: 1, max: 5 }).map((n): Rule => ({ freq: "daily", n })),
	fc.constant<Rule>({ freq: "weekdays" }),
	fc
		.tuple(fc.integer({ min: 1, max: 4 }), arbByDay)
		.map(([n, byDay]): Rule => ({ freq: "weekly", n, byDay })),
	fc.integer({ min: 1, max: 4 }).map((n): Rule => ({ freq: "weekly", n, byDay: [] })),
	fc
		.tuple(
			fc.integer({ min: 1, max: 6 }),
			fc.oneof(fc.integer({ min: 1, max: 31 }), fc.constant<"last">("last")),
		)
		.map(([n, day]): Rule => ({ freq: "monthly", n, day })),
	fc
		.tuple(
			fc.integer({ min: 1, max: 3 }),
			fc.integer({ min: 1, max: 12 }),
			fc.integer({ min: 1, max: 31 }),
		)
		.map(([n, month, day]): Rule => ({
			freq: "yearly",
			n,
			month,
			day: Math.min(day, YEARLY_MAX[month - 1] ?? 28),
		})),
);

const arbRule: fc.Arbitrary<Rule> = fc
	.tuple(
		arbRuleBase,
		fc.option(arbDate, { nil: undefined }),
		fc.option(arbDate, { nil: undefined }),
	)
	.map(([r, from, until]) => ({
		...r,
		...(from === undefined ? {} : { from }),
		...(until === undefined ? {} : { until }),
	}));

describe("nextOccurrence ⊨ isOccurrence (property)", () => {
	it("every non-null result is a member of the rule and strictly after 'after'", () => {
		fc.assert(
			fc.property(arbRule, arbDate, (rule, after) => {
				const next = nextOccurrence(rule, after);
				if (next === null) return; // until исчерпан — легально
				expect(compare(next, after)).toBe(1);
				expect(isOccurrence(rule, next)).toBe(true);
				if (rule.from !== undefined) {
					expect(compare(next, rule.from)).toBeGreaterThanOrEqual(0);
				}
				if (rule.until !== undefined) {
					expect(compare(next, rule.until)).toBeLessThanOrEqual(0);
				}
			}),
			{ numRuns: 500 },
		);
	});
	it("chains are strictly increasing members", () => {
		fc.assert(
			fc.property(arbRule, arbDate, (rule, start) => {
				let prev = start;
				for (let k = 0; k < 5; k++) {
					const next = nextOccurrence(rule, prev);
					if (next === null) return;
					expect(compare(next, prev)).toBe(1);
					expect(isOccurrence(rule, next)).toBe(true);
					prev = next;
				}
			}),
			{ numRuns: 300 },
		);
	});
});

// --- property: при якоре чётность недель weekly n>1 кратна n ---

const arbWeeklyAnchored = fc
	.tuple(
		fc.integer({ min: 2, max: 5 }), // n>1
		arbByDay,
		arbDate, // якорь (from)
	)
	.map(([n, byDay, from]): Extract<Rule, { freq: "weekly" }> => ({
		freq: "weekly",
		n,
		byDay,
		from,
	}));

describe("nextOccurrence — якорь ⇒ фаза недель кратна n (property)", () => {
	it("каждое вхождение лежит в неделе, кратно n отстоящей от недели якоря", () => {
		fc.assert(
			fc.property(arbWeeklyAnchored, arbDate, (rule, after) => {
				const from = rule.from!;
				let prev = after;
				for (let k = 0; k < 6; k++) {
					const next = nextOccurrence(rule, prev, from);
					if (next === null) return;
					// вхождение — член с учётом якоря
					expect(isOccurrence(rule, next, from)).toBe(true);
					// неделя вхождения кратно n отстоит от ФАЗОВОЙ недели (недели первого
					// вхождения, snapWeekAnchor), а не от недели самой даты якоря
					expect(weeksBetween(next, snapWeekAnchor(from, rule.byDay)) % rule.n).toBe(0);
					prev = next;
				}
			}),
			{ numRuns: 400 },
		);
	});

	it("расстояние между соседними вхождениями по неделям кратно n", () => {
		fc.assert(
			fc.property(arbWeeklyAnchored, arbDate, (rule, after) => {
				const from = rule.from!;
				let prev = nextOccurrence(rule, after, from);
				if (prev === null) return;
				for (let k = 0; k < 6; k++) {
					const next = nextOccurrence(rule, prev, from);
					if (next === null) return;
					expect(compare(next, prev)).toBe(1);
					// разница недель (соседи одной недели → 0, тоже кратно n)
					expect(weeksBetween(next, prev) % rule.n).toBe(0);
					prev = next;
				}
			}),
			{ numRuns: 400 },
		);
	});
});

describe("nextFromCompletion — интервал от даты выполнения (§every!)", () => {
	it("daily / weekly / weekdays: сдвиг в днях от даты ✅", () => {
		// 2026-07-15 — среда, 07-17 пятница, 07-18 суббота
		expect(
			nextFromCompletion({ freq: "daily", n: 3, fromCompletion: true }, "2026-07-15"),
		).toBe("2026-07-18");
		expect(
			nextFromCompletion(
				{ freq: "weekly", n: 2, byDay: [], fromCompletion: true },
				"2026-07-15",
			),
		).toBe("2026-07-29");
		// будний строго после: пятница → понедельник; суббота → понедельник
		expect(nextFromCompletion({ freq: "weekdays", fromCompletion: true }, "2026-07-17")).toBe(
			"2026-07-20",
		);
		expect(nextFromCompletion({ freq: "weekdays", fromCompletion: true }, "2026-07-18")).toBe(
			"2026-07-20",
		);
	});
	it("monthly: +n месяцев, день от даты ✅ с клампингом к длине месяца", () => {
		expect(
			nextFromCompletion({ freq: "monthly", n: 1, fromCompletion: true }, "2026-07-15"),
		).toBe("2026-08-15");
		// 31 января + 1 месяц → 28 февраля (клампинг)
		expect(
			nextFromCompletion({ freq: "monthly", n: 1, fromCompletion: true }, "2027-01-31"),
		).toBe("2027-02-28");
		// пересечение года
		expect(
			nextFromCompletion({ freq: "monthly", n: 3, fromCompletion: true }, "2026-11-30"),
		).toBe("2027-02-28");
	});
	it("yearly: +n лет, 29 февраля → 28 на невисокосном", () => {
		expect(
			nextFromCompletion({ freq: "yearly", n: 1, fromCompletion: true }, "2026-07-15"),
		).toBe("2027-07-15");
		expect(
			nextFromCompletion({ freq: "yearly", n: 1, fromCompletion: true }, "2028-02-29"),
		).toBe("2029-02-28");
	});
});

describe("fromCompletion-правила не разворачиваются по календарю (§every!)", () => {
	it("nextOccurrence возвращает null (сканирующие циклы не зацикливаются)", () => {
		expect(
			nextOccurrence({ freq: "daily", n: 3, fromCompletion: true }, "2026-07-15"),
		).toBeNull();
		expect(
			nextOccurrence({ freq: "monthly", n: 1, fromCompletion: true }, "2026-07-15"),
		).toBeNull();
	});
	it("isOccurrence считает любую дату членом (в пределах from/until)", () => {
		const rule: Rule = { freq: "daily", n: 3, fromCompletion: true };
		expect(isOccurrence(rule, "2026-07-15")).toBe(true);
		expect(isOccurrence(rule, "2026-07-16")).toBe(true);
		// from/until по-прежнему ограничивают
		const bounded: Rule = {
			freq: "daily",
			n: 3,
			fromCompletion: true,
			from: "2026-07-15",
			until: "2026-07-20",
		};
		expect(isOccurrence(bounded, "2026-07-14")).toBe(false);
		expect(isOccurrence(bounded, "2026-07-21")).toBe(false);
		expect(isOccurrence(bounded, "2026-07-17")).toBe(true);
	});
});
