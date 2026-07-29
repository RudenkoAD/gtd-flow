import { describe, expect, it } from "vitest";
import { makeTask } from "../../stores/testSupport";
import {
	metadataDraftFromTask,
	metadataPatchFromDraft,
	patchForMetadataField,
} from "./taskMetadata";

describe("task metadata draft", () => {
	it("creates one minimal patch and supports clearing several fields atomically", () => {
		const task = makeTask({
			filePath: "Inbox.md",
			durationMinutes: 60,
			cognitiveIntensity: 3,
			emotionalIntensity: 2,
			physicalIntensity: 0,
			scopeId: "work",
		});
		expect(metadataPatchFromDraft(task, metadataDraftFromTask(task))).toEqual({});
		expect(
			metadataPatchFromDraft(task, {
				durationMinutes: "90",
				cognitiveIntensity: "",
				emotionalIntensity: "2",
				physicalIntensity: "4",
				scopeId: "life",
			}),
		).toEqual({
			durationMinutes: 90,
			cognitiveIntensity: null,
			physicalIntensity: 4,
			scopeId: "life",
		});
	});

	it("rejects invalid duration and intensity before dispatch", () => {
		const task = makeTask({ filePath: "Inbox.md" });
		expect(() =>
			metadataPatchFromDraft(task, {
				...metadataDraftFromTask(task),
				durationMinutes: "13",
			}),
		).toThrow(/five-minute sub-day/);
		expect(() =>
			metadataPatchFromDraft(task, {
				...metadataDraftFromTask(task),
				durationMinutes: "2220",
			}),
		).toThrow(/whole-day increments/);
		expect(() =>
			metadataPatchFromDraft(task, {
				...metadataDraftFromTask(task),
				physicalIntensity: "6",
			}),
		).toThrow(/0 to 5/);
	});

	it.each([90, 1_440, 2_880])(
		"accepts supported sub-day and whole-day duration %i",
		(durationMinutes) => {
			const task = makeTask({ filePath: "Inbox.md" });
			expect(
				metadataPatchFromDraft(task, {
					...metadataDraftFromTask(task),
					durationMinutes: String(durationMinutes),
				}),
			).toEqual({ durationMinutes });
		},
	);

	it("clears exactly the requested field", () => {
		expect(patchForMetadataField("duration")).toEqual({ durationMinutes: null });
		expect(patchForMetadataField("scope")).toEqual({ scopeId: null });
	});
});
