import { describe, expect, it } from "vitest";
import { ALL_NS, DEFAULT_NS } from "../core/namespace/namespace";
import { DEFAULT_SETTINGS } from "../settings/Settings";
import { loadWidgetSettings, resolveWidgetActive } from "./widgetSettings";

describe("widget namespace aliases", () => {
	it("gives an exact user namespace precedence over the shared all/default aliases", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			namespaces: [
				{ name: "All", root: "all-folder" },
				{ name: "Default", root: "default-folder" },
			],
		};
		expect(resolveWidgetActive("All", settings, [])).toBe("All");
		expect(resolveWidgetActive("Default", settings, [])).toBe("Default");
		expect(resolveWidgetActive("all", settings, [])).toBe(ALL_NS);
		expect(resolveWidgetActive("default", settings, [])).toBe(DEFAULT_NS);
	});

	it("does not let malformed persisted shapes crash the standalone widget", () => {
		const { settings } = loadWidgetSettings(
			JSON.stringify({
				namespaces: "not-an-array",
				calendarPlacement: ["due", "due", "unknown"],
				inboxIncludePlain: "yes",
				commonRoot: 42,
			}),
		);
		expect(settings.namespaces).toEqual([]);
		expect(settings.calendarPlacement).toEqual(DEFAULT_SETTINGS.calendarPlacement);
		expect(settings.inboxIncludePlain).toBe(DEFAULT_SETTINGS.inboxIncludePlain);
		expect(settings.commonRoot).toBe(DEFAULT_SETTINGS.commonRoot);
	});
});
