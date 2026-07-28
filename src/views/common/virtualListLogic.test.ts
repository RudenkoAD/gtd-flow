import { describe, expect, it } from "vitest";
import { cumulativeOffsets, firstVisibleIndex, measuredVisibleRange } from "./virtualListLogic";

describe("virtualListLogic", () => {
	it("uses measured row heights instead of treating wrapped rows as fixed height", () => {
		const offsets = cumulativeOffsets(
			3,
			new Map([
				["a", 20],
				["b", 90],
			]),
			["a", "b", "c"],
			44,
		);
		expect(offsets).toEqual([0, 20, 110, 154]);
		expect(firstVisibleIndex(offsets, 25)).toBe(1);
	});

	it("includes the viewport plus overscan at variable-height boundaries", () => {
		const offsets = [0, 20, 110, 154, 198];
		expect(measuredVisibleRange(offsets, 21, 89, 1)).toEqual({ first: 0, last: 4 });
		expect(measuredVisibleRange(offsets, 1000, 30, 1)).toEqual({ first: 2, last: 4 });
	});

	it("falls back to the estimate for unmeasured or invalid heights", () => {
		const offsets = cumulativeOffsets(
			2,
			new Map([
				["a", 0],
				["b", Number.NaN],
			]),
			["a", "b"],
			50,
		);
		expect(offsets).toEqual([0, 50, 100]);
	});
});
