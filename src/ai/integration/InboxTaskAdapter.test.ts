import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../core/model/Task";
import { InboxTaskAdapter } from "./InboxTaskAdapter";

function task(filePath: string, statusChar = " "): Task {
	return { key: `${filePath}:${statusChar}`, filePath, statusChar } as Task;
}

describe("InboxTaskAdapter", () => {
	it("processes only active tasks in the one configured inbox", () => {
		const adapter = new InboxTaskAdapter({
			allTasks: () => [
				task("GTD/Inbox.md"),
				task("GTD/Inbox.md", "x"),
				task("Legacy/Inbox.md"),
			],
			inboxFile: () => "GTD/Inbox.md",
			dispatcher: {} as never,
		});
		expect(adapter.listInboxTasks()).toEqual([task("GTD/Inbox.md")]);
	});

	it("resolves explicit task keys from the whole index, preserving request order", () => {
		const inbox = task("GTD/Inbox.md");
		const outsideInbox = task("Projects/Launch.md");
		const completed = task("Archive/Done.md", "x");
		const adapter = new InboxTaskAdapter({
			allTasks: () => [inbox, outsideInbox, completed],
			inboxFile: () => "GTD/Inbox.md",
			dispatcher: {} as never,
		});
		expect(
			adapter.listTasksByKeys([completed.key, outsideInbox.key, "missing", completed.key]),
		).toEqual([completed, outsideInbox]);
	});

	it("uses the atomic metadata intent", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		const adapter = new InboxTaskAdapter({
			allTasks: () => [],
			inboxFile: () => "Inbox.md",
			dispatcher: { dispatch } as never,
		});
		await adapter.applyMetadata("id:task-1", {
			durationMinutes: 30,
			cognitiveIntensity: 2,
			emotionalIntensity: 1,
			physicalIntensity: 0,
			scopeId: "work",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "patch-task-metadata",
			key: "id:task-1",
			durationMinutes: 30,
			cognitiveIntensity: 2,
			emotionalIntensity: 1,
			physicalIntensity: 0,
			scopeId: "work",
		});
	});

	it("registers the expected patch before dispatch and cancels a known failure", async () => {
		const timeline: string[] = [];
		const cancel = vi.fn(() => timeline.push("cancel"));
		const expectAiPatch = vi.fn(() => {
			timeline.push("expect");
			return cancel;
		});
		const dispatch = vi.fn(async () => {
			timeline.push("dispatch");
			return { ok: false as const, reason: "write-failed" };
		});
		const adapter = new InboxTaskAdapter({
			allTasks: () => [],
			inboxFile: () => "Inbox.md",
			dispatcher: { dispatch } as never,
			expectAiPatch,
		});
		await expect(
			adapter.applyMetadata("stale-location-key", { durationMinutes: 45 }, "anchored-task"),
		).resolves.toEqual({ ok: false, reason: "write-failed" });
		expect(timeline).toEqual(["expect", "dispatch", "cancel"]);
		expect(expectAiPatch).toHaveBeenCalledWith("anchored-task", {
			duration: 45,
		});
	});
});
