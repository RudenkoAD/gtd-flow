import { describe, expect, it, vi } from "vitest";
import { ESTIMATE_FIELDS, type TaskEstimateProvenance } from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import { MetadataServices } from "../../services/MetadataServices";
import { AiPluginServices } from "./AiPluginServices";

describe("AiPluginServices feedback health", () => {
	it("reports queued, processing, rate-limited, and retry-waiting runs without contacting the provider", async () => {
		const list = vi.fn().mockResolvedValue([
			{
				id: "queued-run",
				state: "queued",
				updatedAt: "2026-07-28T12:04:00.000Z",
				nextEligibleAt: null,
				error: null,
			},
			{
				id: "processing-run",
				state: "processing",
				updatedAt: "2026-07-28T12:03:00.000Z",
				nextEligibleAt: null,
				error: null,
			},
			{
				id: "network-run",
				state: "retry_waiting",
				updatedAt: "2026-07-28T12:00:00.000Z",
				nextEligibleAt: "2026-07-28T12:01:00.000Z",
				error: { code: "network" },
			},
			{
				id: "quota-run",
				state: "rate_limited",
				updatedAt: "2026-07-28T12:00:00.000Z",
				nextEligibleAt: "2026-07-28T12:02:00.000Z",
				error: { code: "rate-limited" },
			},
		]);
		const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
		Object.defineProperty(services, "runs", { value: { list } });
		Object.defineProperty(services, "now", {
			value: () => new Date("2026-07-28T12:05:00.000Z"),
		});

		await expect(services.queueStatus()).resolves.toEqual({
			waitingCount: 3,
			processingCount: 1,
			state: "retry-waiting",
			nextEligibleAt: "2026-07-28T12:01:00.000Z",
			errorCode: "network",
		});
		expect(list).toHaveBeenCalledOnce();
	});

	it("separates active processing from stale processing that is ready for recovery", async () => {
		const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
		Object.defineProperty(services, "now", {
			value: () => new Date("2026-07-28T12:15:00.000Z"),
		});
		Object.defineProperty(services, "runs", {
			value: {
				list: vi
					.fn()
					.mockResolvedValueOnce([
						{
							id: "active",
							state: "processing",
							updatedAt: "2026-07-28T12:14:00.000Z",
							nextEligibleAt: null,
							error: null,
						},
					])
					.mockResolvedValueOnce([
						{
							id: "stale",
							state: "processing",
							updatedAt: "2026-07-28T11:00:00.000Z",
							nextEligibleAt: null,
							error: null,
						},
					]),
			},
		});

		await expect(services.queueStatus()).resolves.toEqual({
			waitingCount: 0,
			processingCount: 1,
			state: "processing",
			nextEligibleAt: null,
			errorCode: null,
		});
		await expect(services.queueStatus()).resolves.toEqual({
			waitingCount: 1,
			processingCount: 0,
			state: "queued",
			nextEligibleAt: null,
			errorCode: null,
		});
	});

	it("includes durable outbox state in the feedback summary", async () => {
		const readAll = vi
			.fn()
			.mockResolvedValue({ events: [{ id: "event" }], invalidPaths: ["bad"] });
		const outboxHealth = vi.fn().mockResolvedValue({
			pending: 2,
			conflicts: 3,
			invalidRecords: 4,
		});
		const services = Object.create(MetadataServices.prototype) as MetadataServices;
		Object.defineProperty(services, "history", { value: { readAll, outboxHealth } });

		await expect(services.feedbackSummary()).resolves.toEqual({
			events: 1,
			invalidRecords: 1,
			pendingOutbox: 2,
			conflictedOutbox: 3,
			invalidOutboxRecords: 4,
		});
	});

	it("returns only the newest bounded events with current field provenance", async () => {
		const events = Array.from({ length: 55 }, (_, index) => ({
			schemaVersion: 1,
			id: `event-${index}`,
			kind: "question-asked",
			taskId: "task-1",
			createdAt: `2026-07-28T00:${String(index).padStart(2, "0")}:00.000Z`,
			runId: null,
			sessionId: null,
			questionId: `question-${index}`,
			affectedFields: ["duration"],
			text: `private question ${index}`,
		}));
		const readAll = vi.fn().mockResolvedValue({ events, invalidPaths: ["bad"] });
		const provenanceForTasks = vi
			.fn()
			.mockResolvedValue(new Map([["task-1", provenance("task-1")]]));
		const services = inspectionServices({ readAll, provenanceForTasks });

		const result = await services.feedbackInspection(999);

		expect(result).toMatchObject({
			totalEvents: 55,
			invalidRecords: 1,
			omittedEvents: 5,
		});
		expect(result.events).toHaveLength(50);
		expect(result.events[0]).toMatchObject({
			id: "event-54",
			taskId: "task-1",
			kind: "question-asked",
			detail: "question asked for duration (content hidden)",
		});
		expect(result.events[0]?.provenance).toHaveLength(5);
		expect(result.events[0]?.provenance[0]).toEqual({
			field: "duration",
			owner: "user",
			locked: true,
			lastPredictionEventId: "event-prediction",
			updatedAt: "2026-07-28T01:00:00.000Z",
		});
		expect(provenanceForTasks).toHaveBeenCalledTimes(1);
		expect(provenanceForTasks).toHaveBeenCalledWith(["task-1"], "2026-07-28T02:00:00.000Z", {
			events,
			invalidPaths: ["bad"],
		});
		expect(JSON.stringify(result)).not.toContain("private question");
	});

	it("redacts arbitrary credential-shaped identifiers and string values", async () => {
		const readAll = vi.fn().mockResolvedValue({
			events: [
				{
					schemaVersion: 1,
					id: "api_key_LEAK",
					kind: "estimate-corrected",
					taskId: "access_token_LEAK",
					createdAt: "credential-value",
					runId: "oauth-run-LEAK",
					sessionId: "secret-session-LEAK",
					field: "scope",
					previousValue: "client-secret-LEAK",
					value: "sk-LEAKVALUE",
					taskSnapshot: {
						text: "bearer LEAK",
						tags: [],
						container: "",
						heading: null,
						recurrence: null,
					},
				},
			],
			invalidPaths: [".gtd-flow/api-key-LEAK.json"],
		});
		const unsafe = provenance("access_token_LEAK");
		for (const state of Object.values(unsafe.fields)) {
			state.lastPredictionEventId = "oauth-secret-LEAK";
			state.updatedAt = "access-token-LEAK";
		}
		const services = inspectionServices({
			readAll,
			provenanceForTasks: vi.fn().mockResolvedValue(new Map([["access_token_LEAK", unsafe]])),
		});

		const result = await services.feedbackInspection();
		const serialized = JSON.stringify(result);

		expect(result.events[0]).toMatchObject({
			id: "[redacted]",
			taskId: "[redacted]",
			createdAt: "[invalid timestamp]",
			detail: "scope: [redacted] → [redacted]",
		});
		expect(result.events[0]?.provenance[0]?.lastPredictionEventId).toBe("[redacted]");
		for (const secret of ["LEAK", "bearer", "oauth-run", "secret-session", ".gtd-flow"]) {
			expect(serialized).not.toContain(secret);
		}
	});
});

describe("AiPluginServices explicit task reprocessing", () => {
	it("adds persisted question context only when the cursor command reprocesses its task", async () => {
		const reprocessContext = vi.fn().mockResolvedValue({
			onlyFields: ["duration", "emotional"],
			questionContext: "Question: Include review?\nAnswer: Yes.",
		});
		const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
		Object.defineProperty(services, "questions", { value: { reprocessContext } });
		const process = vi.spyOn(services, "process").mockResolvedValue(cancelledSummary());
		const task = {
			key: "id:task-1",
			taskId: "task-1",
		} as Task;

		await services.reprocessTask(task);

		expect(reprocessContext).toHaveBeenCalledWith("task-1");
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			onlyFields: ["duration", "emotional"],
			questionContext: "Question: Include review?\nAnswer: Yes.",
		});
	});

	it("falls back to a full task reprocess when no answered context applies", async () => {
		const reprocessContext = vi.fn().mockResolvedValue(null);
		const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
		Object.defineProperty(services, "questions", { value: { reprocessContext } });
		const process = vi.spyOn(services, "process").mockResolvedValue(cancelledSummary());
		const task = {
			key: "path:inbox#task",
			taskId: null,
		} as Task;

		await services.reprocessTask(task);

		expect(reprocessContext).not.toHaveBeenCalled();
		expect(process).toHaveBeenCalledWith({ taskKeys: ["path:inbox#task"] });
	});
});

describe("AiPluginServices processing cancellation", () => {
	it("uses an invocation-owned signal and safely forwards an external abort", async () => {
		let receivedSignal: AbortSignal | undefined;
		const processor = vi.fn(
			(request: { signal?: AbortSignal }) =>
				new Promise<ReturnType<typeof cancelledSummary>>((resolve) => {
					receivedSignal = request.signal;
					request.signal?.addEventListener("abort", () => resolve(cancelledSummary()), {
						once: true,
					});
				}),
		);
		const services = processingServices(processor);
		const external = new AbortController();

		const pending = services.process({ signal: external.signal });
		await vi.waitFor(() => expect(receivedSignal).toBeDefined());
		expect(receivedSignal).not.toBe(external.signal);

		external.abort();

		await expect(pending).resolves.toMatchObject({ state: "cancelled" });
		expect(receivedSignal?.aborted).toBe(true);
		expect(services.cancelProcessing()).toBe(0);
	});

	it("cancels all active invocations once", async () => {
		const signals: AbortSignal[] = [];
		const processor = vi.fn(
			(request: { signal?: AbortSignal }) =>
				new Promise<ReturnType<typeof cancelledSummary>>((resolve) => {
					const signal = request.signal!;
					signals.push(signal);
					signal.addEventListener("abort", () => resolve(cancelledSummary()), {
						once: true,
					});
				}),
		);
		const services = processingServices(processor);

		const first = services.process();
		const second = services.process();
		await vi.waitFor(() => expect(signals).toHaveLength(2));

		expect(services.cancelProcessing()).toBe(2);
		expect(services.cancelProcessing()).toBe(0);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});

	it("refreshes an already-open AI view after command-driven processing completes", async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		const services = processingServices(vi.fn().mockResolvedValue(cancelledSummary()));
		Object.defineProperty(services, "view", { value: { refresh } });

		await services.process();

		expect(refresh).toHaveBeenCalledOnce();
	});

	it("aborts active processing before clearing credentials on dispose", async () => {
		let receivedSignal: AbortSignal | undefined;
		const processor = vi.fn(
			(request: { signal?: AbortSignal }) =>
				new Promise<ReturnType<typeof cancelledSummary>>((resolve) => {
					receivedSignal = request.signal;
					request.signal?.addEventListener("abort", () => resolve(cancelledSummary()), {
						once: true,
					});
				}),
		);
		const clear = vi.fn().mockResolvedValue(undefined);
		const services = processingServices(processor, clear);
		const pending = services.process();
		await vi.waitFor(() => expect(receivedSignal).toBeDefined());

		await services.dispose();

		expect(receivedSignal?.aborted).toBe(true);
		expect(clear).toHaveBeenCalledOnce();
		await expect(pending).resolves.toMatchObject({ state: "cancelled" });
	});

	it("does not mutate the durable retry queue while the memory credential is absent", async () => {
		const retryEligible = vi.fn();
		const services = processingServices(vi.fn(), vi.fn().mockResolvedValue(undefined), null);
		Object.defineProperty(services, "queue", { value: { retryEligible } });

		await expect(services.retryWaiting()).rejects.toMatchObject({
			code: "authentication",
			retryable: false,
		});
		expect(retryEligible).not.toHaveBeenCalled();
	});
});

describe("AiPluginServices chat metadata provenance", () => {
	it("prepares one field-local event for a partial chat estimate", async () => {
		const prepareMutation = vi.fn().mockResolvedValue("outbox");
		const commitPrepared = vi.fn().mockResolvedValue("feedback");
		const cancelPrepared = vi.fn().mockResolvedValue(undefined);
		const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
		Object.defineProperties(services, {
			history: {
				value: { prepareMutation, commitPrepared, cancelPrepared },
			},
			now: { value: () => new Date("2026-07-28T02:00:00.000Z") },
			createId: { value: () => "chat-event" },
		});
		const prepare = (
			services as unknown as {
				prepareChatMetadataMutation(
					task: {
						taskId: string;
						description: string;
						tags: string[];
						container: "inbox";
						heading: null;
						recurrence: null;
						durationMinutes: null;
					},
					patch: { duration: number },
					context: { sessionId: string; actualModel: string },
				): Promise<{ commit(): Promise<void>; cancel(): Promise<void> }>;
			}
		).prepareChatMetadataMutation.bind(services);

		const prepared = await prepare(
			{
				taskId: "task-1",
				description: "Prepare review",
				tags: [],
				container: "inbox",
				heading: null,
				recurrence: null,
				durationMinutes: null,
			},
			{ duration: 45 },
			{ sessionId: "chat-1", actualModel: "free/model" },
		);

		expect(prepareMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "chat-event_duration",
				kind: "estimate-field-suggested",
				taskId: "task-1",
				sessionId: "chat-1",
				field: "duration",
				value: 45,
				actualModel: "free/model",
			}),
			[{ field: "duration", previousValue: null, intendedValue: 45 }],
		);
		expect(prepareMutation.mock.calls[0]?.[0]).not.toHaveProperty("values");
		await prepared.commit();
		expect(commitPrepared).toHaveBeenCalledWith("chat-event_duration");
		expect(cancelPrepared).not.toHaveBeenCalled();
	});
});

describe("AiPluginServices ownership reconcile gating", () => {
	function reconcileServices(enabled: boolean) {
		const reconcileOwnership = vi.fn().mockResolvedValue(undefined);
		const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
		Object.defineProperties(services, {
			options: { value: { enabled: () => enabled } },
			metadataServices: { value: { reconcileOwnership } },
		});
		return { services, reconcileOwnership };
	}

	// §сверка-по-требованию: при выключенном AI проход по всем задачам создавал
	// по файлу на каждое непустое поле в `.gtd-flow/ai/feedback` при КАЖДОМ старте.
	it("does not touch feedback history while AI is disabled", async () => {
		const { services, reconcileOwnership } = reconcileServices(false);

		await expect(services.reconcileOwnership()).resolves.toBeUndefined();

		expect(reconcileOwnership).not.toHaveBeenCalled();
	});

	it("still reconciles once AI is enabled", async () => {
		const { services, reconcileOwnership } = reconcileServices(true);

		await services.reconcileOwnership();

		expect(reconcileOwnership).toHaveBeenCalledOnce();
	});
});

function inspectionServices(history: {
	readAll: ReturnType<typeof vi.fn>;
	provenanceForTasks: ReturnType<typeof vi.fn>;
}): MetadataServices {
	const services = Object.create(MetadataServices.prototype) as MetadataServices;
	Object.defineProperty(services, "history", { value: history });
	Object.defineProperty(services, "now", {
		value: () => new Date("2026-07-28T02:00:00.000Z"),
	});
	return services;
}

function processingServices(
	process: ReturnType<typeof vi.fn>,
	clear: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
	credential: string | null = "test-credential",
): AiPluginServices {
	const services = Object.create(AiPluginServices.prototype) as AiPluginServices;
	Object.defineProperties(services, {
		options: {
			value: {
				enabled: () => true,
				credentialStorage: () => "memory-only",
				privacyPolicy: () => "account-policy",
			},
		},
		processor: { value: { process } },
		processingControllers: { value: new Set<AbortController>() },
		credentials: { value: { clear, get: vi.fn().mockResolvedValue(credential) } },
		metadataServices: { value: { attachAiActions: vi.fn() } },
	});
	vi.spyOn(services, "reconcileOwnership").mockResolvedValue(undefined);
	return services;
}

function cancelledSummary() {
	return {
		runId: "run-cancelled",
		sessionId: "session-cancelled",
		state: "cancelled" as const,
		applied: 0,
		skippedLocked: 0,
		failed: [],
		questions: [],
		actualModel: null,
		nextEligibleAt: null,
		feedbackWarnings: 0,
	};
}

function provenance(taskId: string): TaskEstimateProvenance {
	return {
		schemaVersion: 1,
		taskId,
		fields: Object.fromEntries(
			ESTIMATE_FIELDS.map((field) => [
				field,
				{
					owner: field === "duration" ? "user" : "ai",
					locked: field === "duration",
					lastPredictionEventId: "event-prediction",
					updatedAt: "2026-07-28T01:00:00.000Z",
				},
			]),
		) as TaskEstimateProvenance["fields"],
	};
}
