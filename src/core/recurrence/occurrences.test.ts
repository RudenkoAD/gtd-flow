import { describe, expect, it } from "vitest";
import { toEpochDays, weeksBetween } from "./dateMath";
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

describe("expandOccurrences — weekly n>1 чётность недель (якорь from)", () => {
	// Ориентиры: вторники июля 2026 — 07-07, 07-14, 07-21, 07-28; 08-11.
	it("'every 2 weeks on tue from 2026-07-14' → 07-14, 07-28, 08-11 и НЕ 07-21", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-14" };
		expect(expandOccurrences(r, "2026-07-01", "2026-08-15")).toEqual([
			"2026-07-14",
			"2026-07-28",
			"2026-08-11",
		]);
	});

	it("фаза НЕ зависит от начала видимого диапазона (регресс «появляется каждую неделю»)", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-14" };
		// диапазон, начинающийся до/после вторника, даёт ОДНУ И ТУ ЖЕ фазу
		expect(expandOccurrences(r, "2026-07-01", "2026-07-31")).toEqual(["2026-07-14", "2026-07-28"]);
		expect(expandOccurrences(r, "2026-07-02", "2026-07-31")).toEqual(["2026-07-14", "2026-07-28"]);
		expect(expandOccurrences(r, "2026-06-29", "2026-08-09")).toEqual(["2026-07-14", "2026-07-28"]);
	});

	it("несколько дней в неделю сохраняют фазу", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1, 4], from: "2026-07-14" }; // вт, пт
		expect(expandOccurrences(r, "2026-07-01", "2026-08-01")).toEqual([
			"2026-07-14",
			"2026-07-17",
			"2026-07-28",
			"2026-07-31",
		]);
	});

	it("every 3 weeks: шаг ровно 3 недели", () => {
		const r: Rule = { freq: "weekly", n: 3, byDay: [0], from: "2026-07-13" };
		expect(expandOccurrences(r, "2026-07-01", "2026-09-01")).toEqual([
			"2026-07-13",
			"2026-08-03",
			"2026-08-24",
		]);
	});

	it("переход через границу года", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [3], from: "2026-12-31" }; // чт
		expect(expandOccurrences(r, "2026-12-15", "2027-02-01")).toEqual([
			"2026-12-31",
			"2027-01-14",
			"2027-01-28",
		]);
	});

	it("from+until вместе ограничивают серию, фаза сохранена", () => {
		const r: Rule = {
			freq: "weekly",
			n: 2,
			byDay: [1],
			from: "2026-07-14",
			until: "2026-08-11",
		};
		expect(expandOccurrences(r, "2026-07-01", "2026-12-31")).toEqual([
			"2026-07-14",
			"2026-07-28",
			"2026-08-11",
		]);
	});

	it("без from фаза стабильна (эпоха-фолбэк): диапазон не сдвигает недели", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1] };
		const a = expandOccurrences(r, "2026-07-01", "2026-07-31");
		const b = expandOccurrences(r, "2026-07-02", "2026-07-31");
		expect(a).toEqual(b); // одна и та же фаза независимо от начала диапазона
		// и это ровно каждые 2 недели, а не каждую
		expect(a).toHaveLength(2);
		expect(weeksBetween(a[1]!, a[0]!)).toBe(2);
	});

	it("явный anchor-аргумент задаёт фазу при отсутствии from", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1] };
		expect(expandOccurrences(r, "2026-07-01", "2026-08-01", undefined, undefined, "2026-07-14")).toEqual(
			["2026-07-14", "2026-07-28"],
		);
	});

	it("n=1 с byDay не режется якорем (обратная совместимость)", () => {
		const r: Rule = { freq: "weekly", n: 1, byDay: [1], from: "2026-07-14" };
		expect(expandOccurrences(r, "2026-07-14", "2026-07-28")).toEqual([
			"2026-07-14",
			"2026-07-21",
			"2026-07-28",
		]);
	});

	it("фаза от первого вхождения: from не на дне byDay (среда) → 07-21, 08-04, 08-18", () => {
		// 'every 2 weeks on tue from 2026-07-15' (среда): первое вхождение — ближайший
		// вторник ≥ from (07-21), фаза считается от него, а НЕ от недели самой from
		const r: Rule = { freq: "weekly", n: 2, byDay: [1], from: "2026-07-15" };
		expect(expandOccurrences(r, "2026-07-01", "2026-08-20")).toEqual([
			"2026-07-21",
			"2026-08-04",
			"2026-08-18",
		]);
	});

	it("фаза от первого вхождения, несколько дней: 'tue,fri from 2026-07-16' (чт)", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [1, 4], from: "2026-07-16" };
		expect(expandOccurrences(r, "2026-07-01", "2026-08-15")).toEqual([
			"2026-07-17", // первое — пятница той же недели (фазовая неделя)
			"2026-07-28", // след. фазовая неделя, вт
			"2026-07-31", // пт той же недели
			"2026-08-11",
			"2026-08-14",
		]);
	});
});

describe("expandOccurrences — фаза daily/weekly-без-byDay при n>1", () => {
	it("daily n>1 с from: фаза от from — 07-15, 07-17, 07-19 (не 07-16)", () => {
		const r: Rule = { freq: "daily", n: 2, from: "2026-07-15" };
		expect(expandOccurrences(r, "2026-07-10", "2026-07-20")).toEqual([
			"2026-07-15",
			"2026-07-17",
			"2026-07-19",
		]);
	});

	it("daily n>1 с from: фаза НЕ зависит от начала видимого диапазона", () => {
		const r: Rule = { freq: "daily", n: 3, from: "2026-07-15" };
		// перекрывающиеся диапазоны дают одинаковые даты в пересечении
		expect(expandOccurrences(r, "2026-07-01", "2026-07-31")).toEqual([
			"2026-07-15",
			"2026-07-18",
			"2026-07-21",
			"2026-07-24",
			"2026-07-27",
			"2026-07-30",
		]);
		expect(expandOccurrences(r, "2026-07-16", "2026-07-31")).toEqual([
			"2026-07-18",
			"2026-07-21",
			"2026-07-24",
			"2026-07-27",
			"2026-07-30",
		]);
	});

	it("daily n>1 БЕЗ from: эпоха-фолбэк держит фазу стабильной при листании", () => {
		const r: Rule = { freq: "daily", n: 3 };
		const a = expandOccurrences(r, "2026-07-01", "2026-07-31");
		const b = expandOccurrences(r, "2026-07-02", "2026-07-31");
		const c = expandOccurrences(r, "2026-06-15", "2026-07-31");
		// пересечение диапазонов даёт ОДНИ И ТЕ ЖЕ даты — серия не «прыгает»
		expect(b).toEqual(a.filter((d) => d >= "2026-07-02"));
		expect(a).toEqual(c.filter((d) => d >= "2026-07-01"));
		// и это ровно каждые 3 дня
		expect(toEpochDays(a[1]!) - toEpochDays(a[0]!)).toBe(3);
	});

	it("weekly без byDay, n>1 с from: фаза от from — 07-15, 07-29, 08-12", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [], from: "2026-07-15" };
		expect(expandOccurrences(r, "2026-07-01", "2026-08-15")).toEqual([
			"2026-07-15",
			"2026-07-29",
			"2026-08-12",
		]);
		// начало диапазона после from — та же фаза
		expect(expandOccurrences(r, "2026-07-16", "2026-08-15")).toEqual([
			"2026-07-29",
			"2026-08-12",
		]);
	});

	it("weekly без byDay, n>1 БЕЗ from: эпоха-фолбэк держит фазу стабильной", () => {
		const r: Rule = { freq: "weekly", n: 2, byDay: [] };
		const a = expandOccurrences(r, "2026-07-01", "2026-08-31");
		const b = expandOccurrences(r, "2026-07-08", "2026-08-31");
		expect(b).toEqual(a.filter((d) => d >= "2026-07-08"));
		expect(toEpochDays(a[1]!) - toEpochDays(a[0]!)).toBe(14);
	});

	it("daily n=1: разворот прежний — каждое число диапазона (обратная совместимость)", () => {
		const r: Rule = { freq: "daily", n: 1 };
		expect(expandOccurrences(r, "2026-07-15", "2026-07-17")).toEqual([
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
