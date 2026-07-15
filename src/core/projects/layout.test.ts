import { describe, expect, it } from "vitest";
import { normalizeLayout } from "./layout";

describe("normalizeLayout", () => {
	it("keeps known members, drops unknown ids, lists missing members", () => {
		const raw = {
			a: { x: 0, y: 0 },
			b: { x: 260, y: -80 },
			gone: { x: 5, y: 5 },
		};
		const res = normalizeLayout(raw, ["a", "b", "c"]);
		expect(res.layout).toEqual({ a: { x: 0, y: 0 }, b: { x: 260, y: -80 } });
		expect(res.dropped).toEqual(["gone"]);
		expect(res.missing).toEqual(["c"]);
	});

	it("member with malformed position goes to missing", () => {
		const raw = {
			a: { x: "12", y: 0 },
			b: { x: 1 },
			c: null,
			d: { x: Number.NaN, y: 2 },
			e: { x: 1, y: 2 },
		};
		const res = normalizeLayout(raw, ["a", "b", "c", "d", "e"]);
		expect(res.layout).toEqual({ e: { x: 1, y: 2 } });
		expect(res.missing.sort()).toEqual(["a", "b", "c", "d"]);
		expect(res.dropped).toEqual([]);
	});

	it("non-object input means empty layout, all members missing", () => {
		for (const raw of [undefined, null, "layout", 42, ["a"]]) {
			const res = normalizeLayout(raw, ["a", "b"]);
			expect(res.layout).toEqual({});
			expect(res.missing).toEqual(["a", "b"]);
			expect(res.dropped).toEqual([]);
		}
	});

	it("duplicate member ids do not duplicate missing entries", () => {
		const res = normalizeLayout({}, ["a", "a", "b"]);
		expect(res.missing).toEqual(["a", "b"]);
	});

	it("empty members: everything in layout is dropped", () => {
		const res = normalizeLayout({ a: { x: 1, y: 2 } }, []);
		expect(res.layout).toEqual({});
		expect(res.dropped).toEqual(["a"]);
		expect(res.missing).toEqual([]);
	});
});
