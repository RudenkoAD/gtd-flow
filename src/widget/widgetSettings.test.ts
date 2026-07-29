import { describe, expect, it } from "vitest";
import { loadWidgetSettings } from "./widgetSettings";

describe("widget unified settings", () => {
	it("reads a valid inboxFile and ignores unrelated legacy keys", () => {
		const { settings } = loadWidgetSettings(
			JSON.stringify({ inboxFile: "Capture.md", namespaces: [{ name: "Old", root: "Old" }] }),
		);
		expect(settings.inboxFile).toBe("Capture.md");
	});

	it("migrates legacy duration presentation without consuming AI secrets", () => {
		const { settings } = loadWidgetSettings(
			JSON.stringify({
				durationLongStyle: "days-hours",
				ai: { enabled: true, apiKey: "must-not-be-consumed" },
			}),
		);
		expect(settings.durationLongStyle).toBe("whole-days");
		expect(settings.ai).toEqual({
			enabled: false,
			privacyPolicy: "account-policy",
			credentialStorage: "memory-only",
			storageVersion: 0,
		});
	});
});
