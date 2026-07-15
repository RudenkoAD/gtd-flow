import { describe, expect, it } from "vitest";
import { isParseError, parseRule, type Rule } from "./grammar";

function ok(text: string): Rule {
	const r = parseRule(text);
	if (isParseError(r)) throw new Error(`expected '${text}' to parse, got: ${r.error}`);
	return r;
}

function bad(text: string): void {
	const r = parseRule(text);
	expect(isParseError(r), `expected '${text}' to be rejected`).toBe(true);
}

describe("parseRule — accepted examples (spec §6)", () => {
	it("every day", () => {
		expect(ok("every day")).toEqual({ freq: "daily", n: 1 });
	});
	it("every 3 days", () => {
		expect(ok("every 3 days")).toEqual({ freq: "daily", n: 3 });
	});
	it("every weekday", () => {
		expect(ok("every weekday")).toEqual({ freq: "weekdays" });
	});
	it("every week on friday", () => {
		expect(ok("every week on friday")).toEqual({ freq: "weekly", n: 1, byDay: [4] });
	});
	it("every 2 weeks on mon, thu", () => {
		expect(ok("every 2 weeks on mon, thu")).toEqual({ freq: "weekly", n: 2, byDay: [0, 3] });
	});
	it("every month on the 15th", () => {
		expect(ok("every month on the 15th")).toEqual({ freq: "monthly", n: 1, day: 15 });
	});
	it("every month on the last day", () => {
		expect(ok("every month on the last day")).toEqual({ freq: "monthly", n: 1, day: "last" });
	});
	it("every 3 months on the 1st", () => {
		expect(ok("every 3 months on the 1st")).toEqual({ freq: "monthly", n: 3, day: 1 });
	});
	it("every year on april 1", () => {
		expect(ok("every year on april 1")).toEqual({ freq: "yearly", n: 1, month: 4, day: 1 });
	});
	it("every week until 2026-12-31", () => {
		expect(ok("every week until 2026-12-31")).toEqual({
			freq: "weekly",
			n: 1,
			byDay: [],
			until: "2026-12-31",
		});
	});
	it("every friday", () => {
		expect(ok("every friday")).toEqual({ freq: "weekly", n: 1, byDay: [4] });
	});
});

describe("parseRule — grammar breadth", () => {
	it("is case-insensitive", () => {
		expect(ok("Every Day")).toEqual({ freq: "daily", n: 1 });
		expect(ok("EVERY WEEK ON FRIDAY")).toEqual({ freq: "weekly", n: 1, byDay: [4] });
		expect(ok("every Month on the LAST day")).toEqual({ freq: "monthly", n: 1, day: "last" });
	});
	it("accepts full and 3-letter weekday names", () => {
		expect(ok("every week on monday")).toEqual({ freq: "weekly", n: 1, byDay: [0] });
		expect(ok("every week on mon")).toEqual({ freq: "weekly", n: 1, byDay: [0] });
		expect(ok("every week on sun")).toEqual({ freq: "weekly", n: 1, byDay: [6] });
	});
	it("sorts and dedupes weekday lists", () => {
		expect(ok("every week on thu, mon, thu")).toEqual({ freq: "weekly", n: 1, byDay: [0, 3] });
	});
	it("accepts plural weekday-name unit", () => {
		expect(ok("every fridays")).toEqual({ freq: "weekly", n: 1, byDay: [4] });
	});
	it("accepts stride with weekday-name unit", () => {
		expect(ok("every 2 fridays")).toEqual({ freq: "weekly", n: 2, byDay: [4] });
	});
	it("accepts 3-letter month names and ordinal day suffixes", () => {
		expect(ok("every year on apr 1st")).toEqual({ freq: "yearly", n: 1, month: 4, day: 1 });
		expect(ok("every year on february 29")).toEqual({ freq: "yearly", n: 1, month: 2, day: 29 });
	});
	it("accepts until on every frequency", () => {
		expect(ok("every day until 2026-12-31")).toEqual({
			freq: "daily",
			n: 1,
			until: "2026-12-31",
		});
		expect(ok("every month on the 15th until 2027-06-30")).toEqual({
			freq: "monthly",
			n: 1,
			day: 15,
			until: "2027-06-30",
		});
	});
	it("tolerates extra whitespace and tight commas", () => {
		expect(ok("  every   2  weeks  on mon,thu ")).toEqual({
			freq: "weekly",
			n: 2,
			byDay: [0, 3],
		});
	});
});

describe("parseRule — event time ('at' tail, §события)", () => {
	it("accepts 'at HH:mm' on any frequency", () => {
		expect(ok("every day at 09:00")).toEqual({ freq: "daily", n: 1, eventTime: "09:00" });
		expect(ok("every tuesday at 19:00")).toEqual({
			freq: "weekly",
			n: 1,
			byDay: [1],
			eventTime: "19:00",
		});
	});
	it("accepts 'at HH:mm-HH:mm' interval", () => {
		expect(ok("every tuesday at 19:00-20:30")).toEqual({
			freq: "weekly",
			n: 1,
			byDay: [1],
			eventTime: "19:00",
			eventTimeEnd: "20:30",
		});
	});
	it("combines with 'on' and 'until' clauses in any order", () => {
		expect(ok("every 2 weeks on mon, thu at 08:15 until 2027-01-01")).toEqual({
			freq: "weekly",
			n: 2,
			byDay: [0, 3],
			eventTime: "08:15",
			until: "2027-01-01",
		});
		expect(ok("every month on the last day at 23:00-23:59")).toEqual({
			freq: "monthly",
			n: 1,
			day: "last",
			eventTime: "23:00",
			eventTimeEnd: "23:59",
		});
	});
	it("rejects invalid time, non-later end, duplicate 'at', missing time", () => {
		bad("every day at 25:00");
		bad("every day at 9:00");
		bad("every day at 19:00-19:00");
		bad("every day at 20:00-19:00");
		bad("every day at 19:00-24:00");
		bad("every day at 09:00 at 10:00");
		bad("every day at");
	});
});

describe("parseRule — rejects", () => {
	it("rejects empty and bare 'every'", () => {
		bad("");
		bad("every");
		bad("garbage");
		bad("daily");
	});
	it("rejects zero stride", () => {
		bad("every 0 days");
		bad("every 0 weeks");
	});
	it("rejects unknown units", () => {
		bad("every banana");
		bad("every 3 banana");
	});
	it("rejects a bare stride with no unit", () => {
		bad("every 3");
	});
	it("rejects clause/frequency mismatches", () => {
		bad("every day on monday");
		bad("every month on friday");
		bad("every week on the 15th");
		bad("every day on the last day");
		bad("every friday on monday");
	});
	it("rejects monthly without a day clause", () => {
		bad("every month");
		bad("every 3 months");
	});
	it("rejects yearly without a month-day clause", () => {
		bad("every year");
	});
	it("rejects out-of-range days", () => {
		bad("every month on the 0th");
		bad("every month on the 32nd");
		bad("every year on february 30");
		bad("every year on april 31");
	});
	it("rejects stride on 'every weekday'", () => {
		bad("every 2 weekdays");
	});
	it("rejects bad until dates", () => {
		bad("every day until tomorrow");
		bad("every day until 2026-02-30");
		bad("every day until");
	});
	it("rejects trailing garbage", () => {
		bad("every day blah");
		bad("every week on friday xyzzy");
	});
});
