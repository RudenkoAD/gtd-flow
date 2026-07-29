import type { Task } from "../../src/core/model/Task";
import { createScopeCatalog } from "../../src/core/scope/scope";
import { AgentRuntime } from "../../src/ai/core/AgentRuntime";
import { AIError } from "../../src/ai/core/errors";
import type { AgentToolCall } from "../../src/ai/core/messages";
import { AIViewController } from "../../src/ai/integration/AIViewController";
import { RepositoryProcessingPersistence } from "../../src/ai/integration/ProcessingPersistence";
import { InboxProcessor } from "../../src/ai/processing/InboxProcessor";
import { QuestionService } from "../../src/ai/processing/QuestionService";
import type {
	AIProviderPort,
	ProviderJsonRequest,
	ProviderRequest,
	ProviderStreamEvent,
} from "../../src/ai/providers/AIProviderPort";
import { EstimateFeedbackService } from "../../src/services/EstimateFeedbackService";
import { RunRepository } from "../../src/ai/storage/RunRepository";
import { SessionRepository } from "../../src/ai/storage/SessionRepository";
import type { AtomicFilePort } from "../../src/ai/storage/AtomicFilePort";
import { createGtdToolRegistry } from "../../src/ai/tools/gtdTools";
import type { AIViewPort } from "../../src/views/ai/aiViewModel";

const NOW = "2026-07-28T12:00:00.000Z";
const TASK_ID = "task-1";

class MemoryFiles implements AtomicFilePort {
	private readonly files = new Map<string, string>();

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

	async delete(path: string): Promise<void> {
		this.files.delete(path);
	}
}

function task(overrides: Partial<Task> = {}): Task {
	return {
		key: `id:${TASK_ID}`,
		taskId: TASK_ID,
		filePath: "GTD/Inbox.md",
		lineStart: 0,
		lineEnd: 0,
		parentLine: null,
		heading: null,
		description: "Prepare launch notes",
		rawLine: "- [ ] Prepare launch notes 🆔 task-1",
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
		recurrence: null,
		nextSpawn: null,
		spawnedFrom: null,
		excludedDates: [],
		priority: "none",
		dependsOn: [],
		location: null,
		durationMinutes: null,
		cognitiveIntensity: null,
		emotionalIntensity: null,
		physicalIntensity: null,
		scopeId: null,
		tags: ["#launch"],
		container: "inbox",
		projectActive: true,
		...overrides,
	};
}

class DeterministicProvider implements AIProviderPort {
	private nextInboxError = false;
	lastInboxFields: string | null = null;
	private response = 0;

	failNextInboxRun(): void {
		this.nextInboxError = true;
	}

	async complete(): Promise<never> {
		throw new Error("unused");
	}

	async completeJson<T>(request: ProviderJsonRequest<T>) {
		if (this.nextInboxError) {
			this.nextInboxError = false;
			throw new AIError({
				code: "rate-limited",
				retryable: true,
				retryAfterMs: 1_000,
				statusCode: 429,
			});
		}
		const user = request.messages.find((message) => message.role === "user");
		if (user === undefined) throw new Error("missing-inbox-payload");
		const payload = JSON.parse(user.content) as {
			onlyFields: string[] | null;
			tasks: Array<{ taskId: string }>;
		};
		this.lastInboxFields = payload.onlyFields?.join(", ") ?? "all estimate fields";
		const result = {
			tasks: payload.tasks.map(({ taskId }) => ({
				taskId,
				durationMinutes: 90,
				intensity: { cognitive: 4, emotional: 2, physical: 0 },
				scopeId: "work",
				confidence: {
					duration: 0.8,
					cognitive: 0.8,
					emotional: 0.8,
					physical: 0.8,
					scope: 0.8,
				},
				questions:
					payload.onlyFields === null
						? [
								{
									id: "review-time",
									text: "Does this include review time?",
									affectedFields: ["duration"],
								},
							]
						: [],
			})),
		};
		const json = request.responseSchema.parse(result);
		const id = `inbox-response-${++this.response}`;
		return {
			provider: "openrouter",
			responseId: id,
			actualModel: "browser/deterministic-mvp",
			message: {
				id,
				role: "assistant" as const,
				content: JSON.stringify(result),
				createdAt: NOW,
				provider: "openrouter",
				model: "browser/deterministic-mvp",
			},
			toolCalls: [],
			json,
		};
	}

	async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
		const latest = request.messages.at(-1);
		const toolResultExists = latest?.role === "tool";
		const userText = [...request.messages]
			.reverse()
			.find((message) => message.role === "user")?.content;
		const responseId = `chat-response-${++this.response}`;
		const actualModel = "browser/deterministic-mvp";
		yield { type: "response-started", provider: "openrouter", responseId, actualModel };

		if (toolResultExists) {
			yield {
				type: "response-completed",
				completion: completion(responseId, "Tool action completed.", actualModel),
			};
			return;
		}

		const call = toolCallFor(userText);
		if (call !== null) {
			yield { type: "tool-call", call };
			yield {
				type: "response-completed",
				completion: {
					...completion(responseId, `Requested ${call.name}.`, actualModel),
					message: {
						...completion(responseId, `Requested ${call.name}.`, actualModel).message,
						toolCalls: [call],
					},
					toolCalls: [call],
				},
			};
			return;
		}

		yield { type: "text-delta", text: "Acknowledged" };
		yield {
			type: "response-completed",
			completion: completion(
				responseId,
				`Acknowledged${latest === undefined ? "" : "."}`,
				actualModel,
			),
		};
	}
}

function completion(id: string, content: string, model: string) {
	return {
		provider: "openrouter",
		responseId: id,
		actualModel: model,
		message: {
			id,
			role: "assistant" as const,
			content,
			createdAt: NOW,
			provider: "openrouter",
			model,
		},
		toolCalls: [],
	};
}

function toolCallFor(text: string | undefined): AgentToolCall | null {
	if (text?.toLocaleLowerCase().includes("create a follow-up")) {
		return {
			id: "call-create-follow-up",
			name: "create_task",
			arguments: { text: "Follow up on launch notes", inbox: true },
		};
	}
	if (text?.toLocaleLowerCase().includes("delete the task")) {
		return { id: "call-delete-task", name: "delete_task", arguments: { taskId: TASK_ID } };
	}
	return null;
}

export interface BrowserAiFixture {
	port: AIViewPort;
	start(): Promise<void>;
	processInbox(): Promise<void>;
	correctDuration(): Promise<void>;
	rateLimit(): Promise<void>;
	retry(): Promise<void>;
	snapshot(): {
		duration: number | null;
		cognitive: number | null;
		emotional: number | null;
		physical: number | null;
		scope: string | null;
		lastFields: string | null;
		status: string;
		deleted: boolean;
		createdTasks: number;
	};
	subscribe(listener: () => void): () => void;
}

export function createBrowserAiFixture(): BrowserAiFixture {
	const files = new MemoryFiles();
	const sessions = new SessionRepository(files);
	const runs = new RunRepository(files);
	const history = new EstimateFeedbackService(files, () => new Date(NOW));
	const provider = new DeterministicProvider();
	let clock = new Date(NOW).getTime();
	const now = () => new Date((clock += 1_000));
	let ids = 0;
	const nextId = () => `browser-${++ids}`;
	let current = task();
	let deleted = false;
	let createdTasks = 0;
	let status = "Ready";
	let queueWaiting = false;
	const listeners = new Set<() => void>();
	const changed = () => listeners.forEach((listener) => listener());
	const taskPort = {
		listInboxTasks: async () => (deleted ? [] : [current]),
		listTasksByKeys: async (keys: readonly string[]) =>
			deleted || !keys.includes(current.key) ? [] : [current],
		ensureTaskId: async () => ({ ok: true as const, taskId: TASK_ID }),
		applyMetadata: async (
			_key: string,
			patch: Partial<
				Pick<
					Task,
					| "durationMinutes"
					| "cognitiveIntensity"
					| "emotionalIntensity"
					| "physicalIntensity"
					| "scopeId"
				>
			>,
		) => {
			current = { ...current, ...patch };
			changed();
			return { ok: true as const };
		},
	};
	const processor = new InboxProcessor({
		runtime: new AgentRuntime(provider),
		tasks: taskPort,
		scopes: async () =>
			createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
		persistence: new RepositoryProcessingPersistence(sessions, runs),
		history,
		now,
		createId: nextId,
		random: () => 0,
	});
	const questions = new QuestionService({
		history,
		findTask: (taskId) => (taskId === TASK_ID && !deleted ? current : null),
		now,
		createId: nextId,
	});
	const tools = createGtdToolRegistry(
		{
			searchVault: async () => [],
			readNote: async () => "",
			listTasks: async () => (deleted ? [] : [current]),
			getTask: async () => (deleted ? null : current),
			createTask: async () => {
				createdTasks++;
				changed();
				return {
					value: { created: true },
					undo: async () => {
						createdTasks--;
						changed();
					},
				};
			},
			updateTask: async () => ({ value: {}, undo: async () => undefined }),
			moveTask: async () => ({ value: {}, undo: async () => undefined }),
			deleteTask: async () => {
				deleted = true;
				changed();
				return { value: { deleted: true } };
			},
			deleteFile: async () => ({ value: {} }),
			bulkUpdateTasks: async () => ({ value: {} }),
		},
		nextId,
	);
	const controller = new AIViewController({
		runtime: new AgentRuntime(provider),
		sessions,
		tools,
		connection: {
			isConnected: async () => true,
			connect: async () => undefined,
			disconnect: async () => undefined,
		},
		questions,
		queue: {
			status: async () =>
				queueWaiting
					? {
							waitingCount: 1,
							processingCount: 0,
							state: "rate-limited" as const,
							nextEligibleAt: "2026-07-28T12:01:00.000Z",
							errorCode: "rate-limited" as const,
						}
					: {
							waitingCount: 0,
							processingCount: 0,
							state: "idle" as const,
							nextEligibleAt: null,
							errorCode: null,
						},
		},
		openTask: async () => undefined,
		taskLink: (id) => (id === TASK_ID ? { id, label: current.description } : null),
		now,
		createId: nextId,
	});
	controller.subscribe(() => changed());

	return {
		port: controller,
		start: async () => {
			await controller.createChat();
			changed();
		},
		processInbox: async () => {
			const result = await processor.process();
			status =
				result.state === "awaiting_answers" ? "Provisional values applied" : result.state;
			changed();
		},
		correctDuration: async () => {
			const previous = current.durationMinutes;
			await taskPort.applyMetadata(current.key, { durationMinutes: 120 });
			await history.append({
				schemaVersion: 1,
				id: nextId(),
				kind: "estimate-manual",
				taskId: TASK_ID,
				createdAt: now().toISOString(),
				runId: null,
				sessionId: null,
				field: "duration",
				previousValue: previous,
				value: 120,
			});
			status = "Duration corrected and locked by user";
			changed();
		},
		rateLimit: async () => {
			provider.failNextInboxRun();
			const result = await processor.process({ taskKeys: [current.key] });
			status =
				result.state === "rate_limited"
					? "Rate limited — waiting for explicit retry"
					: result.state;
			queueWaiting = result.state === "rate_limited";
			changed();
		},
		retry: async () => {
			const result = await processor.process({ taskKeys: [current.key] });
			status =
				result.state === "awaiting_answers" ? "Explicit retry succeeded" : result.state;
			queueWaiting = false;
			changed();
		},
		snapshot: () => ({
			duration: current.durationMinutes,
			cognitive: current.cognitiveIntensity,
			emotional: current.emotionalIntensity,
			physical: current.physicalIntensity,
			scope: current.scopeId,
			lastFields: provider.lastInboxFields,
			status,
			deleted,
			createdTasks,
		}),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
