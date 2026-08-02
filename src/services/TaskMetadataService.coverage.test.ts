import { describe, expect, it } from "vitest";
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
		} as never,
		scopes: () => createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
		durationLongStyle: () => "whole-days",
		now: () => new Date("2026-07-28T00:00:00.000Z"),
		createId: () => "event-1",
		...overrides,
	};
}

describe("TaskMetadataService failure and recovery outcomes", () => {
	it("exposes immutable UI snapshots without a desktop AI capability", () => {
		const service = new TaskMetadataService(options());
		const catalog = service.scopes();
		catalog.scopes[0]!.name = "caller mutation";
		expect(service.scopeName("work")).toBe("Work");
		expect(service.scopeName("missing")).toBeNull();
		expect(service.durationLongStyle()).toBe("whole-days");
		expect(service.openRelatedAiRun).toBeUndefined();
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

	it("fails closed for anchor and feedback preparation failures", async () => {
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
	});
});
