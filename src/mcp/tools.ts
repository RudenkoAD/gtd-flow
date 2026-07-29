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
import { isDurationMinutes } from "../core/model/Task";
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

const DurationMinutesSchema = z
	.number()
	.int()
	.refine(
		isDurationMinutes,
		"Use five-minute increments below 24h and whole-day increments from 24h",
	);

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
				"Call FIRST to orient in the user's GTD system: returns global inbox/tickler/board/project/event counts and the synced scope catalog. Scope is a task field; namespace path filtering is not part of this breaking contract.",
			inputSchema: {},
		},
		() => runTool(ctx, (s) => gtdOverview(s)),
	);

	server.registerTool(
		"list_tasks",
		{
			title: "List tasks",
			description:
				"Read tasks from the GTD system. Call when the user asks what's in their inbox/tickler, what's on a board or in a project, or to find a task before editing it. Filter by stable scope ID and view ('inbox' unprocessed, 'tickler' deferred by 🛫, 'board', 'project', or 'all'). Returns each task's id (🆔 or content-key — pass it back to update_task/delete_task), description, status, dates, tags, priority, file:line, duration_minutes, cognitive_intensity, emotional_intensity, physical_intensity, and scope.",
			inputSchema: {
				scope: z.string().optional().describe("Stable scope ID to filter by."),
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
				"Capture a new task into the configured inbox. Call when the user wants to jot down / add / capture a to-do. Optional duration_minutes is total elapsed minutes: five-minute increments below 24h, then whole-day increments; three intensity values are 0..5; scope is a stable scope ID.",
			inputSchema: {
				text: z.string().describe("Task text (may include #tags and emoji fields)."),
				duration_minutes: DurationMinutesSchema.nullable()
					.optional()
					.describe("Total elapsed duration in minutes, or null to leave it clear."),
				cognitive_intensity: z.number().int().min(0).max(5).nullable().optional(),
				emotional_intensity: z.number().int().min(0).max(5).nullable().optional(),
				physical_intensity: z.number().int().min(0).max(5).nullable().optional(),
				scope: z
					.string()
					.nullable()
					.optional()
					.describe("Active stable scope ID, or null."),
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
				"Edit an existing task by id (🆔 preferred; a content-key from list_tasks also works). Call to mark done/undone, rename, set or clear dates, priority, location, duration_minutes, each intensity, or scope. Duration uses five-minute increments below 24h and whole-day increments from 24h; intensity is 0..5; null clears the supplied field.",
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
				duration_minutes: DurationMinutesSchema.nullable().optional(),
				cognitive_intensity: z.number().int().min(0).max(5).nullable().optional(),
				emotional_intensity: z.number().int().min(0).max(5).nullable().optional(),
				physical_intensity: z.number().int().min(0).max(5).nullable().optional(),
				scope: z
					.string()
					.nullable()
					.optional()
					.describe("Active stable scope ID, or null."),
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
			},
		},
		(args) => runTool(ctx, (s) => listEvents(s, args)),
	);

	server.registerTool(
		"add_event",
		{
			title: "Add calendar event",
			description:
				"Create a calendar event in the configured events file. Call when the user wants to schedule something. Provide EXACTLY ONE of date or rule — passing both is an error (date is for one-off events, rule for recurring). For a one-off event pass date (ISO) and optional time ('2026-07-20 14:30' or '2026-07-20 14:30-16:00'). For a recurring event pass rule in the grammar (e.g. 'every tuesday at 19:00', 'every 2 weeks on monday, wednesday', 'every month on the last day'). Optional location (📍).",
			inputSchema: {
				name: z.string().describe("Event name."),
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
				"List all kanban boards with their columns and per-column card counts. Call to discover boards before move_card, or when the user asks what boards exist / how many cards are in each column.",
			inputSchema: {},
		},
		(args) => runTool(ctx, (s) => listBoards(s, args)),
	);
}
