import { describe, expect, it } from "vitest";
import type { Rule } from "./grammar";
import { DEFAULT_OCCURRENCE_CAP, expandOccurrences } from "./occurrences";

// Ориентиры 2026: 07-13 понедельник, 07-15 среда, 07-17 пятница, 07-31 пятница.

describe("expandOccurrences — границы диапазона", () => {
	it("включает вхождение, попадающее ровно на fromIso", () => {
		const r: Rule = { freq: "daily", n: 1 };
		expect(expandOccurrences(r, "2026-07-15", "2026-07-18")).toEqual([
			"2026-07-15",
			"2026-07-16",
			"2026-07-17",
			"2026-07-18",
		]);
	});

	it("включает вхождение ровно на toIso, исключает позже", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [4] }; // пятницы
		expect(expandOccurrences(r, "2026-07-01", "2026-07-17")).toEqual([
			"2026-07-03",
			"2026-07-10",
			"2026-07-17",
		]);
	});

	it("пустой при from > to", () => {
		expect(expandOccurrences({ freq: "daily", n: 1 }, "2026-07-18", "2026-07-15")).toEqual([]);
	});

	it("пустой, когда в диапазоне нет вхождений", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [4] }; // пятница
		// 2026-07-13 пн … 2026-07-16 чт — пятниц нет
		expect(expandOccurrences(r, "2026-07-13", "2026-07-16")).toEqual([]);
	});

	it("уважает until (включительно)", () => {
		const r: Rule = { freq: "daily", n: 1, until: "2026-07-16" };
		expect(expandOccurrences(r, "2026-07-15", "2026-07-20")).toEqual(["2026-07-15", "2026-07-16"]);
	});
});

describe("expandOccurrences — weekly/monthly", () => {
	it("weekly с несколькими днями в неделю", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [0, 4] }; // пн, пт
		expect(expandOccurrences(r, "2026-07-13", "2026-07-20")).toEqual([
			"2026-07-13", // пн
			"2026-07-17", // пт
			"2026-07-20", // пн
		]);
	});

	it("monthly on the last day через границу месяцев с клампингом", () => {
		const r: Rule = { freq: "monthly", n: 1, day: "last" };
		expect(expandOccurrences(r, "2026-07-01", "2026-09-30")).toEqual([
			"2026-07-31",
			"2026-08-31",
			"2026-09-30",
		]);
	});

	it("monthly on the 31st клампится в коротких месяцах", () => {
		const r: Rule = { freq: "monthly", n: 1, day: 31 };
		expect(expandOccurrences(r, "2026-01-01", "2026-04-30")).toEqual([
			"2026-01-31",
			"2026-02-28",
			"2026-03-31",
			"2026-04-30",
		]);
	});
});

describe("expandOccurrences — исключения (🚫)", () => {
	it("даты из exclude пропускаются", () => {
		const r: Rule = { freq: "daily", n: 1 };
		const exclude = new Set(["2026-07-16", "2026-07-18"]);
		expect(expandOccurrences(r, "2026-07-15", "2026-07-19", undefined, exclude)).toEqual([
			"2026-07-15",
			"2026-07-17",
			"2026-07-19",
		]);
	});

	it("исключение на fromIso/toIso тоже гасит вхождение", () => {
		const r: Rule = { freq: "daily", n: 1 };
		const exclude = new Set(["2026-07-15", "2026-07-17"]);
		expect(expandOccurrences(r, "2026-07-15", "2026-07-17", undefined, exclude)).toEqual([
			"2026-07-16",
		]);
	});

	it("пустой exclude эквивалентен отсутствию", () => {
		const r: Rule = { freq: "daily", n: 1 };
		expect(expandOccurrences(r, "2026-07-15", "2026-07-17", undefined, new Set())).toEqual([
			"2026-07-15",
			"2026-07-16",
			"2026-07-17",
		]);
	});

	it("исключённые не занимают потолок cap", () => {
		const r: Rule = { freq: "daily", n: 1 };
		const exclude = new Set(["2026-07-15", "2026-07-16"]);
		const out = expandOccurrences(r, "2026-07-15", "2026-07-31", 3, exclude);
		// первые две даты исключены — cap=3 набирается со след. трёх невыключенных
		expect(out).toEqual(["2026-07-17", "2026-07-18", "2026-07-19"]);
	});
});

describe("expandOccurrences — from (нижняя граница)", () => {
	// Ориентир: среды июля 2026 — 07-01, 07-08, 07-15, 07-22, 07-29.
	it("серия from 2026-07-15 не рендерит среды 1 и 8 июля, но рендерит 15-е и позже", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [2], from: "2026-07-15" }; // среды
		expect(expandOccurrences(r, "2026-07-01", "2026-07-29")).toEqual([
			"2026-07-15",
			"2026-07-22",
			"2026-07-29",
		]);
	});

	it("from и until вместе ограничивают серию с обеих сторон", () => {
		const r: Rule = {
			freq: "weekly",
			n: 1,
			byDay: [2],
			from: "2026-07-15",
			until: "2026-07-22",
		};
		expect(expandOccurrences(r, "2026-07-01", "2026-08-31")).toEqual(["2026-07-15", "2026-07-22"]);
	});

	it("from сочетается с исключениями (🚫)", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [2], from: "2026-07-15" };
		const exclude = new Set(["2026-07-22"]);
		expect(expandOccurrences(r, "2026-07-01", "2026-07-29", undefined, exclude)).toEqual([
			"2026-07-15",
			"2026-07-29",
		]);
	});

	it("daily from: первое вхождение — ровно from, ничего раньше", () => {
		const r: Rule = { freq: "daily", n: 1, from: "2026-07-15" };
		expect(expandOccurrences(r, "2026-07-10", "2026-07-17")).toEqual([
			"2026-07-15",
			"2026-07-16",
			"2026-07-17",
		]);
	});
});

describe("expandOccurrences — cap", () => {
	it("обрывается на потолке", () => {
		const r: Rule = { freq: "daily", n: 1 };
		const out = expandOccurrences(r, "2026-01-01", "2026-12-31", 5);
		expect(out).toHaveLength(5);
		expect(out[0]).toBe("2026-01-01");
		expect(out[4]).toBe("2026-01-05");
	});

	it("cap<=0 — пусто", () => {
		expect(expandOccurrences({ freq: "daily", n: 1 }, "2026-01-01", "2026-12-31", 0)).toEqual([]);
	});

	it("дефолтный потолок ограничивает очень широкий разворот", () => {
		const out = expandOccurrences({ freq: "daily", n: 1 }, "2000-01-01", "2100-01-01");
		expect(out).toHaveLength(DEFAULT_OCCURRENCE_CAP);
	});
});
