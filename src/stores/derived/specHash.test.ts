import { describe, expect, it } from "vitest";
import type { QuerySpec } from "../../core/query/querySpec";
import { specHash, stableStringify } from "./specHash";

describe("stableStringify", () => {
	it("сортирует ключи объектов: порядок вставки не влияет", () => {
		const a = { x: 1, y: 2, z: 3 };
		const b = { z: 3, x: 1, y: 2 };
		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("сортировка рекурсивна для вложенных объектов", () => {
		const a = { outer: { p: 1, q: 2 }, k: [{ b: 1, a: 2 }] };
		const b = { k: [{ a: 2, b: 1 }], outer: { q: 2, p: 1 } };
		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("порядок элементов массива значим", () => {
		expect(stableStringify(["due", "start"])).not.toBe(stableStringify(["start", "due"]));
	});

	it("примитивы и null — как JSON.stringify", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(42)).toBe("42");
		expect(stableStringify("s")).toBe('"s"');
		expect(stableStringify(true)).toBe("true");
	});

	it("undefined-поля опускаются", () => {
		expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
	});
});

describe("specHash", () => {
	it("перестановка ключей spec даёт одинаковый хэш", () => {
		const a: QuerySpec = {
			kind: "calendar-range",
			fromIso: "2026-07-01",
			toIso: "2026-07-31",
			placement: ["due", "scheduled"],
		};
		// та же спека, поля в другом порядке вставки
		const b = {
			placement: ["due", "scheduled"],
			toIso: "2026-07-31",
			fromIso: "2026-07-01",
			kind: "calendar-range",
		} as QuerySpec;
		expect(specHash(a)).toBe(specHash(b));
	});

	it("разные spec дают разные хэши", () => {
		const specs: QuerySpec[] = [
			{ kind: "inbox" },
			{ kind: "tickler" },
			{ kind: "active" },
			{ kind: "all-templates" },
			{ kind: "project-members", path: "P/one.md" },
			{ kind: "project-members", path: "P/two.md" },
			{
				kind: "calendar-range",
				fromIso: "2026-07-01",
				toIso: "2026-07-31",
				placement: ["due"],
			},
			{
				kind: "calendar-range",
				fromIso: "2026-07-01",
				toIso: "2026-07-31",
				placement: ["scheduled"],
			},
		];
		const hashes = new Set(specs.map(specHash));
		expect(hashes.size).toBe(specs.length);
	});

	it("разница только в placement-порядке — разные хэши (это разный приоритет полей)", () => {
		const a: QuerySpec = {
			kind: "calendar-range",
			fromIso: "2026-07-01",
			toIso: "2026-07-31",
			placement: ["due", "start"],
		};
		const b: QuerySpec = {
			kind: "calendar-range",
			fromIso: "2026-07-01",
			toIso: "2026-07-31",
			placement: ["start", "due"],
		};
		expect(specHash(a)).not.toBe(specHash(b));
	});
});
