import { describe, expect, it, vi } from "vitest";

const { handlerMocks, loadSettingsMock, openSessionMock } = vi.hoisted(() => ({
	handlerMocks: {
		addEvent: vi.fn(async () => ({ tool: "add_event" })),
		addTask: vi.fn(async () => ({ tool: "add_task" })),
		deleteTask: vi.fn(async () => ({ tool: "delete_task" })),
		gtdOverview: vi.fn(() => ({ tool: "gtd_overview" })),
		listBoards: vi.fn(() => ({ tool: "list_boards" })),
		listEvents: vi.fn(() => ({ tool: "list_events" })),
		listTasks: vi.fn(() => ({ tool: "list_tasks" })),
		moveCard: vi.fn(async () => ({ tool: "move_card" })),
		updateTask: vi.fn(async () => ({ tool: "update_task" })),
	},
	loadSettingsMock: vi.fn(async () => ({ inboxFile: "Inbox.md" })),
	openSessionMock: vi.fn(async () => ({ marker: "session" })),
}));

vi.mock("./config", () => ({ loadSettings: loadSettingsMock }));
vi.mock("./fsVault", () => ({
	FsVault: class {
		constructor(readonly root: string) {}
	},
}));
vi.mock("./handlers", () => handlerMocks);
vi.mock("./session", () => ({ openSession: openSessionMock }));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools";

interface RegisteredTool {
	name: string;
	definition: { inputSchema: unknown };
	handler: (
		args: Record<string, unknown>,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function register(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const server = {
		registerTool(
			name: string,
			definition: RegisteredTool["definition"],
			handler: RegisteredTool["handler"],
		) {
			tools.set(name, { name, definition, handler });
		},
	};
	registerTools(server as unknown as McpServer, {
		vaultRoot: "/vault",
		today: () => "2026-07-28",
		genId: () => "test-id",
	});
	return tools;
}

describe("MCP tool registration", () => {
	it("registers every contract and executes each handler through the fresh-session boundary", async () => {
		const tools = register();
		expect([...tools.keys()]).toEqual([
			"gtd_overview",
			"list_tasks",
			"add_task",
			"update_task",
			"delete_task",
			"move_card",
			"list_events",
			"add_event",
			"list_boards",
		]);

		const args: Record<string, Record<string, unknown>> = {
			gtd_overview: {},
			list_tasks: { view: "all", scope: "work" },
			add_task: { text: "Plan review", duration_minutes: 30 },
			update_task: { id: "task-1", scope: "life" },
			delete_task: { id: "task-1" },
			move_card: { board: "sprint", id: "task-1", column: "done" },
			list_events: { from: "2026-07-28", to: "2026-07-29" },
			add_event: { name: "Review", date: "2026-07-29" },
			list_boards: {},
		};
		for (const [name, input] of Object.entries(args)) {
			const result = await tools.get(name)!.handler(input);
			expect(result.isError).toBeUndefined();
			expect(JSON.parse(result.content[0]!.text)).toEqual({ tool: name });
		}
		expect(loadSettingsMock).toHaveBeenCalledTimes(9);
		expect(openSessionMock).toHaveBeenCalledWith(
			expect.objectContaining({ today: "2026-07-28", genId: expect.any(Function) }),
		);
	});

	it("converts setup and handler errors into MCP error results", async () => {
		const tools = register();
		loadSettingsMock.mockRejectedValueOnce(new Error("unreadable config"));
		await expect(tools.get("gtd_overview")!.handler({})).resolves.toMatchObject({
			isError: true,
			content: [{ text: JSON.stringify({ error: "unreadable config" }) }],
		});

		handlerMocks.listTasks.mockImplementationOnce(() => {
			throw "handler failed";
		});
		await expect(tools.get("list_tasks")!.handler({})).resolves.toMatchObject({
			isError: true,
			content: [{ text: JSON.stringify({ error: "handler failed" }) }],
		});
	});
});
