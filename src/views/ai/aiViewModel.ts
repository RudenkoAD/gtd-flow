/**
 * UI-only contract for the embedded AI conversation.  The implementation that
 * owns credentials, storage and validated tools adapts to this port; the view
 * deliberately cannot reach those capabilities directly.
 */

export type AIViewConnectionState = "connected" | "connecting" | "disconnected" | "offline";
export type AIViewWorkState =
	"idle" | "streaming" | "queued" | "rate-limited" | "retry-waiting" | "offline";

export type AIViewErrorCode =
	| "authentication"
	| "cancelled"
	| "configuration"
	| "invalid-response"
	| "network"
	| "provider-unavailable"
	| "rate-limited"
	| "unknown";

/**
 * Error payloads intentionally contain classification only.  In particular,
 * provider response bodies, prompts, task text and credentials must never be
 * put in this view contract.
 */
export interface AIViewError {
	code: AIViewErrorCode;
	retryable: boolean;
	retryAfterMs: number | null;
}

export interface AIViewTaskLink {
	id: string;
	label: string;
}

export interface AIViewSession {
	id: string;
	title: string;
	kind: "chat" | "inbox-processing";
	updatedAt: string;
	actualModel: string | null;
}

export interface AIViewMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	createdAt: string;
	actualModel: string | null;
	taskLinks: readonly AIViewTaskLink[];
}

export interface AIViewToolActivity {
	id: string;
	name: string;
	state: "requested" | "running" | "completed" | "failed";
	/** A human-readable, deliberately bounded progress summary; never raw arguments/output. */
	summary: string | null;
	/** One-shot local undo handle for a reversible write; never model-controlled. */
	undoId: string | null;
}

export interface AIViewApproval {
	id: string;
	title: string;
	summary: string;
	risk: "delete" | "bulk" | "destructive";
	taskLinks: readonly AIViewTaskLink[];
}

export interface AIViewQuestion {
	id: string;
	text: string;
	affectedFields: readonly ("duration" | "cognitive" | "emotional" | "physical" | "scope")[];
	task: AIViewTaskLink;
}

/** Durable inbox-processing state. Reading it must never initiate network work. */
export interface AIViewQueueStatus {
	waitingCount: number;
	processingCount: number;
	state: "idle" | "processing" | "queued" | "rate-limited" | "retry-waiting";
	nextEligibleAt: string | null;
	/** Redacted, durable provider failure classification for the selected waiting run. */
	errorCode: AIViewErrorCode | null;
}

/** The durable/server-side portion of what the UI renders. */
export interface AIViewSnapshot {
	sessions: readonly AIViewSession[];
	activeSessionId: string | null;
	messages: readonly AIViewMessage[];
	toolActivity: readonly AIViewToolActivity[];
	pendingApprovals: readonly AIViewApproval[];
	pendingQuestions: readonly AIViewQuestion[];
	connection: AIViewConnectionState;
	work: AIViewWorkState;
	actualModel: string | null;
	nextEligibleAt: string | null;
	error: AIViewError | null;
	queue: AIViewQueueStatus;
}

export interface AIViewStreamingMessage {
	id: string;
	content: string;
	actualModel: string | null;
}

/** Complete local render state. `draft` and `streaming` are intentionally not persisted. */
export interface AIViewState extends AIViewSnapshot {
	draft: string;
	streaming: AIViewStreamingMessage | null;
}

export type AIViewEvent =
	| { type: "snapshot"; snapshot: AIViewSnapshot }
	| { type: "draft-changed"; draft: string }
	| { type: "response-started"; messageId: string; actualModel: string }
	| { type: "text-delta"; messageId: string; text: string }
	| { type: "response-completed"; message: AIViewMessage }
	| { type: "tool-activity"; activity: AIViewToolActivity }
	| { type: "response-failed"; error: AIViewError; nextEligibleAt?: string | null };

/**
 * The only AI surface injected into the ItemView.  It contains presentation
 * data and narrowly-scoped user intents, not the provider, vault, filesystem,
 * Obsidian app instance, prompts, or credentials.
 */
export interface AIViewPort {
	getSnapshot(): Promise<AIViewSnapshot>;
	subscribe(listener: (event: AIViewEvent) => void): () => void;
	createChat(): Promise<void>;
	selectSession(sessionId: string): Promise<void>;
	sendMessage(sessionId: string, text: string): Promise<void>;
	cancelResponse(sessionId: string): Promise<void>;
	resolveApproval(approvalId: string, approved: boolean): Promise<void>;
	answerQuestion(questionId: string, answer: string): Promise<void>;
	undoToolAction(undoId: string): Promise<void>;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	openTask(taskId: string): Promise<void>;
}

const EMPTY_SNAPSHOT: AIViewSnapshot = {
	sessions: [],
	activeSessionId: null,
	messages: [],
	toolActivity: [],
	pendingApprovals: [],
	pendingQuestions: [],
	connection: "disconnected",
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

export const INITIAL_AI_VIEW_STATE: AIViewState = {
	...EMPTY_SNAPSHOT,
	draft: "",
	streaming: null,
};

/** Pure state reducer; adapters can feed it runtime events without Svelte. */
export function reduceAIViewState(state: AIViewState, event: AIViewEvent): AIViewState {
	switch (event.type) {
		case "snapshot":
			return {
				...copySnapshot(event.snapshot),
				draft: state.draft,
				streaming: event.snapshot.work === "streaming" ? state.streaming : null,
			};
		case "draft-changed":
			return { ...state, draft: event.draft };
		case "response-started":
			return {
				...state,
				work: "streaming",
				actualModel: event.actualModel,
				error: null,
				streaming: { id: event.messageId, content: "", actualModel: event.actualModel },
			};
		case "text-delta": {
			const current = state.streaming;
			if (current === null || current.id !== event.messageId) {
				return {
					...state,
					work: "streaming",
					streaming: {
						id: event.messageId,
						content: event.text,
						actualModel: state.actualModel,
					},
				};
			}
			return {
				...state,
				streaming: { ...current, content: `${current.content}${event.text}` },
			};
		}
		case "response-completed":
			return {
				...state,
				work: "idle",
				actualModel: event.message.actualModel ?? state.actualModel,
				messages: upsertById(state.messages, event.message),
				streaming: null,
			};
		case "tool-activity":
			return {
				...state,
				toolActivity: upsertById(state.toolActivity, event.activity),
			};
		case "response-failed":
			return {
				...state,
				connection: event.error.code === "network" ? "offline" : state.connection,
				work: workForError(event.error),
				nextEligibleAt: event.nextEligibleAt ?? state.nextEligibleAt,
				error: copyError(event.error),
				streaming: null,
			};
	}
}

/**
 * Framework-agnostic controller that turns a port into a subscribable view
 * model.  All rejected actions become a redacted error classification; it
 * intentionally never reads Error.message.
 */
export class AIViewModel {
	private state: AIViewState = INITIAL_AI_VIEW_STATE;
	private readonly listeners = new Set<(state: AIViewState) => void>();
	private unsubscribePort: (() => void) | null = null;
	private started = false;
	private sendPending = false;

	constructor(private readonly port: AIViewPort | null) {}

	get snapshot(): AIViewState {
		return this.state;
	}

	subscribe(listener: (state: AIViewState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.started || this.port === null) return;
		this.started = true;
		try {
			this.dispatch({ type: "snapshot", snapshot: await this.port.getSnapshot() });
			this.unsubscribePort = this.port.subscribe((event) => this.dispatch(event));
		} catch {
			this.dispatch({ type: "response-failed", error: unknownViewError() });
		}
	}

	dispose(): void {
		this.unsubscribePort?.();
		this.unsubscribePort = null;
		this.started = false;
	}

	setDraft(draft: string): void {
		this.dispatch({ type: "draft-changed", draft });
	}

	createChat(): Promise<boolean> {
		if (this.state.work === "streaming" || this.sendPending) return Promise.resolve(false);
		return this.invoke((port) => port.createChat());
	}

	selectSession(sessionId: string): Promise<boolean> {
		if (this.state.work === "streaming" || this.sendPending) return Promise.resolve(false);
		return this.invoke((port) => port.selectSession(sessionId));
	}

	send(): Promise<boolean> {
		const sessionId = this.state.activeSessionId;
		const draftAtSend = this.state.draft;
		const text = this.state.draft.trim();
		if (
			sessionId === null ||
			text.length === 0 ||
			this.state.connection !== "connected" ||
			this.state.work === "streaming" ||
			this.sendPending
		) {
			return Promise.resolve(false);
		}
		this.sendPending = true;
		return this.invoke(async (port) => {
			await port.sendMessage(sessionId, text);
			// Do not erase a new draft typed while the response was in flight.
			if (this.state.draft === draftAtSend) this.setDraft("");
		}).finally(() => {
			this.sendPending = false;
		});
	}

	cancel(): Promise<boolean> {
		const sessionId = this.state.activeSessionId;
		return sessionId === null
			? Promise.resolve(false)
			: this.invoke((port) => port.cancelResponse(sessionId));
	}

	resolveApproval(approvalId: string, approved: boolean): Promise<boolean> {
		return this.invoke((port) => port.resolveApproval(approvalId, approved));
	}

	answerQuestion(questionId: string, answer: string): Promise<boolean> {
		const trimmed = answer.trim();
		return trimmed.length === 0
			? Promise.resolve(false)
			: this.invoke((port) => port.answerQuestion(questionId, trimmed));
	}

	undoToolAction(undoId: string): Promise<boolean> {
		return this.invoke((port) => port.undoToolAction(undoId));
	}

	connect(): Promise<boolean> {
		return this.invoke((port) => port.connect());
	}

	disconnect(): Promise<boolean> {
		return this.invoke((port) => port.disconnect());
	}

	openTask(taskId: string): Promise<boolean> {
		return this.invoke((port) => port.openTask(taskId));
	}

	private dispatch(event: AIViewEvent): void {
		this.state = reduceAIViewState(this.state, event);
		for (const listener of this.listeners) listener(this.state);
	}

	private async invoke(action: (port: AIViewPort) => Promise<void>): Promise<boolean> {
		if (this.port === null) return false;
		try {
			await action(this.port);
			return true;
		} catch {
			this.dispatch({ type: "response-failed", error: unknownViewError() });
			return false;
		}
	}
}

export function connectionLabel(state: AIViewState): string {
	if (state.connection === "connected") return "Connected";
	if (state.connection === "connecting") return "Connecting…";
	if (state.connection === "offline") return "Offline";
	return "Disconnected";
}

export function workLabel(state: AIViewState): string | null {
	switch (state.work) {
		case "streaming":
			return "Responding…";
		case "queued":
			return "Queued — waiting for free capacity";
		case "rate-limited":
			return state.nextEligibleAt === null
				? "Rate limited — waiting for free capacity"
				: `Rate limited — retry after ${state.nextEligibleAt}`;
		case "retry-waiting":
			return state.nextEligibleAt === null
				? "Temporarily unavailable — waiting to retry"
				: `Temporarily unavailable — retry after ${state.nextEligibleAt}`;
		case "offline":
			return "Offline — requests stay local until reconnected";
		case "idle":
			return null;
	}
}

export function errorLabel(error: AIViewError): string {
	const labels: Record<AIViewErrorCode, string> = {
		authentication: "Authentication required",
		cancelled: "Response cancelled",
		configuration: "Choose AI privacy and credential settings first",
		"invalid-response": "Invalid provider response",
		network: "Network unavailable",
		"provider-unavailable": "Provider unavailable",
		"rate-limited": "Rate limited",
		unknown: "AI action failed",
	};
	return labels[error.code];
}

function copySnapshot(snapshot: AIViewSnapshot): AIViewSnapshot {
	return {
		...snapshot,
		sessions: [...snapshot.sessions],
		messages: [...snapshot.messages],
		toolActivity: [...snapshot.toolActivity],
		pendingApprovals: [...snapshot.pendingApprovals],
		pendingQuestions: [...snapshot.pendingQuestions],
		error: snapshot.error === null ? null : copyError(snapshot.error),
		queue: { ...snapshot.queue },
	};
}

function copyError(error: AIViewError): AIViewError {
	return { code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
}

function workForError(error: AIViewError): AIViewWorkState {
	if (error.code === "rate-limited") return "rate-limited";
	if (error.code === "network") return "offline";
	if (error.retryable) return "retry-waiting";
	return "idle";
}

function unknownViewError(): AIViewError {
	return { code: "unknown", retryable: false, retryAfterMs: null };
}

function upsertById<T extends { id: string }>(items: readonly T[], item: T): readonly T[] {
	const index = items.findIndex((current) => current.id === item.id);
	if (index === -1) return [...items, item];
	return items.map((current, currentIndex) => (currentIndex === index ? item : current));
}
