import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./ToolRegistry";
import { createGtdToolRegistry, isVaultRelativePath } from "./gtdTools";
import { permissionForRisk } from "./permissionPolicy";

describe("ToolRegistry permission boundary", () => {
	it("executes validated reads automatically", async () => {
		const registry = new ToolRegistry(() => "id-1");
		const execute = vi.fn(async ({ query }: { query: string }) => ({ value: { query } }));
		registry.register({
			name: "search_notes",
			description: "Search",
			parameters: { type: "object" },
			schema: z.object({ query: z.string() }).strict(),
			risk: "read",
			execute,
		});
		await expect(
			registry.handle({ id: "call-1", name: "search_notes", arguments: { query: "x" } }),
		).resolves.toMatchObject({ status: "completed", result: { query: "x" } });
		expect(execute).toHaveBeenCalledOnce();
	});

	it("rejects malformed calls before invoking application code", async () => {
		const registry = new ToolRegistry();
		const execute = vi.fn(async () => ({ value: null }));
		registry.register({
			name: "read_note",
			description: "Read",
			parameters: { type: "object" },
			schema: z.object({ path: z.string() }).strict(),
			risk: "read",
			execute,
		});
		await expect(
			registry.handle({
				id: "call-1",
				name: "read_note",
				arguments: { path: "Note.md", extra: "prompt-injection" },
			}),
		).resolves.toMatchObject({ status: "rejected", reason: "invalid-arguments" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects invalid runtime risk metadata and otherwise fails closed", () => {
		const registry = new ToolRegistry();
		expect(() =>
			registry.register({
				name: "future_write",
				description: "A future permission tier",
				parameters: { type: "object" },
				schema: z.object({}).strict(),
				risk: "future-write" as never,
				execute: async () => ({ value: null }),
			}),
		).toThrow("invalid-tool-risk");
		expect(permissionForRisk("future-write" as never)).toBe("require-approval");
	});

	it("freezes destructive calls behind explicit approval", async () => {
		let ids = 0;
		const registry = new ToolRegistry(() => `id-${++ids}`);
		const execute = vi.fn(async ({ id }: { id: string }) => ({ value: id }));
		registry.register({
			name: "delete_task",
			description: "Delete",
			parameters: { type: "object" },
			schema: z.object({ id: z.string() }).strict(),
			risk: "destructive-or-bulk",
			preview: ({ id }) => `Delete ${id}`,
			execute,
		});
		const proposed = await registry.handle({
			id: "call-1",
			name: "delete_task",
			arguments: { id: "task-1" },
		});
		expect(proposed).toMatchObject({
			status: "approval-required",
			preview: "Delete task-1",
		});
		expect(execute).not.toHaveBeenCalled();
		if (proposed.status !== "approval-required") throw new Error("fixture failed");
		await registry.approve(proposed.approvalId);
		expect(execute).toHaveBeenCalledWith({ id: "task-1" });
	});

	it("retains trusted execution context across a destructive approval", async () => {
		const registry = new ToolRegistry(() => "approval-1");
		const execute = vi.fn(async () => ({ value: "ok" }));
		registry.register({
			name: "delete_task",
			description: "Delete",
			parameters: { type: "object" },
			schema: z.object({ id: z.string() }).strict(),
			risk: "destructive-or-bulk",
			execute,
		});
		const context = { sessionId: "session-1", actualModel: "openrouter/free:test" };
		const proposed = await registry.handle(
			{ id: "call-1", name: "delete_task", arguments: { id: "task-1" } },
			context,
		);
		if (proposed.status !== "approval-required") throw new Error("fixture failed");
		await registry.approve(proposed.approvalId);
		expect(execute).toHaveBeenCalledWith({ id: "task-1" }, context);
	});

	it("rejects an aborted trusted context before application code executes", async () => {
		const registry = new ToolRegistry();
		const execute = vi.fn(async () => ({ value: null }));
		registry.register({
			name: "read_task",
			description: "Read",
			parameters: { type: "object" },
			schema: z.object({ id: z.string() }).strict(),
			risk: "read",
			execute,
		});
		const controller = new AbortController();
		controller.abort();

		await expect(
			registry.handle(
				{ id: "call-1", name: "read_task", arguments: { id: "task-1" } },
				{
					sessionId: "session-1",
					actualModel: "openrouter/free:test",
					signal: controller.signal,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("offers one-shot undo for reversible writes", async () => {
		const undo = vi.fn(async () => undefined);
		let ids = 0;
		const registry = new ToolRegistry(() => `id-${++ids}`);
		registry.register({
			name: "edit_task",
			description: "Edit",
			parameters: { type: "object" },
			schema: z.object({ id: z.string() }).strict(),
			risk: "reversible-write",
			execute: async () => ({ value: "ok", undo }),
		});
		const result = await registry.handle({
			id: "call-1",
			name: "edit_task",
			arguments: { id: "task-1" },
		});
		if (result.status !== "completed" || result.undoId === null)
			throw new Error("fixture failed");
		await registry.undo(result.undoId);
		expect(undo).toHaveBeenCalledOnce();
		await expect(registry.undo(result.undoId)).rejects.toThrow("undo-not-found");
	});

	it("keeps a failed undo retryable and consumes it after success", async () => {
		let attempts = 0;
		const undo = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient undo failure");
		});
		const registry = new ToolRegistry(() => "undo-retry");
		registry.register({
			name: "edit_task",
			description: "Edit",
			parameters: { type: "object" },
			schema: z.object({ id: z.string() }).strict(),
			risk: "reversible-write",
			execute: async () => ({ value: "ok", undo }),
		});
		const result = await registry.handle({
			id: "call-1",
			name: "edit_task",
			arguments: { id: "task-1" },
		});
		if (result.status !== "completed" || result.undoId === null)
			throw new Error("fixture failed");

		await expect(registry.undo(result.undoId)).rejects.toThrow("transient undo failure");
		await expect(registry.undo(result.undoId)).resolves.toBeUndefined();
		await expect(registry.undo(result.undoId)).rejects.toThrow("undo-not-found");
		expect(undo).toHaveBeenCalledTimes(2);
	});

	it("returns a bounded safe marker for an undefined tool result", async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "read_optional",
			description: "Read",
			parameters: { type: "object" },
			schema: z.object({}).strict(),
			risk: "read",
			execute: async () => ({ value: undefined }),
		});
		await expect(
			registry.handle({ id: "call-1", name: "read_optional", arguments: {} }),
		).resolves.toMatchObject({
			status: "completed",
			result: { truncated: true, reason: "unserializable-result" },
		});
	});

	it("fails loudly if a reversible adapter omits its undo operation", async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "broken_edit",
			description: "Edit",
			parameters: { type: "object" },
			schema: z.object({}).strict(),
			risk: "reversible-write",
			execute: async () => ({ value: "changed" }),
		});
		await expect(
			registry.handle({ id: "call-1", name: "broken_edit", arguments: {} }),
		).rejects.toThrow("reversible-tool-missing-undo");
	});
});

describe("GTD tool catalog", () => {
	function ports(overrides: Record<string, unknown> = {}) {
		const undo = vi.fn(async () => undefined);
		const undoable = async () => ({ value: null, undo });
		return {
			searchVault: async () => [],
			readNote: async () => null,
			listTasks: async () => [],
			getTask: async () => null,
			getTaskRelationships: async (taskId: string) => ({ taskId }),
			listProjects: async (limit: number) => ({ limit }),
			getProject: async (path: string) => ({ path }),
			listBoards: async (limit: number) => ({ limit }),
			getBoard: async (path: string) => ({ path }),
			listScopes: async () => ({ scopes: [] }),
			getCurrentAiRun: async () => ({ found: false }),
			createTask: undoable,
			updateTask: undoable,
			moveTask: undoable,
			deleteTask: async () => ({ value: null }),
			deleteFile: async () => ({ value: null }),
			bulkUpdateTasks: async () => ({ value: null }),
			connectDependency: undoable,
			disconnectDependency: undoable,
			setProjectStatus: undoable,
			moveBoardTask: undoable,
			renameBoard: undoable,
			renameBoardColumn: undoable,
			moveBoardColumn: undoable,
			deleteProjectNode: async () => ({ value: null }),
			deleteBoardColumn: async () => ({ value: null }),
			createProject: async () => ({ value: null }),
			createBoard: async () => ({ value: null }),
			...overrides,
		};
	}

	it.each([
		["GTD/Inbox.md", true],
		["GTD/../Inbox.md", false],
		["GTD/./Inbox.md", false],
		["GTD//Inbox.md", false],
		["GTD\\Inbox.md", false],
		["../outside.md", false],
		["/absolute.md", false],
		["\\absolute.md", false],
		["C:\\outside.md", false],
		[".gtd-flow/ai/session.md", false],
		[".GTD-FLOW/ai/session.md", false],
		["x/../.gtd-flow/ai/session.md", false],
		[".obsidian/plugins/data.md", false],
		[".OBSIDIAN/plugins/data.md", false],
		[".git/config", false],
		[".Trash/deleted.md", false],
		["Projects/.obsidian/Notes.md", true],
		["", false],
	])("validates vault path %s", (path, expected) => {
		expect(isVaultRelativePath(path)).toBe(expected);
	});

	it("never calls a read port for traversal", async () => {
		const readNote = vi.fn(async () => "secret");
		const registry = createGtdToolRegistry(ports({ readNote }));
		const result = await registry.handle({
			id: "call-1",
			name: "read_note",
			arguments: { path: "../../secret", startLine: 0, maxLines: 10 },
		});
		expect(result).toMatchObject({ status: "rejected" });
		expect(readNote).not.toHaveBeenCalled();
	});

	it.each([
		[
			"read_note",
			{
				path: "x/../.gtd-flow/ai/session.md",
				startLine: 0,
				maxLines: 10,
			},
			"readNote",
		],
		["move_task", { taskId: "task-1", toFile: ".obsidian/plugins/target.md" }, "moveTask"],
		[
			"set_project_status",
			{
				projectPath: "Projects/../.gtd-flow/project.md",
				status: "active",
			},
			"setProjectStatus",
		],
		[
			"move_board_task",
			{
				boardPath: ".obsidian/boards/Main.md",
				taskId: "task-1",
				toColumnId: "doing",
				toIndex: 0,
			},
			"moveBoardTask",
		],
		["delete_file", { path: ".gtd-flow/ai/session.jsonl" }, "deleteFile"],
	] as const)(
		"blocks reserved-path access through %s before its port executes",
		async (toolName, args, portName) => {
			const execute = vi.fn(async () => ({
				value: null,
				undo: async () => undefined,
			}));
			const registry = createGtdToolRegistry(ports({ [portName]: execute }));
			await expect(
				registry.handle({
					id: `call-reserved-${toolName}`,
					name: toolName,
					arguments: args,
				}),
			).resolves.toMatchObject({
				status: "rejected",
				reason: "invalid-arguments",
			});
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it("exposes the bounded GTD read surface without raw filesystem or shell tools", () => {
		const names = createGtdToolRegistry(ports())
			.definitions()
			.map((definition) => definition.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"search_vault",
				"read_note",
				"list_tasks",
				"get_task",
				"get_task_relationships",
				"list_projects",
				"get_project",
				"list_boards",
				"get_board",
				"list_scopes",
				"get_current_ai_run",
				"set_project_status",
				"move_board_task",
				"rename_board",
				"rename_board_column",
				"move_board_column",
				"delete_project_node",
				"delete_board_column",
				"delete_file",
				"create_project",
				"create_board",
			]),
		);
		expect(names).not.toEqual(
			expect.arrayContaining(["read_file", "write_file", "run_shell", "execute_command"]),
		);
	});

	it("validates and delegates relationship reads", async () => {
		const getTaskRelationships = vi.fn(async (taskId: string) => ({ taskId }));
		const registry = createGtdToolRegistry(ports({ getTaskRelationships }));
		await expect(
			registry.handle({
				id: "call-relationships",
				name: "get_task_relationships",
				arguments: { taskId: "task-1" },
			}),
		).resolves.toMatchObject({
			status: "completed",
			result: { taskId: "task-1" },
		});
		expect(getTaskRelationships).toHaveBeenCalledWith("task-1");
	});

	it("delegates validated ordinary task fields as a reversible update", async () => {
		const undo = vi.fn(async () => undefined);
		const updateTask = vi.fn(async () => ({ value: { updated: true }, undo }));
		const registry = createGtdToolRegistry(ports({ updateTask }), () => "undo-task");
		const result = await registry.handle({
			id: "call-update",
			name: "update_task",
			arguments: {
				taskId: "task-1",
				status: "done",
				due: "2026-08-01 09:00-10:00",
				scheduled: null,
				priority: "highest",
				location: " Office ",
			},
		});
		expect(result).toMatchObject({ status: "completed", undoId: "undo-task" });
		expect(updateTask).toHaveBeenCalledWith({
			taskId: "task-1",
			status: "done",
			due: "2026-08-01 09:00-10:00",
			scheduled: null,
			priority: "highest",
			location: "Office",
		});
	});

	it("accepts supported task durations and rejects non-day long durations", async () => {
		const updateTask = vi.fn(async () => ({
			value: { updated: true },
			undo: async () => undefined,
		}));
		const registry = createGtdToolRegistry(ports({ updateTask }));
		for (const durationMinutes of [90, 1_440, 2_880]) {
			await expect(
				registry.handle({
					id: `call-duration-${durationMinutes}`,
					name: "update_task",
					arguments: { taskId: "task-1", durationMinutes },
				}),
			).resolves.toMatchObject({ status: "completed" });
		}
		await expect(
			registry.handle({
				id: "call-duration-invalid",
				name: "update_task",
				arguments: { taskId: "task-1", durationMinutes: 2_220 },
			}),
		).resolves.toMatchObject({ status: "rejected", reason: "invalid-arguments" });
		expect(updateTask).toHaveBeenCalledTimes(3);
	});

	it("rejects a bulk mutation with repeated task IDs before approval", async () => {
		const bulkUpdateTasks = vi.fn(async () => ({ value: { changed: true } }));
		const registry = createGtdToolRegistry(ports({ bulkUpdateTasks }));
		await expect(
			registry.handle({
				id: "call-duplicate-bulk",
				name: "bulk_update_tasks",
				arguments: { taskIds: ["task-1", "task-1"], scopeId: "work" },
			}),
		).resolves.toMatchObject({ status: "rejected", reason: "invalid-arguments" });
		expect(bulkUpdateTasks).not.toHaveBeenCalled();
	});

	it("requires a bulk scope and previews the exact approved mutation", async () => {
		const bulkUpdateTasks = vi.fn(async () => ({ value: { changed: true } }));
		let id = 0;
		const registry = createGtdToolRegistry(
			ports({ bulkUpdateTasks }),
			() => `approval-${++id}`,
		);
		await expect(
			registry.handle({
				id: "call-missing-scope",
				name: "bulk_update_tasks",
				arguments: { taskIds: ["task-1", "task-2"] },
			}),
		).resolves.toMatchObject({ status: "rejected", reason: "invalid-arguments" });

		const proposed = await registry.handle({
			id: "call-bulk",
			name: "bulk_update_tasks",
			arguments: { taskIds: ["task-1", "task-2"], scopeId: "life" },
		});
		expect(proposed).toMatchObject({
			status: "approval-required",
			preview: "Set scope to life for 2 tasks",
		});
		expect(bulkUpdateTasks).not.toHaveBeenCalled();
	});

	it("previews that deleting a task also removes nested child lines", async () => {
		const deleteTask = vi.fn(async () => ({ value: { deleted: true } }));
		const registry = createGtdToolRegistry(ports({ deleteTask }), () => "approval-delete");
		await expect(
			registry.handle({
				id: "call-delete",
				name: "delete_task",
				arguments: { taskId: "task-1" },
			}),
		).resolves.toMatchObject({
			status: "approval-required",
			preview: "Delete task task-1 and all nested child lines",
		});
		expect(deleteTask).not.toHaveBeenCalled();
	});

	it("gives dependency edits one-shot undo without approval", async () => {
		const undo = vi.fn(async () => undefined);
		const connectDependency = vi.fn(async () => ({ value: { connected: true }, undo }));
		let id = 0;
		const registry = createGtdToolRegistry(ports({ connectDependency }), () => `undo-${++id}`);
		const result = await registry.handle({
			id: "call-connect",
			name: "connect_dependency",
			arguments: {
				projectPath: "Projects/Launch.md",
				prerequisiteTaskId: "task-1",
				dependentTaskId: "task-2",
			},
		});
		expect(result).toMatchObject({ status: "completed", undoId: "undo-1" });
		if (result.status !== "completed" || result.undoId === null)
			throw new Error("fixture failed");
		await registry.undo(result.undoId);
		expect(undo).toHaveBeenCalledOnce();
	});

	it("rejects self-dependencies before reaching the project service", async () => {
		const connectDependency = vi.fn(async () => ({
			value: null,
			undo: async () => undefined,
		}));
		const registry = createGtdToolRegistry(ports({ connectDependency }));
		await expect(
			registry.handle({
				id: "call-connect",
				name: "connect_dependency",
				arguments: {
					projectPath: "Projects/Launch.md",
					prerequisiteTaskId: "same",
					dependentTaskId: "same",
				},
			}),
		).resolves.toMatchObject({ status: "rejected", reason: "invalid-arguments" });
		expect(connectDependency).not.toHaveBeenCalled();
	});

	it("executes bounded project and board edits immediately with one-shot undo", async () => {
		const undo = vi.fn(async () => undefined);
		const setProjectStatus = vi.fn(async () => ({
			value: { status: "on-hold" },
			undo,
		}));
		const registry = createGtdToolRegistry(
			ports({ setProjectStatus }),
			() => "undo-project-status",
		);
		const result = await registry.handle({
			id: "call-project-status",
			name: "set_project_status",
			arguments: {
				projectPath: "Projects/Launch.md",
				status: "on-hold",
			},
		});
		expect(result).toMatchObject({
			status: "completed",
			undoId: "undo-project-status",
		});
		expect(setProjectStatus).toHaveBeenCalledWith({
			projectPath: "Projects/Launch.md",
			status: "on-hold",
		});
		if (result.status !== "completed" || result.undoId === null)
			throw new Error("fixture failed");
		await registry.undo(result.undoId);
		expect(undo).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"set_project_status",
			{ projectPath: "Projects/Launch.md", status: "paused" },
			"setProjectStatus",
		],
		["update_task", { taskId: "task-1", due: "2026-02-30", status: "done" }, "updateTask"],
		[
			"move_board_task",
			{
				boardPath: "Boards/Main.md",
				taskId: "task-1",
				toColumnId: "doing",
				toIndex: 1_001,
			},
			"moveBoardTask",
		],
		[
			"rename_board_column",
			{ boardPath: "Boards/Main.md", columnId: "doing", name: "Bad\nName" },
			"renameBoardColumn",
		],
		[
			"delete_project_node",
			{ projectPath: "Projects/Launch.md", nodeId: "bad\nnode" },
			"deleteProjectNode",
		],
		["create_board", { boardPath: "Boards/Main.txt", name: "Main" }, "createBoard"],
		["read_note", { path: "Notes/plain.txt", startLine: 0, maxLines: 10 }, "readNote"],
		["move_task", { taskId: "task-1", toFile: "Notes/plain.txt" }, "moveTask"],
		[
			"create_project",
			{ projectPath: "Projects/\nLaunch.md", name: "Launch" },
			"createProject",
		],
		["create_board", { boardPath: ".gtd-flow/ai/Board.md", name: "Internal" }, "createBoard"],
		["delete_file", { path: "../outside.txt" }, "deleteFile"],
	] as const)(
		"rejects invalid arguments for %s before its port executes",
		async (toolName, args, portName) => {
			const execute = vi.fn(async () => ({
				value: null,
				undo: async () => undefined,
			}));
			const registry = createGtdToolRegistry(ports({ [portName]: execute }));
			await expect(
				registry.handle({
					id: `call-${toolName}`,
					name: toolName,
					arguments: args,
				}),
			).resolves.toMatchObject({
				status: "rejected",
				reason: "invalid-arguments",
			});
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"delete_project_node",
			{ projectPath: "Projects/Launch.md", nodeId: "task-1" },
			"deleteProjectNode",
		],
		[
			"delete_board_column",
			{ boardPath: "Boards/Main.md", columnId: "done" },
			"deleteBoardColumn",
		],
		["delete_file", { path: "Attachments/archive.zip" }, "deleteFile"],
		[
			"create_project",
			{ projectPath: "Projects/New.md", name: "New project" },
			"createProject",
		],
		["create_board", { boardPath: "Boards/New.md", name: "New board" }, "createBoard"],
	] as const)("keeps %s frozen until explicit approval", async (toolName, args, portName) => {
		let nextId = 0;
		const execute = vi.fn(async () => ({ value: { ok: true } }));
		const registry = createGtdToolRegistry(
			ports({ [portName]: execute }),
			() => `approval-${++nextId}`,
		);
		const proposed = await registry.handle({
			id: `call-${toolName}`,
			name: toolName,
			arguments: args,
		});
		expect(proposed).toMatchObject({ status: "approval-required" });
		expect(execute).not.toHaveBeenCalled();
		if (proposed.status !== "approval-required") throw new Error("fixture failed");
		await registry.approve(proposed.approvalId);
		expect(execute).toHaveBeenCalledWith(args);
	});
});
