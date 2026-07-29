import { describe, expect, it } from "vitest";
import type { Task } from "../core/model/Task";
import { FieldOwnershipMonitor } from "./FieldOwnershipMonitor";

function task(overrides: Partial<Task> = {}): Task {
	return {
		taskId: "task-1",
		durationMinutes: 30,
		cognitiveIntensity: 2,
		emotionalIntensity: 1,
		physicalIntensity: 0,
		scopeId: "work",
		...overrides,
	} as Task;
}

describe("FieldOwnershipMonitor", () => {
	it("classifies unproven raw Markdown changes as user edits", async () => {
		const edits: unknown[] = [];
		const monitor = new FieldOwnershipMonitor(async (edit) => void edits.push(edit));
		monitor.observe([task()]);
		monitor.observe([task({ durationMinutes: null, scopeId: "life" })]);
		await monitor.drain();
		expect(edits).toMatchObject([
			{ field: "duration", previousValue: 30, value: null },
			{ field: "scope", previousValue: "work", value: "life" },
		]);
	});

	it("consumes exact registered AI mutations without creating locks", async () => {
		const edits: unknown[] = [];
		const monitor = new FieldOwnershipMonitor(async (edit) => void edits.push(edit));
		monitor.observe([task()]);
		monitor.expectAiPatch("task-1", { duration: 45, cognitive: 3 });
		monitor.observe([task({ durationMinutes: 45, cognitiveIntensity: 3 })]);
		await monitor.drain();
		expect(edits).toEqual([]);
	});

	it("does not let a mismatched or expired expectation mask a user correction", async () => {
		const edits: unknown[] = [];
		let now = 0;
		const monitor = new FieldOwnershipMonitor(
			async (edit) => void edits.push(edit),
			() => now,
		);
		monitor.observe([task()]);
		monitor.expectAiPatch("task-1", { duration: 45 }, 10);
		now = 11;
		monitor.observe([task({ durationMinutes: 60 })]);
		await monitor.drain();
		expect(edits).toMatchObject([{ field: "duration", value: 60 }]);
	});

	it("cancels a known-failed mutation without removing a newer expectation", async () => {
		const edits: unknown[] = [];
		const monitor = new FieldOwnershipMonitor(async (edit) => void edits.push(edit));
		monitor.observe([task()]);
		const cancelFailed = monitor.expectAiPatch("task-1", { duration: 45 });
		monitor.expectAiPatch("task-1", { duration: 60 });
		cancelFailed();
		monitor.observe([task({ durationMinutes: 60 })]);
		await monitor.drain();
		expect(edits).toEqual([]);

		const cancelCurrent = monitor.expectAiPatch("task-1", { duration: 75 });
		cancelCurrent();
		monitor.observe([task({ durationMinutes: 75 })]);
		await monitor.drain();
		expect(edits).toMatchObject([{ field: "duration", value: 75 }]);
	});

	it("ignores title-only changes", async () => {
		const edits: unknown[] = [];
		const monitor = new FieldOwnershipMonitor(async (edit) => void edits.push(edit));
		monitor.observe([task({ description: "Before" })]);
		monitor.observe([task({ description: "After" })]);
		await monitor.drain();
		expect(edits).toEqual([]);
	});

	it("continues classifying later edits after one persistence callback fails", async () => {
		const edits: string[] = [];
		let failFirst = true;
		const monitor = new FieldOwnershipMonitor(async (edit) => {
			if (failFirst) {
				failFirst = false;
				throw new Error("feedback-unavailable");
			}
			edits.push(edit.field);
		});
		monitor.observe([task()]);
		monitor.observe([task({ durationMinutes: 45, scopeId: "life" })]);
		await expect(monitor.drain()).rejects.toThrow("feedback-unavailable");
		expect(edits).toEqual(["scope"]);

		monitor.observe([task({ durationMinutes: 45, scopeId: "other" })]);
		await expect(monitor.drain()).resolves.toBeUndefined();
		expect(edits).toEqual(["scope", "scope"]);
	});
});
