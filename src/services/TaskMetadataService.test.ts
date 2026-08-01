import { describe, expect, it, vi } from "vitest";
import type { Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { createScopeCatalog } from "../core/scope/scope";
import { FakeFeed } from "../stores/testSupport";
import type { EstimateFeedbackEvent } from "./EstimateFeedbackService";
import { TaskMetadataService } from "./TaskMetadataService";
import { WritebackService, type WritePort } from "./WritebackService";

function parseTask(line: string, filePath = "GTD/Inbox.md", lineStart = 0): Task {
	const parsed = parseTaskLine(line, {
		filePath,
		lineStart,
		parentLine: null,
		heading: "Admin",
		container: "inbox",
		projectActive: true,
	});
	if (parsed === null) throw new Error(`not a task: ${line}`);
	return parsed;
}

function task(): Task {
	return parseTask("- [ ] Reconcile invoices #finance ⏱ 30m 🧠 2 💓 1 💪 0 🧭 work 🆔 task-1");
}

class MemoryWritePort implements WritePort {
	readonly files = new Map<string, string>();
	readonly writes: string[] = [];

	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		const content = this.files.get(path);
		if (content === undefined) return false;
		const next = transform(content);
		if (next === null || next === content) return false;
		this.files.set(path, next);
		this.writes.push(next);
		return true;
	}
}

function indexContent(feed: FakeFeed, path: string, content: string): void {
	const tasks: Task[] = [];
	for (const [lineStart, line] of content.split("\n").entries()) {
		const parsed = parseTaskLine(line, {
			filePath: path,
			lineStart,
			parentLine: null,
			heading: null,
			container: "inbox",
			projectActive: true,
		});
		if (parsed !== null) tasks.push(parsed);
	}
	feed.replaceFile(path, tasks);
}

describe("TaskMetadataService", () => {
	it("writes one atomic patch and records each user-owned field", async () => {
		const events: EstimateFeedbackEvent[] = [];
		const prepared = new Map<string, EstimateFeedbackEvent>();
		const timeline: string[] = [];
		const dispatchMany = vi.fn(async () => {
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
				dispatchMany,
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
			scopes: () =>
				createScopeCatalog([{ id: "life", name: "Life", order: 0, archived: false }]),
			openSession: async () => undefined,
			expectKnownPatch: expected,
			createId: () => `event-${++id}`,
			now: () => new Date("2026-07-28T00:00:00.000Z"),
		});
		await expect(
			service.applyManualUpdate(
				task(),
				[
					{
						type: "set-text",
						key: "id:task-1",
						text: "Reconcile paid invoices #paid",
					},
				],
				{ durationMinutes: 45, scopeId: "life" },
			),
		).resolves.toEqual({ ok: true });
		expect(dispatchMany).toHaveBeenCalledOnce();
		expect(dispatchMany).toHaveBeenCalledWith([
			{
				type: "set-text",
				key: "id:task-1",
				text: "Reconcile paid invoices #paid",
			},
			{
				type: "patch-task-metadata",
				key: "id:task-1",
				durationMinutes: 45,
				scopeId: "life",
			},
		]);
		expect(events.map((event) => event.kind)).toEqual(["estimate-corrected", "scope-changed"]);
		expect(events[0]).toMatchObject({
			taskSnapshot: {
				text: "Reconcile paid invoices #paid",
				tags: ["#paid"],
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

	it("does not run feedback snapshot preflight for an ordinary-only edit", async () => {
		const ensureTaskId = vi.fn();
		const prepareMutation = vi.fn();
		const dispatchMany = vi.fn(async () => ({ ok: true as const }));
		const service = new TaskMetadataService({
			dispatcher: { ensureTaskId, dispatchMany } as never,
			history: { prepareMutation } as never,
			processor: { process: vi.fn() },
			scopes: () => createScopeCatalog(),
			openSession: async () => undefined,
		});
		const intent = {
			type: "set-text" as const,
			key: "id:task-1",
			text: "The dispatcher validates 📅 field-looking text",
		};

		await expect(service.applyManualUpdate(task(), [intent], {})).resolves.toEqual({
			ok: true,
		});

		expect(ensureTaskId).not.toHaveBeenCalled();
		expect(prepareMutation).not.toHaveBeenCalled();
		expect(dispatchMany).toHaveBeenCalledWith([intent]);
	});

	it("rejects a scope archived after the UI snapshot before feedback or Markdown writes", async () => {
		let catalog = createScopeCatalog([{ id: "life", name: "Life", order: 0, archived: false }]);
		const ensureTaskId = vi.fn(async () => ({ ok: true as const, taskId: "task-1" }));
		const dispatchMany = vi.fn(async () => ({ ok: true as const }));
		const prepareMutation = vi.fn();
		const service = new TaskMetadataService({
			dispatcher: { ensureTaskId, dispatchMany } as never,
			history: { prepareMutation } as never,
			processor: { process: vi.fn() },
			scopes: () => catalog,
			openSession: async () => undefined,
		});
		const uiSnapshot = service.scopes();
		expect(uiSnapshot.scopes[0]?.archived).toBe(false);
		catalog = createScopeCatalog([{ ...uiSnapshot.scopes[0]!, archived: true }]);

		await expect(service.applyManualPatch(task(), { scopeId: "life" })).resolves.toEqual({
			ok: false,
			reason: "scope-not-active",
		});

		expect(ensureTaskId).not.toHaveBeenCalled();
		expect(prepareMutation).not.toHaveBeenCalled();
		expect(dispatchMany).not.toHaveBeenCalled();
	});

	it("retries an id-less edit by its stable id after reindexing catches up", async () => {
		const path = "GTD/Inbox.md";
		const initial = "intro\r\n- [ ] Original #old ⏫ ^block\r\nend\r\n";
		const port = new MemoryWritePort();
		const feed = new FakeFeed();
		port.files.set(path, initial);
		indexContent(feed, path, initial);
		const original = feed.getIndex().fileTasks(path)[0]!;
		const writeback = new WritebackService({
			write: port,
			feed,
			autoInjectId: false,
			genId: () => "stable1",
		});
		const dispatchMany = vi.spyOn(writeback, "dispatchMany");
		const prepared: EstimateFeedbackEvent[] = [];
		let reindexed = false;
		let eventId = 0;
		const service = new TaskMetadataService({
			dispatcher: writeback,
			history: {
				prepareMutation: async (event: EstimateFeedbackEvent) => {
					prepared.push(event);
					if (!reindexed) {
						reindexed = true;
						indexContent(feed, path, port.files.get(path)!);
					}
				},
				commitPrepared: async () => undefined,
				cancelPrepared: async () => undefined,
			} as never,
			processor: { process: vi.fn() },
			scopes: () =>
				createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
			openSession: async () => undefined,
			createId: () => `event-${++eventId}`,
		});

		await expect(
			service.applyManualUpdate(
				original,
				[
					{ type: "set-text", key: original.key, text: "Renamed #new" },
					{
						type: "set-date",
						key: original.key,
						field: "due",
						date: "2026-08-04",
					},
				],
				{ durationMinutes: 45, cognitiveIntensity: 4, scopeId: "work" },
			),
		).resolves.toEqual({ ok: true });

		expect(dispatchMany).toHaveBeenCalledTimes(2);
		expect(dispatchMany.mock.calls[0]![0].every((intent) => intent.key === original.key)).toBe(
			true,
		);
		expect(dispatchMany.mock.calls[1]![0].every((intent) => intent.key === "id:stable1")).toBe(
			true,
		);
		expect(port.writes).toHaveLength(2);
		const finalContent = port.files.get(path)!;
		const finalLine = finalContent.split("\n").find((line) => line.includes("stable1"))!;
		const saved = parseTask(finalLine, path, 1);
		expect(saved).toMatchObject({
			taskId: "stable1",
			description: "Renamed #new",
			tags: ["#new"],
			due: "2026-08-04",
			durationMinutes: 45,
			cognitiveIntensity: 4,
			scopeId: "work",
			priority: "high",
		});
		expect(finalLine).toContain("^block\r");
		expect(finalContent).toContain("intro\r\n");
		expect(finalContent).toContain("\r\nend\r\n");
		expect(prepared).toHaveLength(3);
		expect(prepared[0]).toMatchObject({
			taskSnapshot: { text: "Renamed #new", tags: ["#new"] },
		});
	});

	it.each(["write-failed", "transform-failed", "stale-index", "line-not-found"])(
		"does not retry an id-less edit after %s",
		async (reason) => {
			const dispatchMany = vi.fn(async () => ({ ok: false as const, reason, opIndex: -1 }));
			const service = new TaskMetadataService({
				dispatcher: {
					ensureTaskId: async () => ({ ok: true as const, taskId: "stable1" }),
					dispatchMany,
				} as never,
				history: {
					prepareMutation: async () => undefined,
					commitPrepared: async () => undefined,
					cancelPrepared: async () => undefined,
				} as never,
				processor: { process: vi.fn() },
				scopes: () => createScopeCatalog(),
				openSession: async () => undefined,
				createId: () => "event-1",
			});
			const idless = parseTask("- [ ] Id-less task ⏱ 30m");

			await expect(
				service.applyManualPatch(idless, { durationMinutes: 45 }),
			).resolves.toEqual({ ok: false, reason });
			expect(dispatchMany).toHaveBeenCalledOnce();
		},
	);

	it("cancels prepared feedback and the expectation when Markdown is not written", async () => {
		const prepared = new Set<string>();
		const cancelled: string[] = [];
		const cancelExpected = vi.fn();
		const service = new TaskMetadataService({
			dispatcher: {
				ensureTaskId: async () => ({ ok: true, taskId: "task-1" }),
				dispatchMany: async () => ({ ok: false, reason: "write-failed", opIndex: 0 }),
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
