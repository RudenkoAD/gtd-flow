import { describe, expect, it, vi } from "vitest";
import type { Task } from "../core/model/Task";
import { createScopeCatalog } from "../core/scope/scope";
import type { EstimateFeedbackEvent } from "./EstimateFeedbackService";
import { TaskMetadataService } from "./TaskMetadataService";

function task(): Task {
	return {
		key: "id:task-1",
		taskId: "task-1",
		durationMinutes: 30,
		cognitiveIntensity: 2,
		emotionalIntensity: 1,
		physicalIntensity: 0,
		scopeId: "work",
		description: "Reconcile invoices",
		tags: ["finance"],
		container: "inbox",
		heading: "Admin",
		recurrence: null,
	} as Task;
}

describe("TaskMetadataService", () => {
	it("writes one atomic patch and records each user-owned field", async () => {
		const events: EstimateFeedbackEvent[] = [];
		const prepared = new Map<string, EstimateFeedbackEvent>();
		const timeline: string[] = [];
		const dispatch = vi.fn(async () => {
			timeline.push("dispatch");
			return { ok: true as const };
		});
		const expected = vi.fn(() => {
			timeline.push("expect");
		});
		let id = 0;
		const service = new TaskMetadataService({
			dispatcher: {
				ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
				dispatch,
			} as never,
			history: {
				prepareMutation: async (event: EstimateFeedbackEvent) => {
					timeline.push(`prepare:${event.kind}`);
					prepared.set(event.id, event);
				},
				commitPrepared: async (eventId: string) => {
					timeline.push(`commit:${eventId}`);
					events.push(prepared.get(eventId)!);
					prepared.delete(eventId);
				},
				cancelPrepared: async (eventId: string) => {
					prepared.delete(eventId);
				},
			} as never,
			processor: { process: vi.fn() },
			scopes: () => createScopeCatalog(),
			openSession: async () => undefined,
			expectKnownPatch: expected,
			createId: () => `event-${++id}`,
			now: () => new Date("2026-07-28T00:00:00.000Z"),
		});
		await expect(
			service.applyManualPatch(task(), { durationMinutes: 45, scopeId: "life" }),
		).resolves.toEqual({ ok: true });
		expect(dispatch).toHaveBeenCalledWith({
			type: "patch-task-metadata",
			key: "id:task-1",
			durationMinutes: 45,
			scopeId: "life",
		});
		expect(events.map((event) => event.kind)).toEqual(["estimate-corrected", "scope-changed"]);
		expect(events[0]).toMatchObject({
			taskSnapshot: {
				text: "Reconcile invoices",
				tags: ["finance"],
				container: "inbox",
			},
		});
		expect(expected).toHaveBeenCalledWith("task-1", {
			duration: 45,
			scope: "life",
		});
		expect(timeline).toEqual([
			"prepare:estimate-corrected",
			"prepare:scope-changed",
			"expect",
			"dispatch",
			"commit:event-1",
			"commit:event-2",
		]);
	});

	it("cancels prepared feedback and the expectation when Markdown is not written", async () => {
		const prepared = new Set<string>();
		const cancelled: string[] = [];
		const cancelExpected = vi.fn();
		const service = new TaskMetadataService({
			dispatcher: {
				ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
				dispatch: async () => ({ ok: false, reason: "write-failed" }),
			} as never,
			history: {
				prepareMutation: async (event: EstimateFeedbackEvent) => {
					prepared.add(event.id);
				},
				commitPrepared: vi.fn(),
				cancelPrepared: async (eventId: string) => {
					prepared.delete(eventId);
					cancelled.push(eventId);
				},
			} as never,
			processor: { process: vi.fn() },
			scopes: () => createScopeCatalog(),
			openSession: async () => undefined,
			expectKnownPatch: () => cancelExpected,
			createId: () => "manual-event",
		});
		await expect(service.applyManualPatch(task(), { durationMinutes: 45 })).resolves.toEqual({
			ok: false,
			reason: "write-failed",
		});
		expect(cancelExpected).toHaveBeenCalledOnce();
		expect(cancelled).toEqual(["manual-event"]);
		expect(prepared.size).toBe(0);
	});

	it("requests unlock and reprocessing for exactly the selected field", async () => {
		const process = vi.fn(async () => ({
			runId: "run-1",
			sessionId: "session-1",
			state: "completed" as const,
			applied: 1,
			skippedLocked: 0,
			failed: [],
			questions: [],
			actualModel: "free-model",
			nextEligibleAt: null,
			feedbackWarnings: 0,
		}));
		const service = new TaskMetadataService({
			dispatcher: {
				ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
			} as never,
			history: {
				provenanceForTask: async () => {
					const fields = Object.fromEntries(
						["duration", "cognitive", "emotional", "physical", "scope"].map((field) => [
							field,
							{
								owner: field === "duration" ? "user" : "ai",
								locked: field === "duration",
								lastPredictionEventId: null,
								updatedAt: "2026-07-28T00:00:00.000Z",
							},
						]),
					);
					return { schemaVersion: 1, taskId: "task-1", fields };
				},
			} as never,
			processor: { process },
			scopes: () =>
				createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
			openSession: async () => undefined,
		});
		await expect(service.unlockFieldAndReprocess(task(), "duration")).resolves.toEqual({
			ok: true,
		});
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			onlyFields: ["duration"],
			unlockFields: ["duration"],
		});
	});

	it("requires a field selection when multiple user-owned fields are locked", async () => {
		const process = vi.fn();
		const service = new TaskMetadataService({
			dispatcher: {
				ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
			} as never,
			history: {
				provenanceForTask: async () => ({
					schemaVersion: 1,
					taskId: "task-1",
					fields: Object.fromEntries(
						["duration", "cognitive", "emotional", "physical", "scope"].map((field) => [
							field,
							{
								owner:
									field === "duration" || field === "cognitive" ? "user" : "ai",
								locked: field === "duration" || field === "cognitive",
								lastPredictionEventId: null,
								updatedAt: "2026-07-28T00:00:00.000Z",
							},
						]),
					),
				}),
			} as never,
			processor: { process },
			scopes: () =>
				createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
			openSession: async () => undefined,
		});
		await expect(service.unlockAndReprocess(task())).resolves.toEqual({
			ok: false,
			reason: "ai-field-selection-required",
		});
		expect(process).not.toHaveBeenCalled();
	});

	it("reports nothing-to-process as a failed reprocessing intent", async () => {
		const process = vi.fn(async () => ({
			runId: null,
			sessionId: null,
			state: "nothing-to-process" as const,
			applied: 0,
			skippedLocked: 0,
			failed: [],
			questions: [],
			actualModel: null,
			nextEligibleAt: null,
			feedbackWarnings: 0,
		}));
		const service = new TaskMetadataService({
			dispatcher: {
				ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
			} as never,
			history: {
				provenanceForTask: async () => ({
					schemaVersion: 1,
					taskId: "task-1",
					fields: Object.fromEntries(
						["duration", "cognitive", "emotional", "physical", "scope"].map((field) => [
							field,
							{
								owner: field === "duration" ? "user" : "ai",
								locked: field === "duration",
								lastPredictionEventId: null,
								updatedAt: "2026-07-28T00:00:00.000Z",
							},
						]),
					),
				}),
			} as never,
			processor: { process },
			scopes: () =>
				createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
			openSession: async () => undefined,
		});
		await expect(service.unlockFieldAndReprocess(task(), "duration")).resolves.toEqual({
			ok: false,
			reason: "ai-reprocessing-nothing-to-process",
		});
	});
});
