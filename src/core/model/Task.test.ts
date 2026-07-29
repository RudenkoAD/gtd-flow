import { describe, expect, it } from "vitest";
import { isDurationMinutes, isIntensityLevel, isTaskIntensity } from "./Task";

describe("task metadata domain validators", () => {
	it("duration uses five-minute sub-day values and whole days from 24h upward", () => {
		const largestWholeDay = Math.floor(Number.MAX_SAFE_INTEGER / 1_440) * 1_440;
		expect(isDurationMinutes(5)).toBe(true);
		expect(isDurationMinutes(1_435)).toBe(true);
		expect(isDurationMinutes(1_440)).toBe(true);
		expect(isDurationMinutes(2_880)).toBe(true);
		expect(isDurationMinutes(largestWholeDay)).toBe(true);
		for (const value of [0, -5, 1, 91, 1_445, 2_220, Number.MAX_SAFE_INTEGER + 1]) {
			expect(isDurationMinutes(value), String(value)).toBe(false);
		}
	});

	it("an AI-valid intensity has all three integral dimensions from zero through five", () => {
		expect(isIntensityLevel(0)).toBe(true);
		expect(isIntensityLevel(5)).toBe(true);
		expect(isIntensityLevel(1.5)).toBe(false);
		expect(isTaskIntensity({ cognitive: 4, emotional: 2, physical: 0 })).toBe(true);
		expect(isTaskIntensity({ cognitive: 4, emotional: 2 })).toBe(false);
		expect(isTaskIntensity({ cognitive: 4, emotional: 2, physical: 6 })).toBe(false);
	});
});
