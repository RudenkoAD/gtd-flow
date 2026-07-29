import { describe, expect, it, vi } from "vitest";
import { emptyTaskProvenance } from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import type {
	EstimateFeedbackEvent,
	FeedbackReadResult,
} from "../../services/EstimateFeedbackService";
import { QuestionService, type QuestionHistoryPort } from "./QuestionService";

const asked: EstimateFeedbackEvent = {
	schemaVersion: 1,
	id: "asked-event",
	kind: "question-asked",
	taskId: "task-1",
	createdAt: "2026-07-28T00:00:00.000Z",
	runId: "run-1",
	sessionId: "session-1",
	questionId: "q-1",
	affectedFields: ["duration"],
	text: "Does this include review time?",
};

const task = {
	key: "id:task-1",
	taskId: "task-1",
	description: "Reconcile invoices",
} as Task;

function history(
	events: EstimateFeedbackEvent[],
	overrides: Partial<QuestionHistoryPort> = {},
): QuestionHistoryPort {
	return {
		readAll: async (): Promise<FeedbackReadResult> => ({ events, invalidPaths: [] }),
		append: async (event) => {
			events.push(event);
		},
		...overrides,
	};
}

describe("QuestionService", () => {
	it("lists unanswered questions and labels their tasks", async () => {
		const service = new QuestionService({
			history: history([asked]),
			findTask: () => task,
		});

		await expect(service.listPending()).resolves.toEqual([
			{
				id: "asked-event",
				text: "Does this include review time?",
				affectedFields: ["duration"],
				task: { id: "task-1", label: "Reconcile invoices" },
			},
		]);
	});

	it("persists an answer without starting processing", async () => {
		const events: EstimateFeedbackEvent[] = [asked];
		const append = vi.fn(async (event: EstimateFeedbackEvent) => {
			events.push(event);
		});
		const service = new QuestionService({
			history: history(events, { append }),
			findTask: () => task,
			now: () => new Date("2026-07-28T00:01:00.000Z"),
			createId: () => "answer-event",
		});

		await service.answer("asked-event", "Yes, include it.");

		expect(append).toHaveBeenCalledOnce();
		expect(events.at(-1)).toEqual({
			schemaVersion: 1,
			id: "answer-event",
			kind: "question-answered",
			taskId: "task-1",
			createdAt: "2026-07-28T00:01:00.000Z",
			runId: "run-1",
			sessionId: "session-1",
			questionId: "asked-event",
			affectedFields: ["duration"],
			text: "Yes, include it.",
		});
		await expect(service.listPending()).resolves.toEqual([]);
	});

	it("keeps a reused model question ID pending in a later run", async () => {
		const laterAsked: EstimateFeedbackEvent = {
			...asked,
			id: "asked-event-2",
			runId: "run-2",
			sessionId: "session-2",
		};
		const answeredFirst: EstimateFeedbackEvent = {
			...asked,
			id: "answer-event-1",
			kind: "question-answered",
			questionId: "asked-event",
			text: "Yes.",
		};
		const service = new QuestionService({
			history: history([asked, answeredFirst, laterAsked]),
			findTask: () => task,
		});

		await expect(service.listPending()).resolves.toEqual([
			expect.objectContaining({ id: "asked-event-2" }),
		]);
	});

	it("hides a user-locked follow-up and refuses to persist a stale answer", async () => {
		const append = vi.fn();
		const service = new QuestionService({
			history: history([asked], {
				provenanceForTask: async (taskId, now) => {
					const provenance = emptyTaskProvenance(taskId, now);
					provenance.fields.duration = {
						owner: "user",
						locked: true,
						lastPredictionEventId: null,
						updatedAt: now,
					};
					return provenance;
				},
				append,
			}),
			findTask: () => task,
		});

		await expect(service.listPending()).resolves.toEqual([]);
		await expect(service.answer("asked-event", "Yes.")).rejects.toThrow("question-not-pending");
		expect(append).not.toHaveBeenCalled();
	});

	it("does not resurrect a manually locked question after an explicit unlock", async () => {
		const locked: EstimateFeedbackEvent = {
			...asked,
			id: "manual-lock",
			kind: "estimate-manual",
			createdAt: "2026-07-28T00:01:00.000Z",
			field: "duration",
			previousValue: 90,
			value: 120,
		};
		const unlocked: EstimateFeedbackEvent = {
			...asked,
			id: "explicit-unlock",
			kind: "field-unlocked",
			createdAt: "2026-07-28T00:02:00.000Z",
			fields: ["duration"],
		};
		const append = vi.fn();
		const service = new QuestionService({
			history: history([asked, locked, unlocked], {
				provenanceForTask: async (taskId, now) => emptyTaskProvenance(taskId, now),
				append,
			}),
			findTask: () => task,
		});

		await expect(service.listPending()).resolves.toEqual([]);
		await expect(service.answer("asked-event", "Yes.")).rejects.toThrow("question-not-pending");
		expect(append).not.toHaveBeenCalled();
	});

	it("persists and reprocesses only the still-unlocked fields of a mixed follow-up", async () => {
		const events: EstimateFeedbackEvent[] = [
			{ ...asked, affectedFields: ["duration", "cognitive"] },
		];
		const service = new QuestionService({
			history: history(events, {
				provenanceForTask: async (taskId, now) => {
					const provenance = emptyTaskProvenance(taskId, now);
					provenance.fields.duration = {
						owner: "user",
						locked: true,
						lastPredictionEventId: null,
						updatedAt: now,
					};
					return provenance;
				},
			}),
			findTask: () => task,
			createId: () => "mixed-answer",
		});

		await service.answer("asked-event", "Make it detailed.");

		expect(events.at(-1)).toMatchObject({
			kind: "question-answered",
			affectedFields: ["cognitive"],
		});
		await expect(service.reprocessContext("task-1")).resolves.toEqual({
			onlyFields: ["cognitive"],
			questionContext: "Question: Does this include review time?\nAnswer: Make it detailed.",
		});
	});

	it("does not record an answer when its task no longer exists", async () => {
		const append = vi.fn();
		const service = new QuestionService({
			history: history([asked], { append }),
			findTask: () => null,
		});

		await expect(service.answer("asked-event", "Yes.")).rejects.toThrow(
			"question-task-not-found",
		);
		expect(append).not.toHaveBeenCalled();
	});

	it("collects recent answered questions in canonical field order", async () => {
		const emotionalAsked: EstimateFeedbackEvent = {
			...asked,
			id: "asked-emotional",
			questionId: "q-2",
			createdAt: "2026-07-28T00:02:00.000Z",
			affectedFields: ["emotional", "duration"],
			text: "Will this be emotionally difficult?",
		};
		const durationAnswer: EstimateFeedbackEvent = {
			...asked,
			id: "answer-duration",
			kind: "question-answered",
			questionId: "asked-event",
			createdAt: "2026-07-28T00:01:00.000Z",
			text: "Yes, include review.",
		};
		const emotionalAnswer: EstimateFeedbackEvent = {
			...emotionalAsked,
			id: "answer-emotional",
			kind: "question-answered",
			questionId: "asked-emotional",
			createdAt: "2026-07-28T00:03:00.000Z",
			text: "A little.",
		};
		const service = new QuestionService({
			history: history([asked, durationAnswer, emotionalAsked, emotionalAnswer]),
			findTask: () => task,
		});

		await expect(service.reprocessContext("task-1")).resolves.toEqual({
			onlyFields: ["duration", "emotional"],
			questionContext: [
				"Question: Does this include review time?\nAnswer: Yes, include review.",
				"Question: Will this be emotionally difficult?\nAnswer: A little.",
			].join("\n\n"),
		});
	});

	it("consumes only fields applied by a later explicit reprocess", async () => {
		const mixedAsked: EstimateFeedbackEvent = {
			...asked,
			affectedFields: ["duration", "cognitive"],
		};
		const answer: EstimateFeedbackEvent = {
			...mixedAsked,
			id: "answer-event",
			kind: "question-answered",
			questionId: "asked-event",
			createdAt: "2026-07-28T00:01:00.000Z",
			text: "Include detailed review.",
		};
		const applied: EstimateFeedbackEvent = {
			schemaVersion: 1,
			id: "suggestion-event",
			kind: "estimate-suggested",
			taskId: "task-1",
			createdAt: "2026-07-28T00:02:00.000Z",
			runId: "run-2",
			sessionId: "session-2",
			taskSnapshot: {
				text: "Reconcile invoices",
				tags: [],
				container: "inbox",
				heading: null,
				recurrence: null,
			},
			values: {
				durationMinutes: 120,
				cognitiveIntensity: 4,
				emotionalIntensity: 2,
				physicalIntensity: 0,
				scopeId: "work",
			},
			confidence: {
				duration: 0.9,
				cognitive: 0.9,
				emotional: 0.9,
				physical: 0.9,
				scope: 0.9,
			},
			appliedFields: ["duration"],
			actualModel: "free/model",
			provider: "openrouter",
			promptVersion: "inbox-estimator-v1",
			schemaVersionId: "inbox-processing-v1",
			retrievedExampleIds: [],
		};
		const service = new QuestionService({
			history: history([mixedAsked, answer, applied]),
			findTask: () => task,
		});

		await expect(service.reprocessContext("task-1")).resolves.toEqual({
			onlyFields: ["cognitive"],
			questionContext:
				"Question: Does this include review time?\nAnswer: Include detailed review.",
		});
	});

	it("consumes an answered field after a chat-originated field suggestion", async () => {
		const answer: EstimateFeedbackEvent = {
			...asked,
			id: "answer-event",
			kind: "question-answered",
			questionId: "asked-event",
			createdAt: "2026-07-28T00:01:00.000Z",
			text: "Yes, include review.",
		};
		const chatSuggestion: EstimateFeedbackEvent = {
			schemaVersion: 1,
			id: "chat-suggestion",
			kind: "estimate-field-suggested",
			taskId: "task-1",
			createdAt: "2026-07-28T00:02:00.000Z",
			runId: null,
			sessionId: "chat-session",
			field: "duration",
			value: 120,
			taskSnapshot: {
				text: "Reconcile invoices",
				tags: [],
				container: "inbox",
				heading: null,
				recurrence: null,
			},
			confidence: 0,
			actualModel: "free/model",
			provider: "openrouter",
			promptVersion: "chat-tools-v1",
			schemaVersionId: "chat-tool-metadata-v1",
			retrievedExampleIds: [],
		};
		const service = new QuestionService({
			history: history([asked, answer, chatSuggestion]),
			findTask: () => task,
		});

		await expect(service.reprocessContext("task-1")).resolves.toBeNull();
	});

	it("reads legacy answers linked by model question ID within their run", async () => {
		const legacyAnswer: EstimateFeedbackEvent = {
			...asked,
			id: "legacy-answer",
			kind: "question-answered",
			createdAt: "2026-07-28T00:01:00.000Z",
			questionId: "q-1",
			text: "Yes.",
		};
		const service = new QuestionService({
			history: history([asked, legacyAnswer]),
			findTask: () => task,
		});

		await expect(service.reprocessContext("task-1")).resolves.toEqual({
			onlyFields: ["duration"],
			questionContext: "Question: Does this include review time?\nAnswer: Yes.",
		});
	});
});
