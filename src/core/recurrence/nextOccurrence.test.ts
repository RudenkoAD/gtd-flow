import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clampDay, compare, fromParts } from "./dateMath";
import type { Rule } from "./grammar";
import { isOccurrence, nextOccurrence } from "./nextOccurrence";

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
			nextOccurrence({ freq: "daily", n: 1, eventTime: "09:00", eventTimeEnd: "10:00" }, "2026-07-15"),
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
		expect(nextOccurrence({ freq: "weekly", n: 1, byDay: [] }, "2026-07-15")).toBe("2026-07-22");
		expect(nextOccurrence({ freq: "weekly", n: 2, byDay: [] }, "2026-07-15")).toBe("2026-07-29");
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
		.map(
			([n, month, day]): Rule => ({
				freq: "yearly",
				n,
				month,
				day: Math.min(day, YEARLY_MAX[month - 1] ?? 28),
			}),
		),
);

const arbRule: fc.Arbitrary<Rule> = fc
	.tuple(arbRuleBase, fc.option(arbDate, { nil: undefined }))
	.map(([r, until]) => (until === undefined ? r : { ...r, until }));

describe("nextOccurrence ⊨ isOccurrence (property)", () => {
	it("every non-null result is a member of the rule and strictly after 'after'", () => {
		fc.assert(
			fc.property(arbRule, arbDate, (rule, after) => {
				const next = nextOccurrence(rule, after);
				if (next === null) return; // until исчерпан — легально
				expect(compare(next, after)).toBe(1);
				expect(isOccurrence(rule, next)).toBe(true);
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
