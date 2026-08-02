import { describe, expect, it, vi } from "vitest";
import type { EstimateField, TaskEstimateProvenance } from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import { createScopeCatalog } from "../../core/scope/scope";
import {
	DesktopTaskMetadataActions,
	type DesktopTaskMetadataActionsOptions,
} from "./DesktopTaskMetadataActions";

function task(taskId: string | null = "task-1"): Task {
	return {
		key: "id:task-1",
		taskId,
		durationMinutes: 30,
		cognitiveIntensity: 2,
		emotionalIntensity: 1,
		physicalIntensity: 0,
		scopeId: "work",
	} as Task;
}

function provenance(locked: readonly EstimateField[] = []): TaskEstimateProvenance {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		fields: Object.fromEntries(
			(["duration", "cognitive", "emotional", "physical", "scope"] as const).map((field) => [
				field,
				{
					owner: locked.includes(field) ? "user" : "ai",
					locked: locked.includes(field),
					lastPredictionEventId: null,
					updatedAt: "2026-07-28T00:00:00.000Z",
				},
			]),
		) as TaskEstimateProvenance["fields"],
	};
}

function options(
	overrides: Partial<DesktopTaskMetadataActionsOptions> = {},
): DesktopTaskMetadataActionsOptions {
	return {
		dispatcher: {
			ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
		},
		history: {
			provenanceForTask: async () => provenance(),
			eventsForTask: async () => [],
		} as never,
		processor: { process: vi.fn() } as never,
		scopes: () => createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
		openSession: async () => undefined,
		now: () => new Date("2026-07-28T00:00:00.000Z"),
		...overrides,
	};
}

describe("DesktopTaskMetadataActions", () => {
	it("reprocesses exactly the selected unlocked field", async () => {
		const process = vi.fn(async () => ({ state: "completed", runId: "run-1" }));
		const actions = new DesktopTaskMetadataActions(
			options({
				history: {
					...options().history,
					provenanceForTask: async () => provenance(["duration"]),
				} as never,
				processor: { process } as never,
			}),
		);

		await expect(actions.unlockFieldAndReprocess(task(), "duration")).resolves.toEqual({
			ok: true,
		});
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			onlyFields: ["duration"],
			unlockFields: ["duration"],
		});
	});

	it("opens only a concrete related AI session", async () => {
		const openSession = vi.fn(async () => undefined);
		const actions = new DesktopTaskMetadataActions(
			options({
				history: {
					...options().history,
					eventsForTask: async () => [
						{ kind: "estimate-suggested", sessionId: null },
						{ kind: "estimate-suggested", sessionId: "session-2" },
					],
				} as never,
				openSession,
			}),
		);

		await expect(actions.openRelatedAiRun(task(null))).resolves.toEqual({
			ok: false,
			reason: "task-has-no-ai-run",
		});
		await expect(actions.openRelatedAiRun(task())).resolves.toEqual({ ok: true });
		expect(openSession).toHaveBeenCalledWith("session-2");
	});

	it("requires an explicit choice when several fields are user-owned", async () => {
		const process = vi.fn();
		const actions = new DesktopTaskMetadataActions(
			options({
				history: {
					...options().history,
					provenanceForTask: async () => provenance(["duration", "cognitive"]),
				} as never,
				processor: { process } as never,
			}),
		);

		await expect(actions.unlockAndReprocess(task())).resolves.toEqual({
			ok: false,
			reason: "ai-field-selection-required",
		});
		expect(process).not.toHaveBeenCalled();
	});

	it("fails closed before processing when locks, scopes, or anchoring are unavailable", async () => {
		await expect(
			new DesktopTaskMetadataActions(options()).unlockAndReprocess(task(), "duration"),
		).resolves.toEqual({ ok: false, reason: "no-locked-ai-fields" });

		await expect(
			new DesktopTaskMetadataActions(
				options({
					history: {
						...options().history,
						provenanceForTask: async () => provenance(["duration"]),
					} as never,
					scopes: () => createScopeCatalog(),
				}),
			).unlockAndReprocess(task(), "duration"),
		).resolves.toEqual({ ok: false, reason: "ai-reprocessing-blocked-no-scopes" });

		await expect(
			new DesktopTaskMetadataActions(
				options({
					dispatcher: {
						ensureTaskId: async () => ({ ok: false, reason: "anchor-failed" }),
					} as never,
				}),
			).unlockAndReprocess(task(), "duration"),
		).resolves.toEqual({ ok: false, reason: "anchor-failed" });
	});

	it.each([
		["nothing-to-process", "ai-reprocessing-nothing-to-process", []],
		["blocked-no-scopes", "ai-reprocessing-blocked-no-scopes", []],
		["failed", "provider-failed", [{ reason: "provider-failed" }]],
		["cancelled", "ai-reprocessing-cancelled", []],
		["completed", "ai-reprocessing-did-not-start", []],
	] as const)("maps %s processor results to %s", async (state, reason, failed) => {
		const actions = new DesktopTaskMetadataActions(
			options({
				history: {
					...options().history,
					provenanceForTask: async () => provenance(["duration"]),
				} as never,
				processor: {
					process: async () => ({ state, runId: null, failed }),
				} as never,
			}),
		);

		await expect(actions.unlockAndReprocess(task(), "duration")).resolves.toEqual({
			ok: false,
			reason,
		});
	});
});
