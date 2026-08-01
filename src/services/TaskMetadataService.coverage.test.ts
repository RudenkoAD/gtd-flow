import { describe, expect, it, vi } from "vitest";
import type { TaskEstimateProvenance } from "../core/estimates/provenance";
import type { Task } from "../core/model/Task";
import { createScopeCatalog } from "../core/scope/scope";
import { TaskMetadataService, type TaskMetadataServiceOptions } from "./TaskMetadataService";

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

function provenance(locked: readonly string[] = []): TaskEstimateProvenance {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		fields: Object.fromEntries(
			["duration", "cognitive", "emotional", "physical", "scope"].map((field) => [
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

function options(overrides: Partial<TaskMetadataServiceOptions> = {}): TaskMetadataServiceOptions {
	return {
		dispatcher: {
			ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
			dispatchMany: async () => ({ ok: true }),
		} as never,
		history: {
			prepareMutation: async () => undefined,
			commitPrepared: async () => undefined,
			cancelPrepared: async () => undefined,
			provenanceForTask: async () => provenance(),
			eventsForTask: async () => [],
		} as never,
		processor: { process: vi.fn() },
		scopes: () => createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
		durationLongStyle: () => "whole-days",
		openSession: async () => undefined,
		now: () => new Date("2026-07-28T00:00:00.000Z"),
		createId: () => "event-1",
		...overrides,
	};
}

describe("TaskMetadataService failure and recovery outcomes", () => {
	it("exposes immutable UI snapshots and only opens a concrete related AI session", async () => {
		const openSession = vi.fn(async () => undefined);
		const service = new TaskMetadataService(
			options({
				openSession,
				history: {
					...options().history,
					eventsForTask: async () => [
						{ kind: "estimate-suggested", sessionId: null },
						{ kind: "estimate-suggested", sessionId: "session-2" },
					],
				} as never,
			}),
		);
		const catalog = service.scopes();
		catalog.scopes[0]!.name = "caller mutation";
		expect(service.scopeName("work")).toBe("Work");
		expect(service.scopeName("missing")).toBeNull();
		expect(service.durationLongStyle()).toBe("whole-days");
		await expect(service.openRelatedAiRun(task(null))).resolves.toEqual({
			ok: false,
			reason: "task-has-no-ai-run",
		});
		await expect(service.openRelatedAiRun(task())).resolves.toEqual({ ok: true });
		expect(openSession).toHaveBeenCalledWith("session-2");
	});

	it("returns a durable warning after Markdown succeeds but feedback finalization fails", async () => {
		const service = new TaskMetadataService(
			options({
				history: {
					...options().history,
					commitPrepared: async () => {
						throw new Error("offline");
					},
				} as never,
			}),
		);
		await expect(service.applyManualPatch(task(), { durationMinutes: 45 })).resolves.toEqual({
			ok: false,
			reason: "metadata-saved-but-feedback-write-failed",
		});
	});

	it("fails closed for anchor, prepare, lock, scope, and processor terminal states", async () => {
		const anchorFailure = new TaskMetadataService(
			options({
				dispatcher: {
					ensureTaskId: async () => ({ ok: false, reason: "anchor-failed" }),
				} as never,
			}),
		);
		await expect(
			anchorFailure.applyManualPatch(task(), { durationMinutes: 45 }),
		).resolves.toEqual({
			ok: false,
			reason: "anchor-failed",
		});

		let prepared = 0;
		const cancelled: string[] = [];
		const prepareFailure = new TaskMetadataService(
			options({
				history: {
					...options().history,
					prepareMutation: async () => {
						prepared++;
						if (prepared === 2) throw new Error("no journal");
					},
					cancelPrepared: async (id: string) => cancelled.push(id),
				} as never,
				createId: () => `event-${prepared + 1}`,
			}),
		);
		await expect(
			prepareFailure.applyManualPatch(task(), { durationMinutes: 45, scopeId: "work" }),
		).resolves.toEqual({ ok: false, reason: "feedback-prepare-failed" });
		expect(cancelled).toEqual(["event-1"]);

		const noLocks = new TaskMetadataService(options());
		await expect(noLocks.unlockAndReprocess(task(), "duration")).resolves.toEqual({
			ok: false,
			reason: "no-locked-ai-fields",
		});

		const noScopes = new TaskMetadataService(
			options({
				history: {
					...options().history,
					provenanceForTask: async () => provenance(["duration"]),
				} as never,
				scopes: () => createScopeCatalog(),
			}),
		);
		await expect(noScopes.unlockAndReprocess(task(), "duration")).resolves.toEqual({
			ok: false,
			reason: "ai-reprocessing-blocked-no-scopes",
		});

		const noRun = new TaskMetadataService(
			options({
				history: {
					...options().history,
					provenanceForTask: async () => provenance(["duration"]),
				} as never,
				processor: {
					process: async () => ({ state: "completed", runId: null }),
				} as never,
			}),
		);
		await expect(noRun.unlockAndReprocess(task(), "duration")).resolves.toEqual({
			ok: false,
			reason: "ai-reprocessing-did-not-start",
		});
	});
});
