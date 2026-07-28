/**
 * Регистрация девяти инструментов на McpServer.
 *
 * Каждый инструмент открывает СВЕЖУЮ GtdSession (полный скан vault'а на вызов —
 * всегда согласован с диском) и делегирует в handlers.ts. Ответ — компактный
 * JSON-текст; брошенный Error превращается в isError-ответ с полем error.
 * Описания на английском и говорят, КОГДА звать инструмент.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { localTodayIso } from "../services/snapshotHelpers";
import { loadSettings } from "./config";
import { FsVault } from "./fsVault";
import {
	addEvent,
	addTask,
	deleteTask,
	gtdOverview,
	listBoards,
	listEvents,
	listTasks,
	moveCard,
	updateTask,
} from "./handlers";
import { openSession, type GtdSession } from "./session";

export interface ServerContext {
	vaultRoot: string;
	/** Сегодняшняя дата ISO (инъекция для тестов; в проде — локальная дата). */
	today?: () => string;
	/** Детерминированный генератор 🆔 (тесты); иначе base36 из WritebackService. */
	genId?: () => string;
}

function okResult(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errResult(e: unknown): CallToolResult {
	const message = e instanceof Error ? e.message : String(e);
	return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Открыть сессию (скан + сервисы) и прогнать хендлер; ошибки → isError-ответ. */
async function runTool(
	ctx: ServerContext,
	handler: (session: GtdSession) => unknown | Promise<unknown>,
): Promise<CallToolResult> {
	try {
		const settings = await loadSettings(ctx.vaultRoot);
		const vault = new FsVault(ctx.vaultRoot);
		const today = (ctx.today ?? (() => localTodayIso(new Date())))();
		const session = await openSession({ vault, settings, today, genId: ctx.genId });
		return okResult(await handler(session));
	} catch (e) {
		return errResult(e);
	}
}

export function registerTools(server: McpServer, ctx: ServerContext): void {
	server.registerTool(
		"gtd_overview",
		{
			title: "GTD overview",
			description:
				"Call FIRST to orient in the user's GTD system: lists namespaces (spaces) with their folder roots and per-space counts of inbox / tickler (deferred) / boards / projects / events. Use it to learn which spaces exist before filtering other tools by namespace.",
			inputSchema: {},
		},
		() => runTool(ctx, (s) => gtdOverview(s)),
	);

	server.registerTool(
		"list_tasks",
		{
			title: "List tasks",
			description:
				"Read tasks from the GTD system. Call when the user asks what's in their inbox/tickler, what's on a board or in a project, or to find a task before editing it. Filter by namespace and view ('inbox' unprocessed, 'tickler' deferred by 🛫, 'board', 'project', or 'all'). Pass board/project name to scope to one. Returns each task's id (🆔 or content-key — pass it back to update_task/delete_task), description, status, dates, tags, priority, file:line, and namespace.",
			inputSchema: {
				namespace: z
					.string()
					.optional()
					.describe(
						"Space name (e.g. 'Работа'), 'Общее' for the common space, or 'all'. Omit for the active space.",
					),
				view: z
					.enum(["inbox", "tickler", "board", "project", "all"])
					.optional()
					.describe("Which view to list. Default 'all'."),
				board: z.string().optional().describe("Board id or name (with view 'board')."),
				project: z
					.string()
					.optional()
					.describe("Project name or path (with view 'project')."),
				include_done: z
					.boolean()
					.optional()
					.describe("Include done/cancelled tasks. Default false."),
			},
		},
		(args) => runTool(ctx, (s) => listTasks(s, args)),
	);

	server.registerTool(
		"add_task",
		{
			title: "Add task to inbox",
			description:
				"Capture a new task into the Inbox of a namespace. Call when the user wants to jot down / add / capture a to-do. text may contain emoji fields (🔺 priority, #tags, etc.). Optional due/scheduled/start accept ISO dates with optional time ('2026-07-20' or '2026-07-20 14:30'). Writes to the space's gtd-inbox file (creating the conventional Входящие.md if none).",
			inputSchema: {
				text: z.string().describe("Task text (may include #tags and emoji fields)."),
				namespace: z
					.string()
					.optional()
					.describe(
						"Target space name or 'Общее'. Omit for the active space. 'all' is not allowed.",
					),
				due: z.string().optional().describe("📅 due date, ISO, optional time."),
				scheduled: z.string().optional().describe("⏳ scheduled date, ISO, optional time."),
				start: z.string().optional().describe("🛫 start/defer date, ISO, optional time."),
			},
		},
		(args) => runTool(ctx, (s) => addTask(s, args)),
	);

	server.registerTool(
		"update_task",
		{
			title: "Update task",
			description:
				"Edit an existing task by id (🆔 preferred; a content-key from list_tasks also works). Call to mark done/undone, rename, set or clear dates, set priority, or set location. Pass done, text, priority, location, and/or due/scheduled/start (an ISO string sets it, null clears it). Only the provided fields change.",
			inputSchema: {
				id: z.string().describe("Task 🆔 or content-key (from list_tasks)."),
				done: z.boolean().optional().describe("true marks done (✅ today), false reopens."),
				text: z.string().optional().describe("New description (replaces the text)."),
				due: z
					.string()
					.nullable()
					.optional()
					.describe("📅 date (ISO, optional time) or null to clear."),
				scheduled: z
					.string()
					.nullable()
					.optional()
					.describe("⏳ date (ISO, optional time) or null to clear."),
				start: z
					.string()
					.nullable()
					.optional()
					.describe("🛫 date (ISO, optional time) or null to clear."),
				priority: z
					.enum(["highest", "high", "medium", "low", "lowest", "none"])
					.optional()
					.describe("Priority; 'none' removes it."),
				location: z
					.string()
					.nullable()
					.optional()
					.describe("📍 location (free text) or null/empty string to clear."),
			},
		},
		(args) => runTool(ctx, (s) => updateTask(s, args)),
	);

	server.registerTool(
		"delete_task",
		{
			title: "Delete task",
			description:
				"Remove a task line from its file by id (🆔 or content-key). Call only when the user explicitly wants a task deleted (created by mistake). By default also removes the task's indented sub-block (notes/subitems), like the app's Delete. This does not delete files, only the task line(s).",
			inputSchema: {
				id: z.string().describe("Task 🆔 or content-key (from list_tasks)."),
				with_children: z
					.boolean()
					.optional()
					.describe("Also remove the indented child block. Default true."),
			},
		},
		(args) => runTool(ctx, (s) => deleteTask(s, args)),
	);

	server.registerTool(
		"move_card",
		{
			title: "Move card to column",
			description:
				"Move a task (card) to a column of a kanban board. Call when the user wants to move/drag a card to another column (e.g. 'to Done'). Identify the board by id or name, the task by id, and the target column by id or name. The card is placed at the end of the target column.",
			inputSchema: {
				board: z.string().describe("Board id or name."),
				id: z.string().describe("Task 🆔 or content-key."),
				column: z.string().describe("Target column id or name."),
			},
		},
		(args) => runTool(ctx, (s) => moveCard(s, args)),
	);

	server.registerTool(
		"list_events",
		{
			title: "List calendar events",
			description:
				"List expanded calendar event occurrences in a date range [from, to] (inclusive, ISO dates). Call when the user asks what's on their calendar / schedule for a period. Recurring series (🔁) are expanded to concrete dates (honoring 🚫 exclusions); one-off events (📅) included on their date. Returns date, time, title, kind (series|single), location (📍), and file:line.",
			inputSchema: {
				from: z.string().describe("Range start, ISO YYYY-MM-DD (inclusive)."),
				to: z.string().describe("Range end, ISO YYYY-MM-DD (inclusive)."),
				namespace: z
					.string()
					.optional()
					.describe(
						"Space name, 'Общее', or 'all'. Omit for the active space (common-space events are always visible).",
					),
			},
		},
		(args) => runTool(ctx, (s) => listEvents(s, args)),
	);

	server.registerTool(
		"add_event",
		{
			title: "Add calendar event",
			description:
				"Create a calendar event in a namespace's events file. Call when the user wants to schedule something. Provide EXACTLY ONE of date or rule — passing both is an error (date is for one-off events, rule for recurring). For a one-off event pass date (ISO) and optional time ('14:30' or '14:30-16:00'). For a recurring event pass rule in the grammar (e.g. 'every tuesday at 19:00', 'every 2 weeks on monday, wednesday', 'every month on the last day'). time may be given alongside rule: it is folded into the rule as ' at <time>' — but the rule must not already contain an 'at' clause (that is an error). Optional location (📍).",
			inputSchema: {
				name: z.string().describe("Event name."),
				namespace: z
					.string()
					.optional()
					.describe(
						"Target space name or 'Общее'. Omit for the active space. 'all' is not allowed.",
					),
				date: z
					.string()
					.describe("One-off event date, ISO YYYY-MM-DD. Mutually exclusive with rule.")
					.optional(),
				time: z
					.string()
					.optional()
					.describe(
						"Event time 'HH:mm' or 'HH:mm-HH:mm'. With date it sets the one-off time; with rule it is folded in as ' at <time>' (rule must not already have an 'at').",
					),
				rule: z
					.string()
					.optional()
					.describe(
						"Recurrence rule (grammar), e.g. 'every friday at 09:00'. Time can be inline via 'at HH:mm' or passed separately in time (not both). Mutually exclusive with date.",
					),
				location: z.string().optional().describe("📍 place/address."),
			},
		},
		(args) => runTool(ctx, (s) => addEvent(s, args)),
	);

	server.registerTool(
		"list_boards",
		{
			title: "List boards",
			description:
				"List kanban boards in a namespace with their columns and per-column card counts. Call to discover boards before move_card, or when the user asks what boards exist / how many cards are in each column.",
			inputSchema: {
				namespace: z
					.string()
					.optional()
					.describe("Space name, 'Общее', or 'all'. Omit for the active space."),
			},
		},
		(args) => runTool(ctx, (s) => listBoards(s, args)),
	);
}
