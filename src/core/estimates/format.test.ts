import { describe, expect, it } from "vitest";
import { formatDuration, INTENSITY_ANCHORS } from "./format";

describe("estimate formatting", () => {
	it.each([
		[null, "Unknown"],
		[5, "5m"],
		[90, "1h 30m"],
		[120, "2h"],
		[1_440, "1d"],
		[2_880, "2d"],
	])("formats %s minutes", (minutes, expected) => {
		expect(formatDuration(minutes, "whole-days")).toBe(expected);
	});

	it("has stable six-level anchors for every dimension", () => {
		for (const dimension of Object.values(INTENSITY_ANCHORS)) {
			expect(Object.keys(dimension)).toEqual(["0", "1", "2", "3", "4", "5"]);
			expect(new Set(Object.values(dimension)).size).toBe(6);
		}
	});
});
