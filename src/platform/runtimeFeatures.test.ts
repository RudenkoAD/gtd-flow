import { describe, expect, it } from "vitest";
import { runtimeFeaturePolicy } from "./runtimeFeatures";

describe("runtimeFeaturePolicy", () => {
	it("keeps the Android MVP free of desktop and unverified background features", () => {
		expect(runtimeFeaturePolicy(false)).toEqual({
			desktopAi: false,
			crossViewDnd: false,
			backgroundPromotion: false,
			backgroundCalendarSync: false,
			onboarding: false,
			recurrence: true,
			viewKinds: ["inbox", "calendar", "recurring"],
		});
	});

	it("preserves the complete desktop feature set", () => {
		const desktop = runtimeFeaturePolicy(true);
		expect(desktop.desktopAi).toBe(true);
		expect(desktop.crossViewDnd).toBe(true);
		expect(desktop.backgroundPromotion).toBe(true);
		expect(desktop.backgroundCalendarSync).toBe(true);
		expect(desktop.onboarding).toBe(true);
		expect(desktop.recurrence).toBe(true);
		expect(desktop.viewKinds).toContain("ai");
		expect(desktop.viewKinds).toContain("recurring");
	});
});
