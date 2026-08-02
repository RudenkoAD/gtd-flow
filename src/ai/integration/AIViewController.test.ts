import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentToolCall } from "../core/messages";
import { AIError } from "../core/errors";
import { AgentRuntime } from "../core/AgentRuntime";
import type {
	AIProviderPort,
	ProviderRequest,
	ProviderStreamEvent,
} from "../providers/AIProviderPort";
import { SessionRepository } from "../storage/SessionRepository";
import type { AtomicFilePort } from "../storage/AtomicFilePort";
import { ToolRegistry } from "../tools/ToolRegistry";
import { AIViewController } from "./AIViewController";

class MemoryFiles implements AtomicFilePort {
	readonly files = new Map<string, string>();
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async writeAtomic(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}
	async writeNew(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error("already-exists");
		this.files.set(path, content);
	}
	async list(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((path) => path.startsWith(`${prefix}/`));
	}
}

class StreamProvider implements AIProviderPort {
	async complete(): Promise<never> {
		throw new Error("unused");
	}
	async completeJson(): Promise<never> {
		throw new Error("unused");
	}
	async *stream(_request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
		yield {
			type: "response-started",
			provider: "openrouter",
			responseId: "response-1",
			actualModel: "free/model",
		};
		yield { type: "text-delta", text: "Hello" };
		yield {
			type: "response-completed",
			completion: {
				provider: "openrouter",
				responseId: "response-1",
				actualModel: "free/model",
				message: {
					id: "assistant-1",
					role: "assistant",
					content: "Hello",
					createdAt: "2026-07-28T00:00:00.000Z",
					provider: "openrouter",
					model: "free/model",
				},
				toolCalls: [],
			},
		};
	}
}

class FailingStreamProvider implements AIProviderPort {
	constructor(private readonly error: AIError) {}

	async complete(): Promise<never> {
		throw this.error;
	}

	async completeJson(): Promise<never> {
		throw this.error;
	}

	async *stream(): AsyncGenerator<ProviderStreamEvent> {
		throw this.error;
	}
}

function fixture(
	options: {
		provider?: AIProviderPort;
		tools?: ToolRegistry;
		taskLink?: (taskId: string) => { id: string; label: string } | null;
		openTask?: (taskId: string) => Promise<void>;
		cancelInboxProcessing?: () => void;
		connection?: {
			isConnected(): Promise<boolean>;
			connect(): Promise<void>;
			disconnect(): Promise<void>;
		};
		queue?: {
			status(): Promise<{
				waitingCount: number;
				processingCount: number;
				state: "idle" | "processing" | "queued" | "rate-limited" | "retry-waiting";
				nextEligibleAt: string | null;
				errorCode:
					| "authentication"
					| "cancelled"
					| "configuration"
					| "invalid-response"
					| "network"
					| "provider-unavailable"
					| "rate-limited"
					| "unknown"
					| null;
			}>;
		};
	} = {},
) {
	const files = new MemoryFiles();
	const sessions = new SessionRepository(files);
	const tools = options.tools ?? new ToolRegistry();
	let id = 0;
	const controller = new AIViewController({
		runtime: new AgentRuntime(options.provider ?? new StreamProvider()),
		sessions,
		tools,
		connection: options.connection ?? {
			isConnected: async () => true,
			connect: async () => undefined,
			disconnect: async () => undefined,
		},
		questions: {
			listPending: async () => [],
			answer: async () => undefined,
		},
		queue: options.queue,
		cancelInboxProcessing: options.cancelInboxProcessing,
		openTask: options.openTask ?? (async () => undefined),
		taskLink: options.taskLink,
		now: () => new Date("2026-07-28T00:00:00.000Z"),
		createId: () => `generated-${++id}`,
	});
	return { controller, sessions };
}

class ToolCallingProvider implements AIProviderPort {
	private round = 0;

	constructor(private readonly call: AgentToolCall) {}

	async complete(): Promise<never> {
		throw new Error("unused");
	}
	async completeJson(): Promise<never> {
		throw new Error("unused");
	}
	async *stream(_request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
		this.round++;
		const actualModel = "free/tool-model";
		yield {
			type: "response-started",
			provider: "openrouter",
			responseId: `response-${this.round}`,
			actualModel,
		};
		if (this.round === 1) {
			yield { type: "tool-call", call: this.call };
			yield {
				type: "response-completed",
				completion: {
					provider: "openrouter",
					responseId: "response-1",
					actualModel,
					message: {
						id: "assistant-tool",
						role: "assistant",
						content: JSON.stringify({ taskId: "task-1" }),
						createdAt: "2026-07-28T00:00:00.000Z",
						provider: "openrouter",
						model: actualModel,
						toolCalls: [this.call],
					},
					toolCalls: [this.call],
				},
			};
			return;
		}
		yield {
			type: "response-completed",
			completion: {
				provider: "openrouter",
				responseId: `response-${this.round}`,
				actualModel,
				message: {
					id: "assistant-final",
					role: "assistant",
					content: "Done",
					createdAt: "2026-07-28T00:00:00.000Z",
					provider: "openrouter",
					model: actualModel,
				},
				toolCalls: [],
			},
		};
	}
}

describe("AIViewController", () => {
	it("persists chat messages and emits streaming UI events", async () => {
		const { controller, sessions } = fixture();
		const events: string[] = [];
		controller.subscribe((event) => events.push(event.type));
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;
		await controller.sendMessage(sessionId, "Hello?");
		const loaded = await sessions.load(sessionId);
		expect(loaded.messages.map((record) => record.message.role)).toEqual(["user", "assistant"]);
		expect(events).toContain("response-started");
		expect(events).toContain("text-delta");
		expect(events).toContain("response-completed");
		expect((await controller.getSnapshot()).actualModel).toBe("free/model");
	});

	it("creates independent sessions", async () => {
		const { controller } = fixture();
		await controller.createChat();
		await controller.createChat();
		const snapshot = await controller.getSnapshot();
		expect(snapshot.sessions).toHaveLength(2);
		expect(snapshot.sessions.map((session) => session.id)).toContain(snapshot.activeSessionId);
	});

	it("surfaces durable waiting runs as read-only status without changing chat work", async () => {
		const { controller } = fixture({
			queue: {
				status: async () => ({
					waitingCount: 2,
					processingCount: 0,
					state: "retry-waiting",
					nextEligibleAt: "2026-07-28T00:05:00.000Z",
					errorCode: "network",
				}),
			},
		});
		const before = await controller.getSnapshot();
		expect(before.work).toBe("idle");
		expect(before.queue).toEqual({
			waitingCount: 2,
			processingCount: 0,
			state: "retry-waiting",
			nextEligibleAt: "2026-07-28T00:05:00.000Z",
			errorCode: "network",
		});
	});

	it.each([
		{
			name: "a 429",
			error: new AIError({
				code: "rate-limited",
				retryable: true,
				retryAfterMs: 30_000,
				statusCode: 429,
			}),
			work: "rate-limited",
			nextEligibleAt: "2026-07-28T00:00:30.000Z",
		},
		{
			name: "a retryable provider failure",
			error: new AIError({
				code: "provider-unavailable",
				retryable: true,
				retryAfterMs: 60_000,
				statusCode: 503,
			}),
			work: "retry-waiting",
			nextEligibleAt: "2026-07-28T00:01:00.000Z",
		},
	])("classifies $name without conflating retry state with rate limiting", async (sample) => {
		const { controller } = fixture({ provider: new FailingStreamProvider(sample.error) });
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;

		await controller.sendMessage(sessionId, "Try the provider");

		expect(await controller.getSnapshot()).toMatchObject({
			work: sample.work,
			nextEligibleAt: sample.nextEligibleAt,
			error: { code: sample.error.code, retryable: true },
		});
	});

	it("выходит из «офлайна» на ближайшем обновлении вида, без повторного OAuth", async () => {
		// Пропавший на десять секунд Wi-Fi залипал в connection === "offline":
		// отправка заблокирована (send требует "connected"), а единственная кнопка
		// в шапке — «Подключить», то есть полный PKCE-флоу с внешним браузером.
		let online = false;
		const { controller } = fixture({
			provider: new FailingStreamProvider(
				new AIError({
					code: "network",
					retryable: true,
					retryAfterMs: null,
					statusCode: null,
				}),
			),
			connection: {
				isConnected: async () => online,
				connect: async () => undefined,
				disconnect: async () => undefined,
			},
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;
		online = true;
		await controller.sendMessage(sessionId, "Try the provider");

		const seen: string[] = [];
		const unsubscribe = controller.subscribe((event) => {
			if (event.type === "snapshot") seen.push(event.snapshot.connection);
		});
		await controller.refresh();
		unsubscribe();

		expect(seen).toEqual(["connected"]);
	});

	it("не выдаёт «connected», если связи действительно нет", async () => {
		let online = true;
		const { controller } = fixture({
			provider: new FailingStreamProvider(
				new AIError({
					code: "network",
					retryable: true,
					retryAfterMs: null,
					statusCode: null,
				}),
			),
			connection: {
				isConnected: async () => online,
				connect: async () => undefined,
				disconnect: async () => undefined,
			},
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;
		await controller.sendMessage(sessionId, "Try the provider");
		online = false;

		const seen: string[] = [];
		const unsubscribe = controller.subscribe((event) => {
			if (event.type === "snapshot") seen.push(event.snapshot.connection);
		});
		await controller.refresh();
		unsubscribe();

		expect(seen).toEqual(["disconnected"]);
	});

	it("preserves a fail-closed configuration error at the UI boundary", async () => {
		const { controller } = fixture({
			connection: {
				isConnected: async () => false,
				connect: async () => {
					throw new AIError({
						code: "configuration",
						retryable: false,
						retryAfterMs: null,
						statusCode: null,
					});
				},
				disconnect: async () => undefined,
			},
		});
		await controller.connect();
		expect(await controller.getSnapshot()).toMatchObject({
			connection: "disconnected",
			error: { code: "configuration", retryable: false },
		});
	});

	it("surfaces structured task links and one-shot undo for reversible tools", async () => {
		const undo = vi.fn(async () => undefined);
		const execute = vi.fn(async () => ({ value: { taskId: "task-1" }, undo }));
		let registryId = 0;
		const tools = new ToolRegistry(() => `tool-${++registryId}`);
		tools.register({
			name: "update_task",
			description: "Update task",
			parameters: { type: "object" },
			schema: z.object({ taskId: z.string() }).strict(),
			risk: "reversible-write",
			execute,
		});
		const { controller } = fixture({
			provider: new ToolCallingProvider({
				id: "call-update",
				name: "update_task",
				arguments: { taskId: "task-1" },
			}),
			tools,
			taskLink: (taskId) => ({ id: taskId, label: "Linked task" }),
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;
		await controller.sendMessage(sessionId, "Update it");
		const snapshot = await controller.getSnapshot();
		expect(
			snapshot.messages.find((message) => message.content.includes("task-1"))?.taskLinks,
		).toEqual([{ id: "task-1", label: "Linked task" }]);
		const activity = snapshot.toolActivity.find((item) => item.id === "call-update");
		expect(activity?.undoId).toBe("tool-1");
		expect(execute).toHaveBeenCalledWith(
			{ taskId: "task-1" },
			{
				sessionId,
				actualModel: "free/tool-model",
				signal: expect.any(AbortSignal),
			},
		);
		await controller.undoToolAction(activity!.undoId!);
		expect(undo).toHaveBeenCalledOnce();
		expect(
			(await controller.getSnapshot()).toolActivity.find((item) => item.id === "call-update"),
		).toMatchObject({ summary: "Undone", undoId: null });
		await expect(controller.undoToolAction("tool-1")).rejects.toThrow("undo-not-found");
	});

	it("keeps a cancelled session guarded until its active tool settles", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		let toolSignal: AbortSignal | undefined;
		const mutate = vi.fn();
		const tools = new ToolRegistry();
		tools.register({
			name: "update_task",
			description: "Update task",
			parameters: { type: "object" },
			schema: z.object({ taskId: z.string() }).strict(),
			risk: "reversible-write",
			execute: async (_input, context) => {
				toolSignal = context?.signal;
				markToolStarted();
				await toolGate;
				if (context?.signal?.aborted) {
					const error = new Error("cancelled-before-write");
					error.name = "AbortError";
					throw error;
				}
				mutate();
				return { value: null, undo: async () => undefined };
			},
		});
		const { controller, sessions } = fixture({
			provider: new ToolCallingProvider({
				id: "call-update",
				name: "update_task",
				arguments: { taskId: "task-1" },
			}),
			tools,
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;

		const first = controller.sendMessage(sessionId, "First turn");
		await toolStarted;
		await controller.cancelResponse(sessionId);

		expect(toolSignal?.aborted).toBe(true);
		await controller.sendMessage(sessionId, "Overlapping turn");
		expect(
			(await sessions.load(sessionId)).messages.filter(
				(record) => record.message.role === "user",
			),
		).toHaveLength(1);

		releaseTool();
		await first;

		expect(mutate).not.toHaveBeenCalled();
		expect(await controller.getSnapshot()).toMatchObject({
			work: "idle",
			error: { code: "cancelled", retryable: false },
		});
	});

	it("does not append a tool result or continue after cancellation wins an atomic return race", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const mutate = vi.fn();
		const tools = new ToolRegistry();
		tools.register({
			name: "update_task",
			description: "Update task",
			parameters: { type: "object" },
			schema: z.object({ taskId: z.string() }).strict(),
			risk: "reversible-write",
			execute: async () => {
				markToolStarted();
				await toolGate;
				mutate();
				return { value: { updated: true }, undo: async () => undefined };
			},
		});
		const { controller, sessions } = fixture({
			provider: new ToolCallingProvider({
				id: "call-update",
				name: "update_task",
				arguments: { taskId: "task-1" },
			}),
			tools,
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;

		const response = controller.sendMessage(sessionId, "Update it");
		await toolStarted;
		await controller.cancelResponse(sessionId);
		releaseTool();
		await response;

		const loaded = await sessions.load(sessionId);
		expect(mutate).toHaveBeenCalledOnce();
		expect(loaded.messages.some((record) => record.message.role === "tool")).toBe(false);
		expect(
			loaded.messages.some(
				(record) =>
					record.message.role === "assistant" && record.message.content === "Done",
			),
		).toBe(false);
		expect(await controller.getSnapshot()).toMatchObject({
			work: "idle",
			error: { code: "cancelled", retryable: false },
		});
	});

	it("cancels inbox processing before disconnecting provider credentials", async () => {
		const order: string[] = [];
		const { controller } = fixture({
			cancelInboxProcessing: () => {
				order.push("cancel-inbox");
			},
			connection: {
				isConnected: async () => true,
				connect: async () => undefined,
				disconnect: async () => {
					order.push("disconnect-provider");
				},
			},
		});

		await controller.disconnect();

		expect(order).toEqual(["cancel-inbox", "disconnect-provider"]);
	});

	it("leaves streaming state and reports a redacted failure when a tool throws", async () => {
		const tools = new ToolRegistry();
		tools.register({
			name: "read_task",
			description: "Read task",
			parameters: { type: "object" },
			schema: z.object({ taskId: z.string() }).strict(),
			risk: "read",
			execute: async () => {
				throw new Error("sensitive adapter detail");
			},
		});
		const { controller } = fixture({
			provider: new ToolCallingProvider({
				id: "call-read",
				name: "read_task",
				arguments: { taskId: "task-1" },
			}),
			tools,
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;

		await expect(controller.sendMessage(sessionId, "Read it")).resolves.toBeUndefined();

		const snapshot = await controller.getSnapshot();
		expect(snapshot.work).toBe("idle");
		expect(snapshot.error).toEqual({
			code: "unknown",
			retryable: false,
			retryAfterMs: null,
		});
		expect(snapshot.toolActivity).toContainEqual(
			expect.objectContaining({
				id: "call-read",
				state: "failed",
				summary: "Tool execution failed",
			}),
		);
		expect(JSON.stringify(snapshot)).not.toContain("sensitive adapter detail");
	});

	it("keeps destructive tool calls pending with affected task links until approval", async () => {
		const execute = vi.fn(async () => ({ value: { deleted: true } }));
		const tools = new ToolRegistry(() => "approval-1");
		tools.register({
			name: "delete_task",
			description: "Delete task",
			parameters: { type: "object" },
			schema: z.object({ taskId: z.string() }).strict(),
			risk: "destructive-or-bulk",
			preview: ({ taskId }) => `Delete ${taskId}`,
			execute,
		});
		const { controller } = fixture({
			provider: new ToolCallingProvider({
				id: "call-delete",
				name: "delete_task",
				arguments: { taskId: "task-1" },
			}),
			tools,
			taskLink: (taskId) => ({ id: taskId, label: "Linked task" }),
		});
		await controller.createChat();
		const sessionId = (await controller.getSnapshot()).activeSessionId!;
		await controller.sendMessage(sessionId, "Delete it");
		const pending = (await controller.getSnapshot()).pendingApprovals;
		expect(pending).toEqual([
			expect.objectContaining({
				id: "approval-1",
				risk: "delete",
				taskLinks: [{ id: "task-1", label: "Linked task" }],
			}),
		]);
		expect(execute).not.toHaveBeenCalled();
		await controller.resolveApproval("approval-1", false);
		expect(execute).not.toHaveBeenCalled();
		expect((await controller.getSnapshot()).pendingApprovals).toEqual([]);
	});
});
