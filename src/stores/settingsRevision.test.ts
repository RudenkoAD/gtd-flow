import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { createSettingsRevision } from "./settingsRevision";

describe("settingsRevision", () => {
	it("invalidates mounted consumers after each completed settings save", () => {
		const revision = createSettingsRevision();
		expect(get(revision.store)).toBe(0);
		revision.notifySaved();
		revision.notifySaved();
		expect(get(revision.store)).toBe(2);
	});
});
