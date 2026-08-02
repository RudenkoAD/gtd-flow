import { describe, expect, it, vi } from "vitest";
import { createGtdView } from "../createView";
import type GtdFlowPlugin from "../../main";
import { AIView } from "./AIView";
import {
	AIViewModel,
	INITIAL_AI_VIEW_STATE,
	reduceAIViewState,
	workLabel,
	type AIViewEvent,
	type AIViewPort,
	type AIViewSnapshot,
} from "./aiViewModel";
import { VIEW_META, VIEW_TYPES } from "../registry";

const timestamp = "2026-07-28T12:00:00.000Z";

function snapshot(): AIViewSnapshot {
	return {
		sessions: [
			{
				id: "session-1",
				title: "Plan weekly review",
				kind: "chat",
				updatedAt: timestamp,
				actualModel: null,
			},
		],
		activeSessionId: "session-1",
		messages: [],
		toolActivity: [],
		pendingApprovals: [],
		pendingQuestions: [],
		connection: "connected",
		work: "idle",
		actualModel: null,
		nextEligibleAt: null,
		error: null,
		queue: {
			waitingCount: 0,
			processingCount: 0,
			state: "idle",
			nextEligibleAt: null,
			errorCode: null,
		},
	};
}

function viewPort(overrides: Partial<AIViewPort> = {}): AIViewPort {
	return {
		getSnapshot: async () => snapshot(),
		subscribe: () => () => undefined,
		createChat: async () => undefined,
		selectSession: async () => undefined,
		sendMessage: async () => undefined,
		cancelResponse: async () => undefined,
		resolveApproval: async () => undefined,
		answerQuestion: async () => undefined,
		undoToolAction: async () => undefined,
		connect: async () => undefined,
		disconnect: async () => undefined,
		openTask: async () => undefined,
		...overrides,
	};
}

describe("AI view state reducer", () => {
	it("shows a streamed response immediately, then persists its completed message", () => {
		let state = reduceAIViewState(INITIAL_AI_VIEW_STATE, {
			type: "snapshot",
			snapshot: snapshot(),
		});
		state = reduceAIViewState(state, {
			type: "response-started",
			messageId: "assistant-1",
			actualModel: "openrouter/free-picked-model",
		});
		state = reduceAIViewState(state, {
			type: "text-delta",
			messageId: "assistant-1",
			text: "First ",
		});
		state = reduceAIViewState(state, {
			type: "text-delta",
			messageId: "assistant-1",
			text: "answer",
		});

		expect(state.work).toBe("streaming");
		expect(state.streaming).toEqual({
			id: "assistant-1",
			content: "First answer",
			actualModel: "openrouter/free-picked-model",
		});

		state = reduceAIViewState(state, {
			type: "response-completed",
			message: {
				id: "assistant-1",
				role: "assistant",
				content: "First answer",
				createdAt: timestamp,
				actualModel: "openrouter/free-picked-model",
				taskLinks: [{ id: "task-1", label: "Weekly review" }],
			},
		});

		expect(state.work).toBe("idle");
		expect(state.streaming).toBeNull();
		expect(state.actualModel).toBe("openrouter/free-picked-model");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.taskLinks[0]?.id).toBe("task-1");
	});

	it("makes a rate limit visible and keeps only the redacted error shape", () => {
		const state = reduceAIViewState(INITIAL_AI_VIEW_STATE, {
			type: "response-failed",
			error: { code: "rate-limited", retryable: true, retryAfterMs: 30_000 },
			nextEligibleAt: "2026-07-28T12:00:30.000Z",
		});

		expect(state.work).toBe("rate-limited");
		expect(state.nextEligibleAt).toBe("2026-07-28T12:00:30.000Z");
		expect(state.error).toEqual({
			code: "rate-limited",
			retryable: true,
			retryAfterMs: 30_000,
		});
		expect(Object.keys(state.error ?? {})).toEqual(["code", "retryable", "retryAfterMs"]);
	});

	it("shows retryable provider failures as retry-waiting rather than rate-limited", () => {
		const state = reduceAIViewState(INITIAL_AI_VIEW_STATE, {
			type: "response-failed",
			error: {
				code: "provider-unavailable",
				retryable: true,
				retryAfterMs: 60_000,
			},
			nextEligibleAt: "2026-07-28T12:01:00.000Z",
		});

		expect(state.work).toBe("retry-waiting");
		expect(workLabel(state)).toBe(
			"Временно недоступно — повтор после 2026-07-28T12:01:00.000Z",
		);
		expect(workLabel(state)).not.toContain("Лимит запросов");
	});

	it("upserts tool progress without duplicating a timeline entry", () => {
		let state = reduceAIViewState(INITIAL_AI_VIEW_STATE, {
			type: "tool-activity",
			activity: {
				id: "tool-1",
				name: "find tasks",
				state: "running",
				summary: "Searching",
				undoId: null,
			},
		});
		state = reduceAIViewState(state, {
			type: "tool-activity",
			activity: {
				id: "tool-1",
				name: "find tasks",
				state: "completed",
				summary: "Found 2 tasks",
				undoId: "undo-1",
			},
		});

		expect(state.toolActivity).toEqual([
			{
				id: "tool-1",
				name: "find tasks",
				state: "completed",
				summary: "Found 2 tasks",
				undoId: "undo-1",
			},
		]);
	});
});

describe("AIViewModel", () => {
	it("hydrates from the injected port, forwards narrowly-scoped intents, and trims messages", async () => {
		const calls: string[] = [];
		const listeners = new Set<(event: AIViewEvent) => void>();
		const port: AIViewPort = {
			getSnapshot: async () => snapshot(),
			subscribe: (next) => {
				listeners.add(next);
				return () => listeners.delete(next);
			},
			createChat: async () => {
				calls.push("new");
			},
			selectSession: async (sessionId) => {
				calls.push(`select:${sessionId}`);
			},
			sendMessage: async (sessionId, text) => {
				calls.push(`send:${sessionId}:${text}`);
			},
			cancelResponse: async (sessionId) => {
				calls.push(`cancel:${sessionId}`);
			},
			resolveApproval: async (approvalId, approved) => {
				calls.push(`approval:${approvalId}:${approved}`);
			},
			answerQuestion: async (questionId, answer) => {
				calls.push(`answer:${questionId}:${answer}`);
			},
			undoToolAction: async (undoId) => {
				calls.push(`undo:${undoId}`);
			},
			connect: async () => {
				calls.push("connect");
			},
			disconnect: async () => {
				calls.push("disconnect");
			},
			openTask: async (taskId) => {
				calls.push(`task:${taskId}`);
			},
		};
		const model = new AIViewModel(port);

		await model.start();
		model.setDraft("  Make a plan  ");
		await model.createChat();
		await model.selectSession("session-1");
		await model.send();
		await model.cancel();
		await model.resolveApproval("approval-1", true);
		await model.answerQuestion("question-1", "  Friday  ");
		await model.undoToolAction("undo-1");
		await model.connect();
		await model.disconnect();
		await model.openTask("task-1");

		expect(calls).toEqual([
			"new",
			"select:session-1",
			"send:session-1:Make a plan",
			"cancel:session-1",
			"approval:approval-1:true",
			"answer:question-1:Friday",
			"undo:undo-1",
			"connect",
			"disconnect",
			"task:task-1",
		]);
		expect(model.snapshot.draft).toBe("");

		for (const listener of listeners)
			listener({
				type: "response-failed",
				error: { code: "network", retryable: true, retryAfterMs: null },
			});
		expect(model.snapshot.connection).toBe("offline");
		model.dispose();
	});

	it("redacts rejected port errors instead of exposing their message", async () => {
		const port: AIViewPort = {
			getSnapshot: async () => snapshot(),
			subscribe: () => () => undefined,
			createChat: async () => {
				throw new Error("prompt and credential text must not reach the UI");
			},
			selectSession: async () => undefined,
			sendMessage: async () => undefined,
			cancelResponse: async () => undefined,
			resolveApproval: async () => undefined,
			answerQuestion: async () => undefined,
			undoToolAction: async () => undefined,
			connect: async () => undefined,
			disconnect: async () => undefined,
			openTask: async () => undefined,
		};
		const model = new AIViewModel(port);
		await model.start();

		expect(await model.createChat()).toBe(false);
		expect(model.snapshot.error).toEqual({
			code: "unknown",
			retryable: false,
			retryAfterMs: null,
		});
		expect(JSON.stringify(model.snapshot.error)).not.toContain("credential");
	});

	it("blocks session changes and sends while a response is streaming", async () => {
		const createChat = vi.fn(async () => undefined);
		const selectSession = vi.fn(async () => undefined);
		const sendMessage = vi.fn(async () => undefined);
		const model = new AIViewModel(
			viewPort({
				getSnapshot: async () => ({ ...snapshot(), work: "streaming" }),
				createChat,
				selectSession,
				sendMessage,
			}),
		);
		await model.start();
		model.setDraft("Do not send twice");

		await expect(model.createChat()).resolves.toBe(false);
		await expect(model.selectSession("session-1")).resolves.toBe(false);
		await expect(model.send()).resolves.toBe(false);
		expect(createChat).not.toHaveBeenCalled();
		expect(selectSession).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("blocks sends while disconnected", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const model = new AIViewModel(
			viewPort({
				getSnapshot: async () => ({ ...snapshot(), connection: "disconnected" }),
				sendMessage,
			}),
		);
		await model.start();
		model.setDraft("Wait for a connection");

		await expect(model.send()).resolves.toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("keeps durable queue state separate from chat work as read-only status", async () => {
		const model = new AIViewModel(
			viewPort({
				getSnapshot: async () => ({
					...snapshot(),
					queue: {
						waitingCount: 2,
						processingCount: 0,
						state: "retry-waiting",
						nextEligibleAt: "2026-07-28T12:01:00.000Z",
						errorCode: "network",
					},
				}),
			}),
		);
		await model.start();
		expect(model.snapshot.work).toBe("idle");
		expect(model.snapshot.queue).toMatchObject({
			waitingCount: 2,
			state: "retry-waiting",
			errorCode: "network",
		});
	});

	it("deduplicates an in-flight send and preserves a newly typed draft", async () => {
		let releaseSend: (() => void) | undefined;
		const sendMessage = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseSend = resolve;
				}),
		);
		const model = new AIViewModel(viewPort({ sendMessage }));
		await model.start();
		model.setDraft("First message");

		const first = model.send();
		await expect(model.send()).resolves.toBe(false);
		await expect(model.createChat()).resolves.toBe(false);
		await expect(model.selectSession("session-1")).resolves.toBe(false);
		expect(sendMessage).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith("session-1", "First message");

		model.setDraft("Second message");
		if (releaseSend === undefined) throw new Error("send fixture did not start");
		releaseSend();
		await expect(first).resolves.toBe(true);
		expect(model.snapshot.draft).toBe("Second message");
	});
});

describe("AI view registry and construction", () => {
	const leaf = {} as never;
	const plugin = {
		settings: { activeNamespace: "Общее", namespaces: [] },
	} as unknown as GtdFlowPlugin;

	it("registers GTD: AI under its stable view type", () => {
		expect(VIEW_TYPES.ai).toBe("gtd-flow-ai");
		expect(VIEW_META.ai).toMatchObject({
			kind: "ai",
			type: "gtd-flow-ai",
			displayText: "GTD: AI",
		});
	});

	it("constructs the dedicated AI ItemView through the common factory", () => {
		const view = createGtdView(leaf, plugin, VIEW_META.ai);
		expect(view).toBeInstanceOf(AIView);
		expect(view.getViewType()).toBe(VIEW_TYPES.ai);
	});
});
