import { z } from "zod";
import { isDurationMinutes, type Priority, type ProjectStatus } from "../../core/model/Task";
import { parseDatePayload } from "../../core/parser/parseTaskLine";
import { ToolRegistry, type ToolExecutionContext } from "./ToolRegistry";

const MAX_BOARD_POSITION = 1_000;

const VaultPathSchema = z
	.string()
	.trim()
	.min(1)
	.max(1_024)
	.refine(
		(path) => !/[\u0000-\u001f\u007f]/u.test(path),
		"Path must not contain control characters",
	)
	.refine(isVaultRelativePath, "Path must stay inside the vault");

const MarkdownVaultPathSchema = VaultPathSchema.refine(
	(path) => path.toLowerCase().endsWith(".md"),
	"Container path must identify a Markdown note",
);

const OpaqueIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[^\s\u0000-\u001f\u007f]+$/u, "ID must not contain whitespace or control characters");

const PrintableReferenceSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine(
		(value) => !/[\u0000-\u001f\u007f]/u.test(value),
		"Reference must not contain control characters",
	);

const TaskIdSchema = OpaqueIdSchema;
const ColumnIdSchema = PrintableReferenceSchema;
const ProjectNodeIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(1_200)
	.refine(
		(value) => !/[\u0000-\u001f\u007f]/u.test(value),
		"Node reference must not contain control characters",
	);

const DisplayNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine(
		(value) => !/[\u0000-\u001f\u007f]/u.test(value),
		"Name must not contain control characters",
	);

const ProjectStatusSchema = z.enum(["active", "on-hold", "done", "archived"]);
const TaskStatusSchema = z.enum(["open", "done", "cancelled"]);
const TaskPrioritySchema = z.enum(["highest", "high", "medium", "low", "lowest", "none"]);
const TaskDateTimeSchema = z
	.string()
	.trim()
	.min(10)
	.max(32)
	.refine(isTaskDateTime, "Expected YYYY-MM-DD[ HH:mm[-HH:mm]]");
const BoardMoveDirectionSchema = z.enum(["left", "right"]);
const BoardPositionSchema = z.number().int().min(0).max(MAX_BOARD_POSITION);

export interface UndoableValue {
	value: unknown;
	undo: () => Promise<void>;
}

export interface GtdToolPorts {
	searchVault(query: string, limit: number): Promise<unknown>;
	readNote(path: string, startLine: number, maxLines: number): Promise<unknown>;
	listTasks(query: string | null, limit: number): Promise<unknown>;
	getTask(taskId: string): Promise<unknown>;
	getTaskRelationships?(taskId: string): Promise<unknown>;
	listProjects?(limit: number): Promise<unknown>;
	getProject?(path: string): Promise<unknown>;
	listBoards?(limit: number): Promise<unknown>;
	getBoard?(path: string): Promise<unknown>;
	listScopes?(): Promise<unknown>;
	getCurrentAiRun?(): Promise<unknown>;
	createTask(
		input: { text: string; inbox: boolean },
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	updateTask(
		input: {
			taskId: string;
			text?: string;
			status?: "open" | "done" | "cancelled";
			due?: string | null;
			scheduled?: string | null;
			start?: string | null;
			priority?: Priority;
			location?: string | null;
			durationMinutes?: number | null;
			cognitiveIntensity?: number | null;
			emotionalIntensity?: number | null;
			physicalIntensity?: number | null;
			scopeId?: string | null;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	moveTask(
		input: { taskId: string; toFile: string },
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	deleteTask(input: { taskId: string }): Promise<{ value: unknown }>;
	deleteFile(input: { path: string }): Promise<{ value: unknown }>;
	bulkUpdateTasks(
		input: { taskIds: string[]; scopeId: string },
		context?: ToolExecutionContext,
	): Promise<{ value: unknown }>;
	connectDependency?(
		input: {
			projectPath: string;
			prerequisiteTaskId: string;
			dependentTaskId: string;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	disconnectDependency?(
		input: {
			projectPath: string;
			prerequisiteTaskId: string;
			dependentTaskId: string;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	setProjectStatus?(
		input: {
			projectPath: string;
			status: ProjectStatus;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	moveBoardTask?(
		input: {
			boardPath: string;
			taskId: string;
			toColumnId: string;
			toIndex: number;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	renameBoard?(
		input: { boardPath: string; name: string },
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	renameBoardColumn?(
		input: {
			boardPath: string;
			columnId: string;
			name: string;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	moveBoardColumn?(
		input: {
			boardPath: string;
			columnId: string;
			direction: "left" | "right";
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue>;
	deleteProjectNode?(input: { projectPath: string; nodeId: string }): Promise<{ value: unknown }>;
	deleteBoardColumn?(input: { boardPath: string; columnId: string }): Promise<{ value: unknown }>;
	createProject?(input: { projectPath: string; name: string }): Promise<{ value: unknown }>;
	createBoard?(input: { boardPath: string; name: string }): Promise<{ value: unknown }>;
}

/** Register the MVP vault/task tools without exposing Obsidian or filesystem APIs. */
export function createGtdToolRegistry(ports: GtdToolPorts, createId?: () => string): ToolRegistry {
	const registry = new ToolRegistry(createId);

	registry.register({
		name: "search_vault",
		description: "Search note text and return bounded matching excerpts.",
		risk: "read",
		parameters: objectSchema({
			query: { type: "string" },
			limit: { type: "integer", minimum: 1, maximum: 50 },
		}),
		schema: z
			.object({
				query: z.string().trim().min(1).max(500),
				limit: z.number().int().min(1).max(50),
			})
			.strict(),
		execute: async ({ query, limit }) => ({ value: await ports.searchVault(query, limit) }),
	});

	registry.register({
		name: "read_note",
		description: "Read a bounded excerpt from one vault-relative note.",
		risk: "read",
		parameters: objectSchema({
			path: { type: "string" },
			startLine: { type: "integer", minimum: 0 },
			maxLines: { type: "integer", minimum: 1, maximum: 200 },
		}),
		schema: z
			.object({
				path: MarkdownVaultPathSchema,
				startLine: z.number().int().nonnegative(),
				maxLines: z.number().int().min(1).max(200),
			})
			.strict(),
		execute: async ({ path, startLine, maxLines }) => ({
			value: await ports.readNote(path, startLine, maxLines),
		}),
	});

	registry.register({
		name: "list_tasks",
		description: "List or search indexed GTD Flow tasks.",
		risk: "read",
		parameters: objectSchema({
			query: { anyOf: [{ type: "string" }, { type: "null" }] },
			limit: { type: "integer", minimum: 1, maximum: 100 },
		}),
		schema: z
			.object({
				query: z.string().trim().max(500).nullable(),
				limit: z.number().int().min(1).max(100),
			})
			.strict(),
		execute: async ({ query, limit }) => ({ value: await ports.listTasks(query, limit) }),
	});

	registry.register({
		name: "get_task",
		description: "Get one indexed task by its stable task ID.",
		risk: "read",
		parameters: objectSchema({ taskId: { type: "string" } }),
		schema: z.object({ taskId: TaskIdSchema }).strict(),
		execute: async ({ taskId }) => ({ value: await ports.getTask(taskId) }),
	});

	registry.register({
		name: "get_task_relationships",
		description:
			"Inspect dependencies, dependents, recurrence origin, and nesting for one task.",
		risk: "read",
		parameters: objectSchema({ taskId: { type: "string" } }),
		schema: z.object({ taskId: TaskIdSchema }).strict(),
		execute: async ({ taskId }) => ({
			value: await requiredPort(
				ports.getTaskRelationships?.bind(ports),
				"task-relationships",
			)(taskId),
		}),
	});

	registry.register({
		name: "list_projects",
		description: "List bounded project summaries.",
		risk: "read",
		parameters: objectSchema({
			limit: { type: "integer", minimum: 1, maximum: 100 },
		}),
		schema: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
		execute: async ({ limit }) => ({
			value: await requiredPort(ports.listProjects?.bind(ports), "projects")(limit),
		}),
	});

	registry.register({
		name: "get_project",
		description: "Inspect one project graph with bounded nodes, edges, and issues.",
		risk: "read",
		parameters: objectSchema({ path: { type: "string" } }),
		schema: z.object({ path: MarkdownVaultPathSchema }).strict(),
		execute: async ({ path }) => ({
			value: await requiredPort(ports.getProject?.bind(ports), "project")(path),
		}),
	});

	registry.register({
		name: "list_boards",
		description: "List bounded board definitions and columns.",
		risk: "read",
		parameters: objectSchema({
			limit: { type: "integer", minimum: 1, maximum: 100 },
		}),
		schema: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
		execute: async ({ limit }) => ({
			value: await requiredPort(ports.listBoards?.bind(ports), "boards")(limit),
		}),
	});

	registry.register({
		name: "get_board",
		description: "Inspect one board and its bounded task membership.",
		risk: "read",
		parameters: objectSchema({ path: { type: "string" } }),
		schema: z.object({ path: MarkdownVaultPathSchema }).strict(),
		execute: async ({ path }) => ({
			value: await requiredPort(ports.getBoard?.bind(ports), "board")(path),
		}),
	});

	registry.register({
		name: "list_scopes",
		description: "Inspect the configured stable scope catalog.",
		risk: "read",
		parameters: objectSchema({}, []),
		schema: z.object({}).strict(),
		execute: async () => ({
			value: await requiredPort(ports.listScopes?.bind(ports), "scopes")(),
		}),
	});

	registry.register({
		name: "get_current_ai_run",
		description: "Inspect the latest durable AI processing run without prompt contents.",
		risk: "read",
		parameters: objectSchema({}, []),
		schema: z.object({}).strict(),
		execute: async () => ({
			value: await requiredPort(ports.getCurrentAiRun?.bind(ports), "current-run")(),
		}),
	});

	registry.register({
		name: "create_task",
		description: "Create one task. This is reversible and exposes undo.",
		risk: "reversible-write",
		parameters: objectSchema({
			text: { type: "string" },
			inbox: { type: "boolean" },
		}),
		schema: z
			.object({ text: z.string().trim().min(1).max(4_000), inbox: z.boolean() })
			.strict(),
		execute: (input, context) =>
			executePort(ports.createTask.bind(ports), "task-create", input, context),
	});

	const intensity = z.union([
		z.literal(0),
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4),
		z.literal(5),
	]);
	registry.register({
		name: "update_task",
		description: "Edit one task through validated GTD Flow writeback. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema(
			{
				taskId: { type: "string" },
				text: { type: "string" },
				status: { type: "string", enum: ["open", "done", "cancelled"] },
				due: { type: ["string", "null"] },
				scheduled: { type: ["string", "null"] },
				start: { type: ["string", "null"] },
				priority: {
					type: "string",
					enum: ["highest", "high", "medium", "low", "lowest", "none"],
				},
				location: { type: ["string", "null"] },
				durationMinutes: {
					anyOf: [
						{
							type: "integer",
							minimum: 5,
							maximum: 1_435,
							multipleOf: 5,
						},
						{ type: "integer", minimum: 1_440, multipleOf: 1_440 },
						{ type: "null" },
					],
				},
				cognitiveIntensity: { type: ["integer", "null"], minimum: 0, maximum: 5 },
				emotionalIntensity: { type: ["integer", "null"], minimum: 0, maximum: 5 },
				physicalIntensity: { type: ["integer", "null"], minimum: 0, maximum: 5 },
				scopeId: { type: ["string", "null"] },
			},
			["taskId"],
		),
		schema: z
			.object({
				taskId: TaskIdSchema,
				text: z.string().trim().min(1).max(4_000).optional(),
				status: TaskStatusSchema.optional(),
				due: TaskDateTimeSchema.nullable().optional(),
				scheduled: TaskDateTimeSchema.nullable().optional(),
				start: TaskDateTimeSchema.nullable().optional(),
				priority: TaskPrioritySchema.optional(),
				location: z
					.string()
					.trim()
					.max(500)
					.refine(
						(value) => !/[\u0000-\u001f\u007f]/u.test(value),
						"Location must not contain control characters",
					)
					.nullable()
					.optional(),
				durationMinutes: z.number().int().refine(isDurationMinutes).nullable().optional(),
				cognitiveIntensity: intensity.nullable().optional(),
				emotionalIntensity: intensity.nullable().optional(),
				physicalIntensity: intensity.nullable().optional(),
				scopeId: z.string().trim().min(1).max(64).nullable().optional(),
			})
			.strict()
			.refine(
				(value) => Object.keys(value).some((key) => key !== "taskId"),
				"At least one field is required",
			),
		execute: (input, context) =>
			context === undefined ? ports.updateTask(input) : ports.updateTask(input, context),
	});

	registry.register({
		name: "move_task",
		description: "Move one task to a vault-relative note. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema({
			taskId: { type: "string" },
			toFile: { type: "string" },
		}),
		schema: z.object({ taskId: TaskIdSchema, toFile: MarkdownVaultPathSchema }).strict(),
		execute: (input, context) =>
			executePort(ports.moveTask.bind(ports), "task-move", input, context),
	});

	const dependencySchema = z
		.object({
			projectPath: MarkdownVaultPathSchema,
			prerequisiteTaskId: TaskIdSchema,
			dependentTaskId: TaskIdSchema,
		})
		.strict()
		.refine(
			(value) => value.prerequisiteTaskId !== value.dependentTaskId,
			"A task cannot depend on itself",
		);
	const dependencyParameters = objectSchema({
		projectPath: { type: "string" },
		prerequisiteTaskId: { type: "string" },
		dependentTaskId: { type: "string" },
	});
	registry.register({
		name: "connect_dependency",
		description: "Connect one project dependency after cycle validation. This is reversible.",
		risk: "reversible-write",
		parameters: dependencyParameters,
		schema: dependencySchema,
		execute: (input, context) =>
			executePort(ports.connectDependency?.bind(ports), "dependency-connect", input, context),
	});
	registry.register({
		name: "disconnect_dependency",
		description: "Disconnect one project dependency. This is reversible.",
		risk: "reversible-write",
		parameters: dependencyParameters,
		schema: dependencySchema,
		execute: (input, context) =>
			executePort(
				ports.disconnectDependency?.bind(ports),
				"dependency-disconnect",
				input,
				context,
			),
	});

	registry.register({
		name: "set_project_status",
		description: "Set one existing project's status. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema({
			projectPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			status: { type: "string", enum: ["active", "on-hold", "done", "archived"] },
		}),
		schema: z
			.object({
				projectPath: MarkdownVaultPathSchema,
				status: ProjectStatusSchema,
			})
			.strict(),
		execute: (input, context) =>
			executePort(ports.setProjectStatus?.bind(ports), "project-status", input, context),
	});

	registry.register({
		name: "move_board_task",
		description:
			"Move one uniquely identified board task to a validated column position. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema({
			boardPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			taskId: { type: "string", maxLength: 200 },
			toColumnId: { type: "string", maxLength: 200 },
			toIndex: {
				type: "integer",
				minimum: 0,
				maximum: MAX_BOARD_POSITION,
			},
		}),
		schema: z
			.object({
				boardPath: MarkdownVaultPathSchema,
				taskId: TaskIdSchema,
				toColumnId: ColumnIdSchema,
				toIndex: BoardPositionSchema,
			})
			.strict(),
		execute: (input, context) =>
			executePort(ports.moveBoardTask?.bind(ports), "board-task-move", input, context),
	});

	registry.register({
		name: "rename_board",
		description: "Rename one board without changing its stable board ID. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema({
			boardPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			name: { type: "string", minLength: 1, maxLength: 200 },
		}),
		schema: z
			.object({
				boardPath: MarkdownVaultPathSchema,
				name: DisplayNameSchema,
			})
			.strict(),
		execute: (input, context) =>
			executePort(ports.renameBoard?.bind(ports), "board-rename", input, context),
	});

	registry.register({
		name: "rename_board_column",
		description:
			"Rename one board column without changing its stable column ID or match tag. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema({
			boardPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			columnId: { type: "string", maxLength: 200 },
			name: { type: "string", minLength: 1, maxLength: 200 },
		}),
		schema: z
			.object({
				boardPath: MarkdownVaultPathSchema,
				columnId: ColumnIdSchema,
				name: DisplayNameSchema,
			})
			.strict(),
		execute: (input, context) =>
			executePort(
				ports.renameBoardColumn?.bind(ports),
				"board-column-rename",
				input,
				context,
			),
	});

	registry.register({
		name: "move_board_column",
		description: "Move one board column by one position. This is reversible.",
		risk: "reversible-write",
		parameters: objectSchema({
			boardPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			columnId: { type: "string", maxLength: 200 },
			direction: { type: "string", enum: ["left", "right"] },
		}),
		schema: z
			.object({
				boardPath: MarkdownVaultPathSchema,
				columnId: ColumnIdSchema,
				direction: BoardMoveDirectionSchema,
			})
			.strict(),
		execute: (input, context) =>
			executePort(ports.moveBoardColumn?.bind(ports), "board-column-move", input, context),
	});

	registry.register({
		name: "delete_task",
		description: "Delete one task and all nested child lines after an explicit user approval.",
		risk: "destructive-or-bulk",
		parameters: objectSchema({ taskId: { type: "string" } }),
		schema: z.object({ taskId: TaskIdSchema }).strict(),
		preview: ({ taskId }) => `Delete task ${taskId} and all nested child lines`,
		execute: (input) => ports.deleteTask(input),
	});

	registry.register({
		name: "delete_file",
		description:
			"Delete one user-vault file after explicit approval. Plugin state and Obsidian configuration are inaccessible.",
		risk: "destructive-or-bulk",
		parameters: objectSchema({ path: { type: "string" } }),
		schema: z.object({ path: VaultPathSchema }).strict(),
		preview: ({ path }) => `Delete vault file ${path}`,
		execute: (input) => ports.deleteFile(input),
	});

	registry.register({
		name: "bulk_update_tasks",
		description: "Update multiple tasks after an explicit user approval.",
		risk: "destructive-or-bulk",
		parameters: objectSchema(
			{
				taskIds: {
					type: "array",
					minItems: 1,
					maxItems: 100,
					uniqueItems: true,
					items: { type: "string" },
				},
				scopeId: { type: "string" },
			},
			["taskIds", "scopeId"],
		),
		schema: z
			.object({
				taskIds: z
					.array(TaskIdSchema)
					.min(1)
					.max(100)
					.refine(
						(values) => new Set(values).size === values.length,
						"Task IDs must be unique",
					),
				scopeId: z.string().trim().min(1).max(64),
			})
			.strict(),
		preview: ({ taskIds, scopeId }) => `Set scope to ${scopeId} for ${taskIds.length} tasks`,
		execute: (input, context) =>
			context === undefined
				? ports.bulkUpdateTasks(input)
				: ports.bulkUpdateTasks(input, context),
	});

	registry.register({
		name: "delete_project_node",
		description:
			"Delete one project node and its project-local dependency references after explicit approval.",
		risk: "destructive-or-bulk",
		parameters: objectSchema({
			projectPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			nodeId: { type: "string", maxLength: 1_200 },
		}),
		schema: z
			.object({
				projectPath: MarkdownVaultPathSchema,
				nodeId: ProjectNodeIdSchema,
			})
			.strict(),
		preview: ({ projectPath, nodeId }) => `Delete project node ${nodeId} from ${projectPath}`,
		execute: (input) =>
			requiredPort(ports.deleteProjectNode?.bind(ports), "project-node-delete")(input),
	});

	registry.register({
		name: "delete_board_column",
		description:
			"Delete one board column definition and its manual order after explicit approval.",
		risk: "destructive-or-bulk",
		parameters: objectSchema({
			boardPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			columnId: { type: "string", maxLength: 200 },
		}),
		schema: z
			.object({
				boardPath: MarkdownVaultPathSchema,
				columnId: ColumnIdSchema,
			})
			.strict(),
		preview: ({ boardPath, columnId }) =>
			`Delete board column ${columnId} from ${boardPath}; task tags will remain`,
		execute: (input) =>
			requiredPort(ports.deleteBoardColumn?.bind(ports), "board-column-delete")(input),
	});

	registry.register({
		name: "create_project",
		description:
			"Create or mark one Markdown note as a project after explicit approval; no automatic delete undo is offered.",
		risk: "destructive-or-bulk",
		parameters: objectSchema({
			projectPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			name: { type: "string", minLength: 1, maxLength: 200 },
		}),
		schema: z
			.object({
				projectPath: MarkdownVaultPathSchema,
				name: DisplayNameSchema,
			})
			.strict(),
		preview: ({ projectPath, name }) => `Create or mark project "${name}" at ${projectPath}`,
		execute: (input) => requiredPort(ports.createProject?.bind(ports), "project-create")(input),
	});

	registry.register({
		name: "create_board",
		description:
			"Create or mark one Markdown note as a board after explicit approval; no automatic delete undo is offered.",
		risk: "destructive-or-bulk",
		parameters: objectSchema({
			boardPath: { type: "string", maxLength: 1_024, pattern: "\\.md$" },
			name: { type: "string", minLength: 1, maxLength: 200 },
		}),
		schema: z
			.object({
				boardPath: MarkdownVaultPathSchema,
				name: DisplayNameSchema,
			})
			.strict(),
		preview: ({ boardPath, name }) => `Create or mark board "${name}" at ${boardPath}`,
		execute: (input) => requiredPort(ports.createBoard?.bind(ports), "board-create")(input),
	});

	return registry;
}

function objectSchema(
	properties: Record<string, unknown>,
	required: string[] = Object.keys(properties),
): Record<string, unknown> {
	return { type: "object", additionalProperties: false, properties, required };
}

export function isVaultRelativePath(path: string): boolean {
	if (
		path === "" ||
		path.startsWith("/") ||
		path.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/u.test(path) ||
		path.includes("\0") ||
		path.includes("\\")
	) {
		return false;
	}
	const segments = path.split("/");
	for (const segment of segments) {
		// Keep every application port on the same canonical path grammar.
		// Even a traversal that happens to land back inside the vault is rejected
		// instead of being interpreted differently by Obsidian and service ports.
		if (segment === "" || segment === "." || segment === "..") return false;
	}
	const first = segments[0]!.toLowerCase();
	return !RESERVED_VAULT_ROOTS.has(first);
}

const RESERVED_VAULT_ROOTS = new Set([".git", ".gtd-flow", ".obsidian", ".trash"]);

function executePort<TInput, TResult>(
	port: ((input: TInput, context?: ToolExecutionContext) => Promise<TResult>) | undefined,
	name: string,
	input: TInput,
	context: ToolExecutionContext | undefined,
): Promise<TResult> {
	if (!port) throw new Error(`${name}-port-unavailable`);
	return context === undefined ? port(input) : port(input, context);
}

function requiredPort<T extends (...args: never[]) => Promise<unknown>>(
	port: T | undefined,
	name: string,
): T {
	if (!port) throw new Error(`${name}-port-unavailable`);
	return port;
}

function isTaskDateTime(value: string): boolean {
	const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](.*))?$/u.exec(value);
	if (match === null || parseDatePayload(match[1]!).kind !== "date") return false;
	const timeSpec = match[2];
	if (timeSpec === undefined) return true;
	const parts = timeSpec.split("-");
	if (parts.length < 1 || parts.length > 2) return false;
	const [start, end] = parts;
	const validTime = /^([01]\d|2[0-3]):[0-5]\d$/u;
	if (start === undefined || !validTime.test(start)) return false;
	return end === undefined || (validTime.test(end) && end > start);
}
