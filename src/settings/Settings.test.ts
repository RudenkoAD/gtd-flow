import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_FORMAT_VERSION, createDefaultSettings } from "./Settings";

describe("default settings", () => {
	it("uses one configured inbox and no namespace runtime fields", () => {
		const settings = createDefaultSettings();
		expect(settings.settingsVersion).toBe(SETTINGS_FORMAT_VERSION);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
		expect(settings.ai).toEqual({
			enabled: false,
			privacyPolicy: "account-policy",
			credentialStorage: "memory-only",
			storageVersion: 0,
		});
		expect(settings.durationLongStyle).toBe("whole-days");
		expect(settings).not.toHaveProperty("commonRoot");
		expect(settings).not.toHaveProperty("namespaces");
		expect(settings).not.toHaveProperty("activeNamespace");
		expect(DEFAULT_SETTINGS.inboxFile).toBe(settings.inboxFile);
	});

	it("returns independent mutable AI settings for each plugin instance", () => {
		const first = createDefaultSettings();
		const second = createDefaultSettings();
		first.ai.enabled = true;
		first.ai.privacyPolicy = "require-zdr";
		expect(second.ai).toEqual(DEFAULT_SETTINGS.ai);
	});
});
