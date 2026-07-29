import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import { createScopeCatalog } from "../../core/scope/scope";
import {
	emptyTaskProvenance,
	type EstimateField,
	type TaskEstimateProvenance,
} from "../../core/estimates/provenance";
import type {
	EstimateFeedbackEvent,
	EstimateSuggestedEvent,
	FeedbackFieldMutation,
} from "../../services/EstimateFeedbackService";
import { AgentRuntime } from "../core/AgentRuntime";
import { AIError } from "../core/errors";
import type {
	AIProviderPort,
	ProviderJsonRequest,
	ProviderRequest,
	ProviderRequestOptions,
} from "../providers/AIProviderPort";
import {
	InboxProcessor,
	type EstimateHistoryPort,
	type InboxProcessingPersistence,
} from "./InboxProcessor";

function task(overrides: Partial<Task> = {}): Task {
	return {
		key: "id:task-1",
		taskId: "task-1",
		filePath: "GTD/Inbox.md",
		lineStart: 0,
		lineEnd: 0,
		parentLine: null,
		heading: null,
		description: "Reconcile invoices",
		rawLine: "- [ ] Reconcile invoices 🆔 task-1",
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
		tags: ["#finance"],
		container: "inbox",
		projectActive: true,
		...overrides,
	};
}

class FakeProvider implements AIProviderPort {
	completeJsonCalls = 0;

	constructor(
		private readonly value: unknown,
		private readonly error: AIError | null = null,
	) {}

	async complete(_request: ProviderRequest): Promise<never> {
		throw new Error("unused");
	}

	async completeJson<T>(request: ProviderJsonRequest<T>) {
		this.completeJsonCalls++;
		if (this.error) throw this.error;
		const json = request.responseSchema.parse(this.value);
		return {
			provider: "openrouter",
			responseId: "response-1",
			actualModel: "free/model",
			message: {
				id: "assistant-1",
				role: "assistant" as const,
				content: JSON.stringify(this.value),
				createdAt: "2026-07-28T00:00:00.000Z",
				provider: "openrouter",
				model: "free/model",
			},
			toolCalls: [],
			json,
		};
	}

	async *stream(): AsyncGenerator<never> {}
}

class BatchProvider implements AIProviderPort {
	readonly batchSizes: number[] = [];

	constructor(
		private readonly failure: {
			call: number;
			error: AIError;
		} | null = null,
	) {}

	async complete(_request: ProviderRequest): Promise<never> {
		throw new Error("unused");
	}

	async completeJson<T>(request: ProviderJsonRequest<T>) {
		const userMessage = request.messages.find((item) => item.role === "user");
		if (userMessage === undefined) throw new Error("missing-user-message");
		const payload = JSON.parse(userMessage.content) as {
			tasks: Array<{ taskId: string }>;
		};
		const taskIds = payload.tasks.map((item) => item.taskId);
		this.batchSizes.push(taskIds.length);
		if (this.failure?.call === this.batchSizes.length) throw this.failure.error;
		const value = validResult(taskIds);
		const json = request.responseSchema.parse(value);
		return {
			provider: "openrouter",
			responseId: `response-${this.batchSizes.length}`,
			actualModel: "free/model",
			message: {
				id: `assistant-${this.batchSizes.length}`,
				role: "assistant" as const,
				content: JSON.stringify(value),
				createdAt: "2026-07-28T00:00:00.000Z",
				provider: "openrouter",
				model: "free/model",
			},
			toolCalls: [],
			json,
		};
	}

	async *stream(): AsyncGenerator<never> {}
}

class AbortableProvider implements AIProviderPort {
	readonly started: Promise<void>;
	private markStarted!: () => void;

	constructor() {
		this.started = new Promise((resolve) => {
			this.markStarted = resolve;
		});
	}

	async complete(): Promise<never> {
		throw new Error("unused");
	}

	completeJson<T>(
		_request: ProviderJsonRequest<T>,
		options?: ProviderRequestOptions,
	): Promise<never> {
		this.markStarted();
		return new Promise((_, reject) => {
			const rejectCancelled = (): void =>
				reject(
					new AIError({
						code: "cancelled",
						retryable: false,
						retryAfterMs: null,
						statusCode: null,
					}),
				);
			if (options?.signal?.aborted) {
				rejectCancelled();
				return;
			}
			options?.signal?.addEventListener("abort", rejectCancelled, { once: true });
		});
	}

	async *stream(): AsyncGenerator<never> {}
}

class Persistence implements InboxProcessingPersistence {
	readonly transitions: string[] = [];
	readonly runTaskIds: string[][] = [];
	readonly runInputs: Array<{
		taskIds: string[];
		attempt?: number;
		retryOfRunId?: string | null;
		initialWaiting?: {
			state: "rate_limited" | "retry_waiting";
			nextEligibleAt: string;
		};
		requestContext?: {
			onlyFields: EstimateField[] | null;
			unlockFields: EstimateField[];
			questionContext: string | null;
		};
	}> = [];
	actualModel: string | null = null;
	providerErrorCode: string | null = null;

	async createSession(): Promise<void> {}
	async appendMessage(): Promise<void> {}
	async createRun(input: {
		taskIds: string[];
		attempt?: number;
		retryOfRunId?: string | null;
		initialWaiting?: {
			state: "rate_limited" | "retry_waiting";
			nextEligibleAt: string;
		};
		requestContext?: {
			onlyFields: EstimateField[] | null;
			unlockFields: EstimateField[];
			questionContext: string | null;
		};
	}): Promise<void> {
		this.runTaskIds.push(input.taskIds);
		this.runInputs.push(input);
	}
	async transitionRun(_id: string, state: string): Promise<void> {
		this.transitions.push(state);
	}
	async recordProviderResult(
		_id: string,
		result: { actualModel: string | null; error: { code: string } | null },
	): Promise<void> {
		this.actualModel = result.actualModel;
		this.providerErrorCode = result.error?.code ?? null;
	}
}

function validResult(taskIds = ["task-1"]) {
	return {
		tasks: taskIds.map((taskId) => ({
			taskId,
			durationMinutes: 90,
			intensity: { cognitive: 4, emotional: 2, physical: 0 },
			scopeId: "work",
			confidence: {
				duration: 0.8,
				cognitive: 0.7,
				emotional: 0.6,
				physical: 0.9,
				scope: 0.95,
			},
			questions: [
				{
					id: "q-1",
					text: "Does this include review time?",
					affectedFields: ["duration"],
				},
			],
		})),
	};
}

function historyPort(
	events: EstimateFeedbackEvent[],
	provenanceForTask: (taskId: string, now: string) => Promise<TaskEstimateProvenance> = async (
		taskId,
		now,
	) => emptyTaskProvenance(taskId, now),
): EstimateHistoryPort {
	const prepared = new Map<string, EstimateSuggestedEvent>();
	return {
		provenanceForTask,
		append: async (event) => {
			events.push(event);
		},
		prepareMutation: async (
			event: EstimateSuggestedEvent,
			_mutations: readonly FeedbackFieldMutation[],
		) => {
			prepared.set(event.id, event);
		},
		commitPrepared: async (id) => {
			const event = prepared.get(id);
			if (event !== undefined) events.push(event);
			prepared.delete(id);
		},
		cancelPrepared: async (id) => {
			prepared.delete(id);
		},
	};
}

function fixture(
	provider: AIProviderPort,
	inboxTasks: Task[] = [task()],
	indexedTasks: Task[] = inboxTasks,
	options: { random?: () => number } = {},
) {
	const writes: unknown[] = [];
	const events: EstimateFeedbackEvent[] = [];
	const persistence = new Persistence();
	let id = 0;
	const processor = new InboxProcessor({
		runtime: new AgentRuntime(provider),
		tasks: {
			listInboxTasks: () => inboxTasks,
			listTasksByKeys: (keys) => {
				const selected = new Set(keys);
				return indexedTasks.filter((item) => selected.has(item.key));
			},
			ensureTaskId: async (key) => ({ ok: true as const, taskId: key.replace(/^id:/u, "") }),
			applyMetadata: async (_key, patch) => {
				writes.push(patch);
				return { ok: true as const };
			},
		},
		scopes: async () =>
			createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]),
		persistence,
		history: historyPort(events),
		now: () => new Date("2026-07-28T00:00:00.000Z"),
		createId: () => `generated-${++id}`,
		random: options.random,
	});
	return { processor, writes, events, persistence };
}

describe("InboxProcessor", () => {
	it("applies provisional values before exposing questions", async () => {
		const f = fixture(new FakeProvider(validResult()));
		const result = await f.processor.process();
		expect(result.state).toBe("awaiting_answers");
		expect(f.writes).toEqual([
			{
				durationMinutes: 90,
				cognitiveIntensity: 4,
				emotionalIntensity: 2,
				physicalIntensity: 0,
				scopeId: "work",
			},
		]);
		expect(f.events.map((event) => event.kind)).toEqual([
			"estimate-suggested",
			"question-asked",
		]);
		expect(f.persistence.transitions).toEqual([
			"processing",
			"values_applied",
			"awaiting_answers",
		]);
		expect(result.actualModel).toBe("free/model");
	});

	it("does not expose a follow-up that failed durable persistence", async () => {
		const f = fixture(new FakeProvider(validResult()));
		const history = historyPort(f.events);
		history.append = async (event) => {
			if (event.kind === "question-asked") throw new Error("private storage detail");
			f.events.push(event);
		};
		(f.processor as unknown as { options: { history: EstimateHistoryPort } }).options.history =
			history;

		const result = await f.processor.process();

		expect(result).toMatchObject({
			state: "completed",
			applied: 1,
			questions: [],
			feedbackWarnings: 1,
		});
		expect(f.events.map((event) => event.kind)).toEqual(["estimate-suggested"]);
	});

	it("prepares prediction feedback before Markdown and finalizes it afterward", async () => {
		const f = fixture(new FakeProvider(validResult()));
		const timeline: string[] = [];
		const prepared = new Map<string, EstimateSuggestedEvent>();
		let mutations: readonly FeedbackFieldMutation[] = [];
		(f.processor as unknown as { options: { history: EstimateHistoryPort } }).options.history =
			{
				provenanceForTask: async (taskId, now) => emptyTaskProvenance(taskId, now),
				append: async (event) => {
					f.events.push(event);
				},
				prepareMutation: async (event, intended) => {
					timeline.push("prepare");
					prepared.set(event.id, event);
					mutations = intended;
				},
				commitPrepared: async (id) => {
					timeline.push("commit");
					f.events.push(prepared.get(id)!);
					prepared.delete(id);
				},
				cancelPrepared: async (id) => {
					timeline.push("cancel");
					prepared.delete(id);
				},
			};
		(
			f.processor as unknown as {
				options: {
					tasks: {
						applyMetadata: (
							key: string,
							patch: unknown,
							taskId?: string,
						) => Promise<{ ok: true }>;
					};
				};
			}
		).options.tasks.applyMetadata = async (_key, patch, taskId) => {
			timeline.push(`write:${taskId}`);
			f.writes.push(patch);
			return { ok: true };
		};

		await f.processor.process();
		expect(timeline).toEqual(["prepare", "write:task-1", "commit"]);
		expect(mutations).toEqual([
			{ field: "duration", previousValue: null, intendedValue: 90 },
			{ field: "cognitive", previousValue: null, intendedValue: 4 },
			{ field: "emotional", previousValue: null, intendedValue: 2 },
			{ field: "physical", previousValue: null, intendedValue: 0 },
			{ field: "scope", previousValue: null, intendedValue: "work" },
		]);
	});

	it("cancels prepared prediction feedback after a known write rejection", async () => {
		const f = fixture(new FakeProvider(validResult()));
		const timeline: string[] = [];
		(f.processor as unknown as { options: { history: EstimateHistoryPort } }).options.history =
			{
				provenanceForTask: async (taskId, now) => emptyTaskProvenance(taskId, now),
				append: async () => undefined,
				prepareMutation: async () => {
					timeline.push("prepare");
				},
				commitPrepared: async () => {
					timeline.push("commit");
				},
				cancelPrepared: async () => {
					timeline.push("cancel");
				},
			};
		(
			f.processor as unknown as {
				options: {
					tasks: {
						applyMetadata: () => Promise<{
							ok: false;
							reason: string;
						}>;
					};
				};
			}
		).options.tasks.applyMetadata = async () => {
			timeline.push("write");
			return { ok: false, reason: "write-failed" };
		};
		const result = await f.processor.process();
		expect(timeline).toEqual(["prepare", "write", "cancel"]);
		expect(result.failed).toContainEqual({
			taskId: "task-1",
			reason: "write-failed",
		});
		expect(f.events).toEqual([]);
	});

	it("continues with later siblings after a provenance read fails", async () => {
		const tasks = [
			task(),
			task({
				key: "id:task-2",
				taskId: "task-2",
				description: "Send invoices",
			}),
		];
		const f = fixture(new FakeProvider(validResult(["task-1", "task-2"])), tasks);
		(f.processor as unknown as { options: { history: unknown } }).options.history = historyPort(
			f.events,
			async (taskId, now) => {
				if (taskId === "task-1") throw new Error("private storage detail");
				return emptyTaskProvenance(taskId, now);
			},
		);

		const result = await f.processor.process();

		expect(result).toMatchObject({
			state: "awaiting_answers",
			applied: 1,
			failed: [{ taskId: "task-1", reason: "feedback-read-failed" }],
		});
		expect(f.writes).toHaveLength(1);
		expect(
			f.events
				.filter((event) => event.kind === "estimate-suggested")
				.map((event) => event.taskId),
		).toEqual(["task-2"]);
		expect(f.persistence.transitions).toEqual([
			"processing",
			"values_applied",
			"awaiting_answers",
		]);
	});

	it("preserves earlier success and continues after an uncertain sibling write", async () => {
		const tasks = [
			task(),
			task({
				key: "id:task-2",
				taskId: "task-2",
				description: "Send invoices",
			}),
			task({
				key: "id:task-3",
				taskId: "task-3",
				description: "Archive receipts",
			}),
		];
		const f = fixture(new FakeProvider(validResult(["task-1", "task-2", "task-3"])), tasks);
		const attemptedTaskIds: string[] = [];
		(
			f.processor as unknown as {
				options: {
					tasks: {
						applyMetadata: (
							key: string,
							patch: unknown,
							taskId?: string,
						) => Promise<{ ok: true }>;
					};
				};
			}
		).options.tasks.applyMetadata = async (_key, patch, taskId) => {
			attemptedTaskIds.push(taskId!);
			if (taskId === "task-2") throw new Error("private vault detail");
			f.writes.push(patch);
			return { ok: true };
		};

		const result = await f.processor.process();

		expect(result).toMatchObject({
			state: "awaiting_answers",
			applied: 2,
			failed: [{ taskId: "task-2", reason: "task-write-uncertain" }],
		});
		expect(attemptedTaskIds).toEqual(["task-1", "task-2", "task-3"]);
		expect(f.writes).toHaveLength(2);
		expect(
			f.events
				.filter((event) => event.kind === "estimate-suggested")
				.map((event) => event.taskId),
		).toEqual(["task-1", "task-3"]);
		expect(f.persistence.transitions).toEqual([
			"processing",
			"values_applied",
			"awaiting_answers",
		]);
	});

	it("records exactly the retrieved example IDs sent in the prompt", async () => {
		const f = fixture(new FakeProvider(validResult()));
		(
			f.processor as unknown as {
				options: {
					examples: {
						examplesFor: (
							task: Task,
							field: string,
						) => Promise<Array<{ id: string; text: string; value: number }>>;
					};
				};
			}
		).options.examples = {
			examplesFor: async (_task, field) =>
				field === "duration"
					? Array.from({ length: 6 }, (_, index) => ({
							id: `example-${index + 1}`,
							text: `Example ${index + 1}`,
							value: 30,
						}))
					: [],
		};
		await f.processor.process();
		const suggestion = f.events.find(
			(event): event is EstimateSuggestedEvent => event.kind === "estimate-suggested",
		);
		expect(suggestion?.retrievedExampleIds).toEqual([
			"example-1",
			"example-2",
			"example-3",
			"example-4",
			"example-5",
		]);
	});

	it("validates the complete batch before the first mutation", async () => {
		const f = fixture(new FakeProvider(validResult(["unexpected"])), [
			task(),
			task({ key: "id:task-2", taskId: "task-2" }),
		]);
		const result = await f.processor.process();
		expect(result.state).toBe("failed");
		expect(f.writes).toEqual([]);
	});

	it("keeps free-capacity failures waiting with Retry-After", async () => {
		const provider = new FakeProvider(
			null,
			new AIError({
				code: "rate-limited",
				retryable: true,
				retryAfterMs: 120_000,
				statusCode: 429,
			}),
		);
		const f = fixture(provider);
		const result = await f.processor.process();
		expect(result.state).toBe("rate_limited");
		expect(result.nextEligibleAt).toBe("2026-07-28T00:02:00.000Z");
		expect(f.writes).toEqual([]);
		expect(f.persistence.transitions).toEqual(["processing", "rate_limited"]);
		expect(provider.completeJsonCalls).toBe(1);
	});

	it("persists every unsent batch after a 429 as independently retriable waiting work", async () => {
		const provider = new BatchProvider({
			call: 2,
			error: new AIError({
				code: "rate-limited",
				retryable: true,
				retryAfterMs: 120_000,
				statusCode: 429,
			}),
		});
		const tasks = Array.from({ length: 76 }, (_, index) =>
			task({
				key: `id:task-${index + 1}`,
				taskId: `task-${index + 1}`,
				description: `Task ${index + 1}`,
			}),
		);
		const f = fixture(provider, tasks);

		const result = await f.processor.process();

		expect(result).toMatchObject({
			state: "rate_limited",
			nextEligibleAt: "2026-07-28T00:02:00.000Z",
		});
		expect(provider.batchSizes).toEqual([25, 25]);
		expect(f.persistence.runTaskIds.map((ids) => ids.length)).toEqual([25, 25, 25, 1]);
		expect(
			f.persistence.runInputs.map((input) => input.initialWaiting?.state ?? "queued"),
		).toEqual(["queued", "queued", "rate_limited", "rate_limited"]);
		expect(
			f.persistence.runInputs.map((input) => input.initialWaiting?.nextEligibleAt ?? null),
		).toEqual([null, null, "2026-07-28T00:02:00.000Z", "2026-07-28T00:02:00.000Z"]);
		expect(f.persistence.runInputs.map((input) => input.attempt ?? 0)).toEqual([0, 0, 0, 0]);
		expect(f.persistence.transitions).toEqual([
			"processing",
			"values_applied",
			"awaiting_answers",
			"processing",
			"rate_limited",
		]);
		expect(f.writes).toHaveLength(25);
		expect(result.applied).toBe(25);
	});

	it("keeps retryable network failures in the durable waiting queue", async () => {
		const f = fixture(
			new FakeProvider(
				null,
				new AIError({
					code: "network",
					retryable: true,
					retryAfterMs: null,
					statusCode: null,
				}),
			),
			[task()],
			undefined,
			{ random: () => 0 },
		);
		const result = await f.processor.process();
		expect(result.state).toBe("retry_waiting");
		expect(result.nextEligibleAt).toBe("2026-07-28T00:00:01.000Z");
		expect(f.writes).toEqual([]);
		expect(f.persistence.transitions).toEqual(["processing", "retry_waiting"]);
	});

	it("persists the unsent tail after a retryable provider failure", async () => {
		const provider = new FakeProvider(
			null,
			new AIError({
				code: "provider-unavailable",
				retryable: true,
				retryAfterMs: null,
				statusCode: 503,
			}),
		);
		const tasks = Array.from({ length: 26 }, (_, index) =>
			task({
				key: `id:task-${index + 1}`,
				taskId: `task-${index + 1}`,
				description: `Task ${index + 1}`,
			}),
		);
		const f = fixture(provider, tasks, undefined, { random: () => 0 });

		const result = await f.processor.process({
			onlyFields: ["duration"],
			questionContext: "Question: include review?\nAnswer: yes",
		});

		expect(result).toMatchObject({
			state: "retry_waiting",
			nextEligibleAt: "2026-07-28T00:00:01.000Z",
		});
		expect(provider.completeJsonCalls).toBe(1);
		expect(f.persistence.runTaskIds.map((ids) => ids.length)).toEqual([25, 1]);
		expect(f.persistence.runInputs[1]).toMatchObject({
			initialWaiting: {
				state: "retry_waiting",
				nextEligibleAt: "2026-07-28T00:00:01.000Z",
			},
			attempt: 0,
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: [],
				questionContext: "Question: include review?\nAnswer: yes",
			},
		});
		expect(f.persistence.transitions).toEqual(["processing", "retry_waiting"]);
		expect(f.writes).toEqual([]);
	});

	it("records a cancelled provider request as cancelled rather than a retryable failure", async () => {
		const f = fixture(
			new FakeProvider(
				null,
				new AIError({
					code: "cancelled",
					retryable: false,
					retryAfterMs: null,
					statusCode: null,
				}),
			),
		);
		const result = await f.processor.process();
		expect(result).toMatchObject({
			state: "cancelled",
			applied: 0,
			failed: [],
			nextEligibleAt: null,
		});
		expect(f.writes).toEqual([]);
		expect(f.persistence.transitions).toEqual(["processing", "cancelled"]);
		expect(f.persistence.providerErrorCode).toBe("cancelled");
	});

	it("propagates command cancellation to the active provider request", async () => {
		const provider = new AbortableProvider();
		const f = fixture(provider);
		const controller = new AbortController();
		const pending = f.processor.process({ signal: controller.signal });
		await provider.started;
		controller.abort();

		await expect(pending).resolves.toMatchObject({
			state: "cancelled",
			applied: 0,
			nextEligibleAt: null,
		});
		expect(f.persistence.transitions).toEqual(["processing", "cancelled"]);
		expect(f.persistence.providerErrorCode).toBe("cancelled");
		expect(f.writes).toEqual([]);
	});

	it("uses jittered exponential fallback and preserves durable retry lineage", async () => {
		const f = fixture(
			new FakeProvider(
				null,
				new AIError({
					code: "provider-unavailable",
					retryable: true,
					retryAfterMs: null,
					statusCode: 503,
				}),
			),
			[task()],
			undefined,
			{ random: () => 0 },
		);
		const result = await f.processor.process({
			taskKeys: ["id:task-1"],
			retryOfRunId: "previous-run",
			priorAttempt: 2,
		});
		expect(result.state).toBe("retry_waiting");
		// attempt 3 → 2^3 seconds, lower jitter bound 0.5 ⇒ 4 seconds
		expect(result.nextEligibleAt).toBe("2026-07-28T00:00:04.000Z");
		expect(f.persistence.runInputs).toEqual([
			expect.objectContaining({
				taskIds: ["task-1"],
				attempt: 2,
				retryOfRunId: "previous-run",
			}),
		]);
	});

	it("skips user-locked fields on explicit reprocessing", async () => {
		const f = fixture(new FakeProvider(validResult()));
		(f.processor as unknown as { options: { history: unknown } }).options.history = historyPort(
			f.events,
			async (taskId: string, now: string) => {
				const provenance = emptyTaskProvenance(taskId, now);
				provenance.fields.duration = {
					owner: "user",
					locked: true,
					lastPredictionEventId: null,
					updatedAt: now,
				};
				return provenance;
			},
		);
		const result = await f.processor.process();
		expect(result.skippedLocked).toBe(1);
		expect(result.questions).toEqual([]);
		expect(f.writes[0]).not.toHaveProperty("durationMinutes");
		expect(f.events.map((event) => event.kind)).toEqual(["estimate-suggested"]);
	});

	it("narrows a follow-up to the provisional fields that were actually applied", async () => {
		const response = validResult();
		response.tasks[0]!.questions = [
			{
				id: "q-mixed",
				text: "Which part needs more effort?",
				affectedFields: ["duration", "cognitive"],
			},
		];
		const f = fixture(new FakeProvider(response));
		(f.processor as unknown as { options: { history: unknown } }).options.history = historyPort(
			f.events,
			async (taskId: string, now: string) => {
				const provenance = emptyTaskProvenance(taskId, now);
				provenance.fields.duration = {
					owner: "user",
					locked: true,
					lastPredictionEventId: null,
					updatedAt: now,
				};
				return provenance;
			},
		);

		const result = await f.processor.process({
			onlyFields: ["duration", "cognitive"],
		});

		expect(result.questions).toEqual([
			{
				taskId: "task-1",
				question: expect.objectContaining({ affectedFields: ["cognitive"] }),
			},
		]);
		expect(f.events.at(-1)).toEqual(
			expect.objectContaining({ kind: "question-asked", affectedFields: ["cognitive"] }),
		);
	});

	it("commits an explicit field unlock only after a valid response exists", async () => {
		const f = fixture(new FakeProvider(validResult()));
		(f.processor as unknown as { options: { history: unknown } }).options.history = historyPort(
			f.events,
			async (taskId: string, now: string) => {
				const provenance = emptyTaskProvenance(taskId, now);
				if (!f.events.some((event) => event.kind === "field-unlocked")) {
					provenance.fields.duration = {
						owner: "user",
						locked: true,
						lastPredictionEventId: null,
						updatedAt: now,
					};
				}
				return provenance;
			},
		);
		const result = await f.processor.process({
			taskKeys: ["id:task-1"],
			onlyFields: ["duration"],
			unlockFields: ["duration"],
		});
		expect(result.applied).toBe(1);
		expect(f.writes).toEqual([{ durationMinutes: 90 }]);
		expect(f.persistence.runInputs[0]).toMatchObject({
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: ["duration"],
				questionContext: null,
			},
		});
		expect(f.events.map((event) => event.kind)).toEqual([
			"field-unlocked",
			"estimate-suggested",
			"question-asked",
		]);
	});

	it("does not unlock a field when response validation fails", async () => {
		const f = fixture(new FakeProvider(validResult(["unexpected"])));
		const result = await f.processor.process({
			taskKeys: ["id:task-1"],
			onlyFields: ["duration"],
			unlockFields: ["duration"],
		});
		expect(result.state).toBe("failed");
		expect(f.events).toEqual([]);
	});

	it("blocks before creating a run when no active scope exists", async () => {
		const f = fixture(new FakeProvider(validResult()));
		(f.processor as unknown as { options: { scopes: unknown } }).options.scopes = async () =>
			createScopeCatalog();
		const result = await f.processor.process();
		expect(result.state).toBe("blocked-no-scopes");
		expect(f.persistence.transitions).toEqual([]);
	});

	it("resolves explicit targets outside the configured inbox", async () => {
		const outsideInbox = task({
			key: "id:project-task",
			taskId: "project-task",
			filePath: "Projects/Launch.md",
		});
		const f = fixture(new FakeProvider(validResult(["project-task"])), [], [outsideInbox]);
		const result = await f.processor.process({ taskKeys: [outsideInbox.key] });
		expect(result.applied).toBe(1);
		expect(f.writes).toHaveLength(1);
		expect(f.persistence.runTaskIds).toEqual([["project-task"]]);
	});

	it("drains an inbox snapshot through bounded sequential batches", async () => {
		const provider = new BatchProvider();
		const tasks = Array.from({ length: 26 }, (_, index) =>
			task({
				key: `id:task-${index + 1}`,
				taskId: `task-${index + 1}`,
				description: `Task ${index + 1}`,
			}),
		);
		const f = fixture(provider, tasks);
		const result = await f.processor.process();
		expect(provider.batchSizes).toEqual([25, 1]);
		expect(f.persistence.runTaskIds.map((ids) => ids.length)).toEqual([25, 1]);
		expect(result.applied).toBe(26);
		expect(result.questions).toHaveLength(26);
		expect(f.writes).toHaveLength(26);
	});
});
