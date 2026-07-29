import { describe, expect, it } from "vitest";
import { emptyTaskProvenance } from "../../core/estimates/provenance";
import { makeTask } from "../../stores/testSupport";
import { displayDuration, taskMetadataBadges } from "./taskMetadataDisplay";

describe("task metadata badges", () => {
	it("renders duration, every intensity, resolved scope, and textual ownership", () => {
		const task = makeTask({
			filePath: "Inbox.md",
			durationMinutes: 90,
			cognitiveIntensity: 4,
			emotionalIntensity: 2,
			physicalIntensity: 0,
			scopeId: "work",
		});
		const provenance = emptyTaskProvenance("task-1", "2026-07-28T12:00:00.000Z");
		provenance.fields.cognitive = {
			...provenance.fields.cognitive,
			owner: "user",
			locked: true,
		};
		const badges = taskMetadataBadges(
			task,
			{ scopeName: (id) => (id === "work" ? "Work" : null) },
			provenance,
		);
		expect(badges.map((badge) => badge.label)).toEqual([
			"⏱ 1h 30m",
			"🧠 4",
			"💓 2",
			"💪 0",
			"🧭 Work",
		]);
		expect(badges.find((badge) => badge.field === "cognitive")?.title).toMatch(
			/Edited by you; locked/,
		);
		expect(badges.find((badge) => badge.field === "duration")?.title).toMatch(
			/Suggested by AI; unlocked/,
		);
	});

	it("falls back to the stable scope ID when no resolver is available", () => {
		const task = makeTask({ filePath: "Inbox.md", scopeId: "life-admin" });
		expect(taskMetadataBadges(task, null, null)).toEqual([
			expect.objectContaining({ label: "🧭 life-admin" }),
		]);
	});

	it("shows sub-day detail and whole-day long durations", () => {
		expect(displayDuration(90, null)).toBe("1h 30m");
		expect(displayDuration(24 * 60, null)).toBe("1d");
		expect(displayDuration(48 * 60, "whole-days")).toBe("2d");
	});
});
