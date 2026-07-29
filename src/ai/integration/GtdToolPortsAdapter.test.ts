import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../core/model/Task";
import { GtdToolPortsAdapter } from "./GtdToolPortsAdapter";

function task(overrides: Partial<Task> = {}): Task {
	return {
		key: "id:task-1",
		taskId: "task-1",
		description: "Old",
		filePath: "Inbox.md",
		statusChar: " ",
		due: null,
		scheduled: null,
		start: null,
		created: null,
		done: null,
		cancelled: null,
		dueTime: null,
		scheduledTime: null,
		startTime: null,
		dueTimeEnd: null,
		scheduledTimeEnd: null,
		startTimeEnd: null,
		priority: "none",
		location: null,
		durationMinutes: 30,
		cognitiveIntensity: 2,
		emotionalIntensity: 1,
		physicalIntensity: 0,
		scopeId: "work",
		dependsOn: [],
		...overrides,
	} as unknown as Task;
}

describe("GtdToolPortsAdapter", () => {
	it("updates correlated metadata through one structural intent", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		const cancelExpected = vi.fn();
		const expectAiPatch = vi.fn(() => cancelExpected);
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch, dispatchMany: dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: (id) => id === "life",
			expectAiPatch,
		});
		await adapter.updateTask({
			taskId: "task-1",
			durationMinutes: 45,
			cognitiveIntensity: 3,
			scopeId: "life",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "patch-task-metadata",
			key: "id:task-1",
			durationMinutes: 45,
			cognitiveIntensity: 3,
			scopeId: "life",
		});
		expect(expectAiPatch).toHaveBeenCalledWith("task-1", {
			duration: 45,
			cognitive: 3,
			scope: "life",
		});
		expect(cancelExpected).not.toHaveBeenCalled();
	});

	it("prepares durable AI provenance before a chat metadata write and commits after it", async () => {
		const timeline: string[] = [];
		const commit = vi.fn(async () => {
			timeline.push("commit");
		});
		const cancel = vi.fn(async () => {
			timeline.push("cancel");
		});
		const prepareAiMetadataMutation = vi.fn(async () => {
			timeline.push("prepare");
			return { commit, cancel };
		});
		const expectAiPatch = vi.fn(() => {
			timeline.push("expect");
			return () => timeline.push("cancel-expectation");
		});
		const dispatch = vi.fn(async () => {
			timeline.push("dispatch");
			return { ok: true as const };
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			expectAiPatch,
			prepareAiMetadataMutation,
		});
		const context = { sessionId: "session-1", actualModel: "openrouter/free:test" };

		await adapter.updateTask(
			{ taskId: "task-1", durationMinutes: 45, scopeId: "life" },
			context,
		);

		expect(timeline).toEqual(["prepare", "expect", "dispatch", "commit"]);
		expect(prepareAiMetadataMutation).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "task-1" }),
			{ duration: 45, scope: "life" },
			context,
		);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("cancels prepared chat provenance when metadata writeback fails", async () => {
		const commit = vi.fn(async () => undefined);
		const cancel = vi.fn(async () => undefined);
		const dispatch = vi.fn(async () => ({ ok: false as const, reason: "write-failed" }));
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			prepareAiMetadataMutation: async () => ({ commit, cancel }),
		});

		await expect(
			adapter.updateTask(
				{ taskId: "task-1", durationMinutes: 45 },
				{ sessionId: "session-1", actualModel: "openrouter/free:test" },
			),
		).rejects.toThrow("task-update-failed");
		expect(cancel).toHaveBeenCalledOnce();
		expect(commit).not.toHaveBeenCalled();
	});

	it("cancels prepared provenance and skips writeback when the chat is stopped", async () => {
		const controller = new AbortController();
		const commit = vi.fn(async () => undefined);
		const cancel = vi.fn(async () => undefined);
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			prepareAiMetadataMutation: async () => {
				controller.abort();
				return { commit, cancel };
			},
		});

		await expect(
			adapter.updateTask(
				{ taskId: "task-1", durationMinutes: 45 },
				{
					sessionId: "session-1",
					actualModel: "openrouter/free:test",
					signal: controller.signal,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(commit).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("fails closed before writeback when chat targets a user-locked metadata field", async () => {
		const dispatch = vi.fn();
		const expectAiPatch = vi.fn();
		const assertAiPatchAllowed = vi.fn(async () => {
			throw new Error("task-metadata-locked:duration");
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch, dispatchMany: dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			assertAiPatchAllowed,
			expectAiPatch,
		});

		await expect(
			adapter.updateTask({
				taskId: "task-1",
				text: "Would otherwise change",
				durationMinutes: 45,
			}),
		).rejects.toThrow("task-metadata-locked:duration");
		expect(assertAiPatchAllowed).toHaveBeenCalledWith("task-1", { duration: 45 });
		expect(expectAiPatch).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("preflights every bulk scope target before registering expectations or writing", async () => {
		const dispatch = vi.fn();
		const expectAiPatch = vi.fn();
		const assertAiPatchAllowed = vi.fn(async (taskId: string) => {
			if (taskId === "task-2") throw new Error("task-metadata-locked:scope");
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task(), task({ key: "id:task-2", taskId: "task-2" })],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: (id) => id === "life",
			assertAiPatchAllowed,
			expectAiPatch,
		});

		await expect(
			adapter.bulkUpdateTasks({ taskIds: ["task-1", "task-2"], scopeId: "life" }),
		).rejects.toThrow("task-metadata-locked:scope");
		expect(assertAiPatchAllowed).toHaveBeenNthCalledWith(1, "task-1", { scope: "life" });
		expect(assertAiPatchAllowed).toHaveBeenNthCalledWith(2, "task-2", { scope: "life" });
		expect(expectAiPatch).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("keeps bulk expectations only for acknowledged writes and cancels the rest", async () => {
		const timeline: string[] = [];
		const cancelFor = (taskId: string) => () => timeline.push(`cancel:${taskId}`);
		const expectAiPatch = vi.fn((taskId: string) => {
			timeline.push(`expect:${taskId}`);
			return cancelFor(taskId);
		});
		const dispatch = vi.fn(async () => {
			const call = `dispatch:${String(dispatch.mock.calls.length)}`;
			timeline.push(call);
			return dispatch.mock.calls.length === 2
				? { ok: false as const, reason: "write-failed" }
				: { ok: true as const };
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [
				task(),
				task({ key: "id:task-2", taskId: "task-2" }),
				task({ key: "id:task-3", taskId: "task-3" }),
			],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			assertAiPatchAllowed: async (taskId) => {
				timeline.push(`guard:${taskId}`);
			},
			expectAiPatch,
		});

		await expect(
			adapter.bulkUpdateTasks({ taskIds: ["task-1", "task-2", "task-3"], scopeId: "life" }),
		).resolves.toEqual({
			value: {
				results: [
					{ taskId: "task-1", ok: true },
					{ taskId: "task-2", ok: false },
				],
			},
		});
		expect(timeline).toEqual([
			"guard:task-1",
			"guard:task-2",
			"guard:task-3",
			"expect:task-1",
			"expect:task-2",
			"expect:task-3",
			"dispatch:1",
			"dispatch:2",
			"cancel:task-2",
			"cancel:task-3",
		]);
	});

	it.each([
		[
			"update",
			(adapter: GtdToolPortsAdapter) => adapter.updateTask({ taskId: "task-1", text: "New" }),
		],
		[
			"move",
			(adapter: GtdToolPortsAdapter) =>
				adapter.moveTask({ taskId: "task-1", toFile: "Later.md" }),
		],
		["delete", (adapter: GtdToolPortsAdapter) => adapter.deleteTask({ taskId: "task-1" })],
		[
			"bulk scope update",
			(adapter: GtdToolPortsAdapter) =>
				adapter.bulkUpdateTasks({ taskIds: ["task-1"], scopeId: "life" }),
		],
	] as const)("fails closed for duplicate task IDs before %s mutation", async (_name, mutate) => {
		const dispatch = vi.fn();
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: { ensureFile: vi.fn() } as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task(), task({ key: "Inbox.md#1", filePath: "Other.md" })],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
		});

		await expect(mutate(adapter)).rejects.toThrow("task-id-ambiguous");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("registers ownership expectations before metadata writeback and cancels known failures", async () => {
		const timeline: string[] = [];
		const cancelExpected = vi.fn(() => timeline.push("cancel"));
		const expectAiPatch = vi.fn(() => {
			timeline.push("expect");
			return cancelExpected;
		});
		const dispatch = vi.fn(async () => {
			timeline.push("dispatch");
			return { ok: false as const, reason: "write-failed" };
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			expectAiPatch,
		});

		await expect(
			adapter.updateTask({
				taskId: "task-1",
				durationMinutes: null,
				cognitiveIntensity: 5,
				emotionalIntensity: 0,
				physicalIntensity: 2,
				scopeId: null,
			}),
		).rejects.toThrow("task-update-failed");
		expect(timeline).toEqual(["expect", "dispatch", "cancel"]);
		expect(expectAiPatch).toHaveBeenCalledWith("task-1", {
			duration: null,
			cognitive: 5,
			emotional: 0,
			physical: 2,
			scope: null,
		});
	});

	it("rejects scope IDs outside the active catalog before writeback", async () => {
		const dispatch = vi.fn();
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => false,
		});
		await expect(adapter.updateTask({ taskId: "task-1", scopeId: "unknown" })).rejects.toThrow(
			"scope-not-active",
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("undoes a task update only while the AI-applied values are still current", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		let source = "- [ ] Changed ⏱ 45m 🧠 3 💓 1 💪 0 🧭 life 🆔 task-1\n";
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: { readFile: async () => source } as never,
			dispatcher: { dispatch, dispatchMany: dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
		});

		const result = await adapter.updateTask({
			taskId: "task-1",
			text: "Changed",
			durationMinutes: 45,
			cognitiveIntensity: 3,
			scopeId: "life",
		});
		await result.undo();
		expect(dispatch).toHaveBeenCalledTimes(2);

		const conflicted = await adapter.updateTask({
			taskId: "task-1",
			durationMinutes: 45,
		});
		source = "- [ ] User changed it ⏱ 60m 🧠 3 💓 1 💪 0 🧭 life 🆔 task-1\n";
		await expect(conflicted.undo()).rejects.toThrow("task-undo-conflict");
		expect(dispatch).toHaveBeenCalledTimes(3);
	});

	it("deletes only an existing non-reserved vault file", async () => {
		const file = { path: "Attachments/archive.zip" };
		const deleteFile = vi.fn(async () => undefined);
		const adapter = new GtdToolPortsAdapter({
			app: {
				vault: {
					getFileByPath: (path: string) => (path === file.path ? file : null),
					delete: deleteFile,
				},
			} as never,
			vault: {} as never,
			dispatcher: {} as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
		});

		await expect(adapter.deleteFile({ path: file.path })).resolves.toEqual({
			value: { path: file.path, deleted: true },
		});
		expect(deleteFile).toHaveBeenCalledWith(file, true);
		await expect(adapter.deleteFile({ path: ".gtd-flow/ai/run.json" })).rejects.toThrow(
			"vault-file-path-rejected",
		);
		expect(deleteFile).toHaveBeenCalledTimes(1);
	});

	it("updates ordinary task fields atomically and restores them with guarded undo", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		const dispatchMany = vi.fn(async () => ({ ok: true as const }));
		const source = "- [x] Old 📅 2026-08-01 09:00-10:00 ✅ 2026-07-28 🔺 📍 Office 🆔 task-1\n";
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: { readFile: async () => source } as never,
			dispatcher: { dispatch, dispatchMany } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			todayIso: () => "2026-07-28",
		});

		const result = await adapter.updateTask({
			taskId: "task-1",
			status: "done",
			due: "2026-08-01 09:00-10:00",
			scheduled: null,
			priority: "highest",
			location: " Office ",
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(dispatchMany).toHaveBeenNthCalledWith(1, [
			{
				type: "set-date",
				key: "id:task-1",
				field: "due",
				date: "2026-08-01",
				time: "09:00",
				timeEnd: "10:00",
			},
			{ type: "set-date", key: "id:task-1", field: "scheduled", date: null },
			{ type: "set-priority", key: "id:task-1", priority: "highest" },
			{ type: "set-location", key: "id:task-1", location: "Office" },
			{
				type: "set-status",
				key: "id:task-1",
				statusChar: "x",
				date: "2026-07-28",
			},
		]);

		await result.undo();
		expect(dispatchMany).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([
				{
					type: "set-date",
					key: "id:task-1",
					field: "due",
					date: null,
					time: null,
					timeEnd: null,
				},
				{ type: "set-priority", key: "id:task-1", priority: "none" },
				{ type: "set-location", key: "id:task-1", location: null },
				{ type: "set-status", key: "id:task-1", statusChar: " " },
			]),
		);
	});

	it("undoes a created task only while its generated line is unchanged", async () => {
		let content = "";
		const processFile = vi.fn(
			async (_path: string, transform: (current: string) => string | null) => {
				const next = transform(content);
				if (next === null || next === content) return false;
				content = next;
				return true;
			},
		);
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: { processFile } as never,
			dispatcher: {} as never,
			allTasks: () => [],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			createTaskId: () => "created-1",
		});

		const created = await adapter.createTask({ text: "New task", inbox: true });
		expect(content).toBe("- [ ] New task 🆔 created-1\n");
		await created.undo();
		expect(content).toBe("");

		const edited = await adapter.createTask({ text: "New task", inbox: true });
		content = content.replace("New task", "User changed task");
		await expect(edited.undo()).rejects.toThrow("task-create-undo-conflict");
		expect(content).toContain("User changed task");
	});

	it("undoes a task move only while the task remains in the AI-selected file", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		let destination = "- [ ] Old 🆔 task-1\n";
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {
				ensureFile: async () => undefined,
				readFile: async (path: string) => (path === "Later.md" ? destination : null),
			} as never,
			dispatcher: { dispatch } as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
		});

		const moved = await adapter.moveTask({ taskId: "task-1", toFile: "Later.md" });
		await moved.undo();
		expect(dispatch).toHaveBeenNthCalledWith(2, {
			type: "move-line",
			key: "id:task-1",
			toFile: "Inbox.md",
		});

		const conflicted = await adapter.moveTask({ taskId: "task-1", toFile: "Later.md" });
		destination = "";
		await expect(conflicted.undo()).rejects.toThrow("task-move-undo-conflict");
		expect(dispatch).toHaveBeenCalledTimes(3);
	});

	it("returns bounded task relationships without exposing internal services", async () => {
		const related = {
			...task(),
			key: "id:dependent",
			taskId: "dependent",
			description: "Depends on task one",
			dependsOn: ["task-1"],
		} as Task;
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: {} as never,
			allTasks: () => [task(), related],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
		});
		await expect(adapter.getTaskRelationships("task-1")).resolves.toMatchObject({
			taskId: "task-1",
			dependents: [
				{
					taskId: "dependent",
					description: "Depends on task one",
					filePath: "Inbox.md",
				},
			],
		});
	});

	it("undoes a newly connected dependency but preserves a pre-existing edge", async () => {
		let edges: Array<{ from: string; to: string }> = [];
		const connect = vi.fn(async (_path: string, from: string, to: string) => {
			if (!edges.some((edge) => edge.from === from && edge.to === to))
				edges = [...edges, { from, to }];
			return { ok: true as const };
		});
		const disconnect = vi.fn(async (_path: string, from: string, to: string) => {
			edges = edges.filter((edge) => edge.from !== from || edge.to !== to);
			return { ok: true as const };
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: {} as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			projects: {
				discoverProjects: () => [],
				model: () => ({ edges }) as never,
				connect,
				disconnect,
				setProjectStatus: vi.fn(),
				deleteNode: vi.fn(),
				createProject: vi.fn(),
			},
		});

		const first = await adapter.connectDependency({
			projectPath: "Projects/P.md",
			prerequisiteTaskId: "task-1",
			dependentTaskId: "task-2",
		});
		expect(edges).toEqual([{ from: "task-1", to: "task-2" }]);
		await first.undo();
		expect(edges).toEqual([]);

		edges = [{ from: "task-1", to: "task-2" }];
		const existing = await adapter.connectDependency({
			projectPath: "Projects/P.md",
			prerequisiteTaskId: "task-1",
			dependentTaskId: "task-2",
		});
		await existing.undo();
		expect(edges).toEqual([{ from: "task-1", to: "task-2" }]);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it("sets project status with conflict-aware undo", async () => {
		let status: "active" | "on-hold" | "done" | "archived" = "active";
		const setProjectStatus = vi.fn(async (_path: string, next: typeof status) => {
			status = next;
		});
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: {} as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			projects: {
				discoverProjects: () => [
					{
						path: "Projects/P.md",
						name: "P",
						status,
						complete: false,
						stalled: false,
					},
				],
				model: () => null,
				connect: vi.fn(),
				disconnect: vi.fn(),
				setProjectStatus,
				deleteNode: vi.fn(),
				createProject: vi.fn(),
			},
		});

		const result = await adapter.setProjectStatus({
			projectPath: "Projects/P.md",
			status: "on-hold",
		});
		expect(status).toBe("on-hold");
		await result.undo();
		expect(status).toBe("active");
		expect(setProjectStatus).toHaveBeenNthCalledWith(1, "Projects/P.md", "on-hold");
		expect(setProjectStatus).toHaveBeenNthCalledWith(2, "Projects/P.md", "active");
	});

	it("moves a uniquely identified board task and restores its original column and orders", async () => {
		const first = task();
		const earlier = {
			...task(),
			key: "id:task-0",
			taskId: "task-0",
			description: "Earlier",
		} as Task;
		const doing = {
			...task(),
			key: "id:task-2",
			taskId: "task-2",
			description: "Doing",
		} as Task;
		const tasks = [earlier, first, doing];
		const membership = new Map<string, string>([
			[first.key, "todo"],
			[earlier.key, "todo"],
			[doing.key, "doing"],
		]);
		const order: Record<string, string[]> = {
			todo: ["task-0", "task-1"],
			doing: ["task-2"],
		};
		const def = {
			id: "board-1",
			name: "Board",
			groupBy: "tag" as const,
			columns: [
				{ id: "todo", name: "Todo", match: "#kanban/board-1/todo" },
				{ id: "doing", name: "Doing", match: "#kanban/board-1/doing" },
			],
			skippedColumns: [],
			order,
		};
		const discoverBoards = () => ({
			boards: [{ path: "Boards/B.md", def }],
			errors: [],
		});
		const boardModel = () => ({
			path: "Boards/B.md",
			def,
			columns: def.columns.map((column) => ({
				...column,
				tasks: tasks.filter((candidate) => membership.get(candidate.key) === column.id),
			})),
		});
		const moveCard = vi.fn(
			async (
				_boardPath: string,
				_def: typeof def,
				taskKey: string,
				toColumnId: string,
				insertIndex: number,
			) => {
				membership.set(taskKey, toColumnId);
				const moved = tasks.find((candidate) => candidate.key === taskKey)!;
				const current = def.order[toColumnId] ?? [];
				const withoutMoved = current.filter((id) => id !== moved.taskId);
				withoutMoved.splice(insertIndex, 0, moved.taskId!);
				def.order[toColumnId] = withoutMoved;
				return { ok: true as const };
			},
		);
		const reorderCard = vi.fn(
			async (_path: string, columnId: string, orderedIds: readonly string[]) => {
				def.order[columnId] = [...orderedIds];
			},
		);
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: {} as never,
			allTasks: () => tasks,
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			boards: {
				discoverBoards,
				boardModel,
				moveCard,
				reorderCard,
				renameBoard: vi.fn(),
				renameColumn: vi.fn(),
				moveColumn: vi.fn(),
				deleteColumn: vi.fn(),
				createBoard: vi.fn(),
			},
		});

		const result = await adapter.moveBoardTask({
			boardPath: "Boards/B.md",
			taskId: "task-1",
			toColumnId: "doing",
			toIndex: 1,
		});
		expect(membership.get(first.key)).toBe("doing");
		await result.undo();

		expect(membership.get(first.key)).toBe("todo");
		expect(moveCard).toHaveBeenNthCalledWith(
			1,
			"Boards/B.md",
			expect.anything(),
			"id:task-1",
			"doing",
			1,
		);
		expect(moveCard).toHaveBeenNthCalledWith(
			2,
			"Boards/B.md",
			expect.anything(),
			"id:task-1",
			"todo",
			1,
		);
		expect(reorderCard).toHaveBeenCalledWith("Boards/B.md", "todo", ["task-0", "task-1"]);
		expect(reorderCard).toHaveBeenCalledWith("Boards/B.md", "doing", ["task-2"]);

		moveCard.mockClear();
		reorderCard.mockClear();
		const withinColumn = await adapter.moveBoardTask({
			boardPath: "Boards/B.md",
			taskId: "task-1",
			toColumnId: "todo",
			toIndex: 0,
		});
		await withinColumn.undo();
		expect(moveCard).toHaveBeenCalledTimes(1);
		expect(reorderCard).toHaveBeenCalledTimes(1);
		expect(reorderCard).toHaveBeenCalledWith("Boards/B.md", "todo", ["task-0", "task-1"]);
	});

	it("refuses a board move when the task has no unique board location to restore", async () => {
		const moveCard = vi.fn();
		const def = {
			id: "board-1",
			name: "Board",
			groupBy: "tag" as const,
			columns: [
				{ id: "todo", name: "Todo", match: "#kanban/board-1/todo" },
				{ id: "doing", name: "Doing", match: "#kanban/board-1/doing" },
			],
			skippedColumns: [],
			order: {},
		};
		const adapter = new GtdToolPortsAdapter({
			app: {} as never,
			vault: {} as never,
			dispatcher: {} as never,
			allTasks: () => [task()],
			inboxFile: () => "Inbox.md",
			ensureInbox: async () => undefined,
			isActiveScope: () => true,
			boards: {
				discoverBoards: () => ({
					boards: [{ path: "Boards/B.md", def }],
					errors: [],
				}),
				boardModel: () => ({
					path: "Boards/B.md",
					def,
					columns: def.columns.map((column) => ({ ...column, tasks: [] })),
				}),
				moveCard,
				reorderCard: vi.fn(),
				renameBoard: vi.fn(),
				renameColumn: vi.fn(),
				moveColumn: vi.fn(),
				deleteColumn: vi.fn(),
				createBoard: vi.fn(),
			},
		});

		await expect(
			adapter.moveBoardTask({
				boardPath: "Boards/B.md",
				taskId: "task-1",
				toColumnId: "doing",
				toIndex: 0,
			}),
		).rejects.toThrow("board-task-safe-inverse-unavailable");
		expect(moveCard).not.toHaveBeenCalled();
	});
});
