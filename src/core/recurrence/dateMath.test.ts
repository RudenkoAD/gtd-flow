import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
	addDays,
	clampDay,
	compare,
	dayOfWeek,
	daysInMonth,
	fromEpochDays,
	fromParts,
	isLeap,
	isValidIsoDate,
	toEpochDays,
	toParts,
} from "./dateMath";

describe("isLeap", () => {
	it("handles the 4/100/400 rules", () => {
		expect(isLeap(2024)).toBe(true);
		expect(isLeap(2028)).toBe(true);
		expect(isLeap(2026)).toBe(false);
		expect(isLeap(2100)).toBe(false); // век без /400
		expect(isLeap(2000)).toBe(true); // /400
		expect(isLeap(1900)).toBe(false);
	});
});

describe("daysInMonth", () => {
	it("knows month lengths", () => {
		expect(daysInMonth(2026, 1)).toBe(31);
		expect(daysInMonth(2026, 4)).toBe(30);
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(daysInMonth(2028, 2)).toBe(29);
		expect(daysInMonth(2000, 2)).toBe(29);
		expect(daysInMonth(2100, 2)).toBe(28);
		expect(daysInMonth(2026, 12)).toBe(31);
	});
	it("throws on out-of-range month", () => {
		expect(() => daysInMonth(2026, 0)).toThrow(RangeError);
		expect(() => daysInMonth(2026, 13)).toThrow(RangeError);
	});
});

describe("clampDay", () => {
	it("clamps day 31 to month length", () => {
		expect(clampDay(2026, 2, 31)).toBe(28);
		expect(clampDay(2028, 2, 31)).toBe(29);
		expect(clampDay(2026, 4, 31)).toBe(30);
		expect(clampDay(2026, 1, 31)).toBe(31);
		expect(clampDay(2026, 2, 15)).toBe(15);
	});
});

describe("toParts / fromParts", () => {
	it("round-trips", () => {
		expect(toParts("2026-07-15")).toEqual({ y: 2026, m: 7, d: 15 });
		expect(fromParts({ y: 2026, m: 7, d: 15 })).toBe("2026-07-15");
		expect(fromParts({ y: 999, m: 1, d: 5 })).toBe("0999-01-05");
	});
	it("round-trips for arbitrary valid dates (property)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1600, max: 2400 }),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 31 }),
				(y, m, d) => {
					const dd = clampDay(y, m, d);
					const iso = fromParts({ y, m, d: dd });
					expect(toParts(iso)).toEqual({ y, m, d: dd });
				},
			),
		);
	});
});

describe("compare", () => {
	it("compares lexicographically == chronologically", () => {
		expect(compare("2026-07-15", "2026-07-16")).toBe(-1);
		expect(compare("2026-07-16", "2026-07-15")).toBe(1);
		expect(compare("2026-07-15", "2026-07-15")).toBe(0);
		expect(compare("2026-09-30", "2026-10-01")).toBe(-1);
	});
});

describe("isValidIsoDate", () => {
	it("accepts real dates, rejects everything else", () => {
		expect(isValidIsoDate("2026-12-31")).toBe(true);
		expect(isValidIsoDate("2028-02-29")).toBe(true);
		expect(isValidIsoDate("2026-02-29")).toBe(false);
		expect(isValidIsoDate("2026-02-30")).toBe(false);
		expect(isValidIsoDate("2026-13-01")).toBe(false);
		expect(isValidIsoDate("2026-00-10")).toBe(false);
		expect(isValidIsoDate("2026-01-00")).toBe(false);
		expect(isValidIsoDate("2026-1-1")).toBe(false);
		expect(isValidIsoDate("tomorrow")).toBe(false);
		expect(isValidIsoDate("")).toBe(false);
	});
});

describe("epoch days", () => {
	it("anchors at 1970-01-01", () => {
		expect(toEpochDays("1970-01-01")).toBe(0);
		expect(fromEpochDays(0)).toBe("1970-01-01");
		expect(toEpochDays("1969-12-31")).toBe(-1);
		expect(fromEpochDays(-1)).toBe("1969-12-31");
	});
	it("round-trips (property)", () => {
		fc.assert(
			fc.property(fc.integer({ min: -200000, max: 200000 }), (z) => {
				expect(toEpochDays(fromEpochDays(z))).toBe(z);
			}),
		);
	});
});

describe("addDays", () => {
	it("crosses month, year and leap boundaries", () => {
		expect(addDays("2026-07-15", 0)).toBe("2026-07-15");
		expect(addDays("2026-07-15", 1)).toBe("2026-07-16");
		expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
		expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
		expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(addDays("2026-07-31", -3)).toBe("2026-07-28"); // офсет из примера ТЗ §6
		expect(addDays("2026-07-15", 365)).toBe("2027-07-15");
	});
	it("is additive and monotone (property)", () => {
		const arbDate = fc
			.tuple(
				fc.integer({ min: 1900, max: 2200 }),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 31 }),
			)
			.map(([y, m, d]) => fromParts({ y, m, d: clampDay(y, m, d) }));
		fc.assert(
			fc.property(
				arbDate,
				fc.integer({ min: -1000, max: 1000 }),
				fc.integer({ min: -1000, max: 1000 }),
				(date, a, b) => {
					expect(addDays(addDays(date, a), b)).toBe(addDays(date, a + b));
					expect(compare(addDays(date, 1), date)).toBe(1);
				},
			),
		);
	});
});

describe("dayOfWeek (0=Mon .. 6=Sun)", () => {
	it("matches known dates", () => {
		expect(dayOfWeek("1970-01-01")).toBe(3); // четверг
		expect(dayOfWeek("2026-07-13")).toBe(0); // понедельник
		expect(dayOfWeek("2026-07-15")).toBe(2); // среда
		expect(dayOfWeek("2026-07-17")).toBe(4); // пятница
		expect(dayOfWeek("2026-07-19")).toBe(6); // воскресенье
		expect(dayOfWeek("2000-02-29")).toBe(1); // вторник
		expect(dayOfWeek("2026-12-31")).toBe(3); // четверг
	});
	it("advances by one per day (property)", () => {
		const arbDate = fc
			.tuple(
				fc.integer({ min: 1900, max: 2200 }),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 31 }),
			)
			.map(([y, m, d]) => fromParts({ y, m, d: clampDay(y, m, d) }));
		fc.assert(
			fc.property(arbDate, (date) => {
				expect(dayOfWeek(addDays(date, 1))).toBe((dayOfWeek(date) + 1) % 7);
			}),
		);
	});
});
