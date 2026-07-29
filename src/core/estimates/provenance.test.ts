import { describe, expect, it } from "vitest";
import { createScopeCatalog } from "../scope/scope";
import {
	applyAiPrediction,
	emptyTaskProvenance,
	lockUserEditedFields,
	parseTaskEstimateProvenance,
	unlockFields,
} from "./provenance";

const catalog = createScopeCatalog([
	{ id: "work", name: "Work", order: 0, archived: false },
	{ id: "old", name: "Old", order: 1, archived: true },
]);
const values = {
	durationMinutes: 90,
	cognitiveIntensity: 4,
	emotionalIntensity: 2,
	physicalIntensity: 0,
	scopeId: "work",
} as const;

describe("estimate provenance", () => {
	it("applies every first prediction field atomically", () => {
		const result = applyAiPrediction({
			taskId: "task-1",
			values,
			catalog,
			predictionEventId: "prediction-1",
			now: "2026-07-28T00:00:00.000Z",
		});
		expect(result.patch).toEqual(values);
		expect(result.applied).toEqual(["duration", "cognitive", "emotional", "physical", "scope"]);
		expect(result.skippedLocked).toEqual([]);
	});

	it("never overwrites user-edited or cleared fields", () => {
		const base = emptyTaskProvenance("task-1", "2026-07-28T00:00:00.000Z");
		const locked = lockUserEditedFields({
			provenance: base,
			taskId: "task-1",
			fields: ["duration", "scope"],
			now: "2026-07-28T00:01:00.000Z",
		});
		const result = applyAiPrediction({
			taskId: "task-1",
			values,
			catalog,
			predictionEventId: "prediction-2",
			now: "2026-07-28T00:02:00.000Z",
			current: locked,
		});
		expect(result.patch).toEqual({
			cognitiveIntensity: 4,
			emotionalIntensity: 2,
			physicalIntensity: 0,
		});
		expect(result.skippedLocked).toEqual(["duration", "scope"]);
	});

	it("unlocks only explicit fields and supports linked-question reprocessing", () => {
		const base = lockUserEditedFields({
			provenance: null,
			taskId: "task-1",
			fields: ["duration", "scope"],
			now: "2026-07-28T00:00:00.000Z",
		});
		const unlocked = unlockFields({
			provenance: base,
			fields: ["duration"],
			now: "2026-07-28T00:01:00.000Z",
		});
		const result = applyAiPrediction({
			taskId: "task-1",
			values,
			catalog,
			predictionEventId: "prediction-3",
			now: "2026-07-28T00:02:00.000Z",
			current: unlocked,
			onlyFields: ["duration", "scope"],
		});
		expect(result.patch).toEqual({ durationMinutes: 90 });
		expect(result.skippedLocked).toEqual(["scope"]);
	});

	it("rejects invalid or archived scopes", () => {
		expect(() =>
			applyAiPrediction({
				taskId: "task-1",
				values: { ...values, scopeId: "old" },
				catalog,
				predictionEventId: "prediction-1",
				now: "2026-07-28T00:00:00.000Z",
			}),
		).toThrow("invalid-active-scope");
	});

	it("parses untrusted synced provenance fail-closed", () => {
		const valid = emptyTaskProvenance("task-1", "2026-07-28T00:00:00.000Z");
		expect(parseTaskEstimateProvenance(valid)).toEqual(valid);
		expect(parseTaskEstimateProvenance({ ...valid, taskId: "" })).toBeNull();
		expect(
			parseTaskEstimateProvenance({
				...valid,
				fields: { ...valid.fields, scope: { ...valid.fields.scope, owner: "model" } },
			}),
		).toBeNull();
	});
});
