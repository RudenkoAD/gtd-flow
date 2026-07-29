import {
	ESTIMATE_FIELDS,
	type EstimateField,
	type TaskEstimateProvenance,
} from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import type {
	EstimateFeedbackEvent,
	FeedbackReadResult,
	QuestionEvent,
} from "../../services/EstimateFeedbackService";
import type { AIQuestionPort } from "../integration/AIViewController";
import type { AIViewQuestion } from "../../views/ai/aiViewModel";

const MAX_QUESTION_CONTEXT_LENGTH = 2_000;
const MAX_ANSWER_LENGTH = 2_000;

export interface QuestionHistoryPort {
	readAll(): Promise<FeedbackReadResult>;
	/**
	 * Current ownership is needed to suppress stale follow-ups after a user
	 * edit. Optional for legacy test/host adapters; production history provides
	 * it and therefore never sends an answer for a locked field.
	 */
	provenanceForTask?(taskId: string, now: string): Promise<TaskEstimateProvenance>;
	append(event: EstimateFeedbackEvent): Promise<unknown>;
}

export interface QuestionServiceOptions {
	history: QuestionHistoryPort;
	findTask(taskId: string): Task | null;
	now?: () => Date;
	createId?: () => string;
}

export interface QuestionReprocessContext {
	onlyFields: EstimateField[];
	questionContext: string;
}

interface PendingQuestion {
	asked: QuestionEvent;
	task: Task | null;
	affectedFields: EstimateField[];
}

/**
 * Questions are provisional follow-ups, not processing triggers. Answering one
 * persists context locally; a later explicit reprocess command consumes it.
 */
export class QuestionService implements AIQuestionPort {
	private readonly now: () => Date;
	private readonly createId: () => string;

	constructor(private readonly options: QuestionServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? (() => crypto.randomUUID());
	}

	async listPending(): Promise<readonly AIViewQuestion[]> {
		const pending = await this.pending();
		return pending.map(({ asked, task, affectedFields }) => ({
			id: asked.id,
			text: asked.text,
			affectedFields: [...affectedFields],
			task: {
				id: asked.taskId,
				label: task?.description.slice(0, 80) || asked.taskId,
			},
		}));
	}

	async answer(questionEventId: string, answer: string): Promise<void> {
		const clean = answer.trim();
		if (clean === "") throw new Error("question-answer-required");
		const pending = (await this.pending()).find((item) => item.asked.id === questionEventId);
		if (!pending) throw new Error("question-not-pending");
		const asked = pending.asked;
		if (pending.task === null) throw new Error("question-task-not-found");
		const answered: QuestionEvent = {
			schemaVersion: 1,
			id: safeId(this.createId()),
			kind: "question-answered",
			taskId: asked.taskId,
			createdAt: this.now().toISOString(),
			runId: asked.runId,
			sessionId: asked.sessionId,
			// Link to this exact asked event. Model question IDs are only unique
			// inside their response and may be reused in later runs.
			questionId: asked.id,
			affectedFields: [...pending.affectedFields],
			text: clean.slice(0, MAX_ANSWER_LENGTH),
		};
		await this.options.history.append(answered);
	}

	/**
	 * Returns unanswered-to-the-model context for one explicit task reprocess.
	 * A successful later estimate consumes each linked field so old answers do
	 * not constrain unrelated future reprocess commands.
	 */
	async reprocessContext(taskId: string): Promise<QuestionReprocessContext | null> {
		const { events } = await this.options.history.readAll();
		const taskEvents = events.filter((event) => event.taskId === taskId);
		const answeredPairs = taskEvents
			.map((event, askedIndex) => {
				if (event.kind !== "question-asked") return null;
				const answerIndex = findAnswerIndex(taskEvents, event, askedIndex + 1);
				if (answerIndex === -1) return null;
				return {
					asked: event,
					answer: taskEvents[answerIndex] as QuestionEvent,
					answerIndex,
				};
			})
			.filter((pair): pair is AnsweredQuestion => pair !== null);

		const applicable = await Promise.all(
			answeredPairs.map(async ({ asked, answer, answerIndex }) => {
				const retired = lockedAfterQuestion(taskEvents, asked);
				const consumed = fieldsConsumedAfterAnswer(taskEvents, answerIndex);
				const answerFields = new Set(answer.affectedFields);
				const fields = (await this.unlockedFields(asked)).filter(
					(field) =>
						answerFields.has(field) && !retired.has(field) && !consumed.has(field),
				);
				return { asked, answer, fields };
			}),
		);
		const active = applicable.filter((pair) => pair.fields.length > 0);
		if (active.length === 0) return null;

		const activeFields = new Set(active.flatMap((pair) => pair.fields));
		return {
			onlyFields: ESTIMATE_FIELDS.filter((field) => activeFields.has(field)),
			questionContext: boundedQuestionContext(active),
		};
	}

	private async pending(): Promise<PendingQuestion[]> {
		const { events } = await this.options.history.readAll();
		const answers = events.filter(
			(event): event is QuestionEvent => event.kind === "question-answered",
		);
		const answeredEventIds = new Set(answers.map((event) => event.questionId));
		// Older answer events stored the model-provided question ID. Retain
		// compatibility while namespacing it to its originating run/session.
		const legacyAnswers = new Set(answers.map(legacyQuestionKey));
		const unanswered = events.filter(
			(event): event is QuestionEvent =>
				event.kind === "question-asked" &&
				!answeredEventIds.has(event.id) &&
				!legacyAnswers.has(legacyQuestionKey(event)),
		);
		return (
			await Promise.all(
				unanswered.map(async (asked) => {
					const retired = lockedAfterQuestion(events, asked);
					const affectedFields = (await this.unlockedFields(asked)).filter(
						(field) => !retired.has(field),
					);
					return {
						asked,
						task: this.options.findTask(asked.taskId),
						affectedFields,
					};
				}),
			)
		).filter((item) => item.affectedFields.length > 0);
	}

	private async unlockedFields(asked: QuestionEvent): Promise<EstimateField[]> {
		if (this.options.history.provenanceForTask === undefined) {
			return [...asked.affectedFields];
		}
		const provenance = await this.options.history.provenanceForTask(
			asked.taskId,
			this.now().toISOString(),
		);
		return asked.affectedFields.filter((field) => {
			const state = provenance.fields[field];
			return state.owner === "ai" && !state.locked;
		});
	}
}

interface AnsweredQuestion {
	asked: QuestionEvent;
	answer: QuestionEvent;
	answerIndex: number;
}

interface ApplicableAnswer {
	asked: QuestionEvent;
	answer: QuestionEvent;
	fields: EstimateField[];
}

function findAnswerIndex(
	events: readonly EstimateFeedbackEvent[],
	asked: QuestionEvent,
	start: number,
): number {
	for (let index = start; index < events.length; index++) {
		const event = events[index]!;
		if (event.kind !== "question-answered") continue;
		if (
			event.questionId === asked.id ||
			legacyQuestionKey(event) === legacyQuestionKey(asked)
		) {
			return index;
		}
	}
	return -1;
}

function fieldsConsumedAfterAnswer(
	events: readonly EstimateFeedbackEvent[],
	answerIndex: number,
): ReadonlySet<EstimateField> {
	const consumed = new Set<EstimateField>();
	for (let index = answerIndex + 1; index < events.length; index++) {
		const event = events[index]!;
		if (event.kind === "estimate-suggested") {
			for (const field of event.appliedFields) consumed.add(field);
		} else if (event.kind === "estimate-field-suggested") {
			consumed.add(event.field);
		}
	}
	return consumed;
}

function boundedQuestionContext(pairs: readonly ApplicableAnswer[]): string {
	const selected: string[] = [];
	let remaining = MAX_QUESTION_CONTEXT_LENGTH;
	for (let index = pairs.length - 1; index >= 0 && remaining > 0; index--) {
		const pair = pairs[index]!;
		const block = `Question: ${pair.asked.text}\nAnswer: ${pair.answer.text}`;
		const separatorLength = selected.length === 0 ? 0 : 2;
		if (block.length + separatorLength <= remaining) {
			selected.unshift(block);
			remaining -= block.length + separatorLength;
			continue;
		}
		if (selected.length === 0) {
			selected.unshift(boundedPairBlock(pair, remaining));
		}
		break;
	}
	return selected.join("\n\n");
}

function boundedPairBlock(pair: ApplicableAnswer, maximum: number): string {
	const prefixLength = "Question: \nAnswer: ".length;
	const available = Math.max(0, maximum - prefixLength);
	let questionLength = Math.min(pair.asked.text.length, Math.floor(available / 2));
	const answerLength = Math.min(pair.answer.text.length, available - questionLength);
	questionLength = Math.min(pair.asked.text.length, available - answerLength);
	return `Question: ${pair.asked.text.slice(0, questionLength)}\nAnswer: ${pair.answer.text.slice(
		0,
		answerLength,
	)}`;
}

/**
 * A later manual lock retires that field from the original question forever.
 * An explicit future unlock permits a new reprocess, but must not resurrect a
 * stale question whose answer could overwrite the user's intervening edit.
 */
function lockedAfterQuestion(
	events: readonly EstimateFeedbackEvent[],
	asked: QuestionEvent,
): ReadonlySet<EstimateField> {
	const retired = new Set<EstimateField>();
	let seenAsked = false;
	for (const event of events) {
		if (!seenAsked) {
			seenAsked = event.id === asked.id;
			continue;
		}
		if (event.taskId !== asked.taskId) continue;
		switch (event.kind) {
			case "estimate-corrected":
			case "estimate-manual":
			case "scope-changed":
				retired.add(event.field);
				break;
			case "field-locked":
				for (const field of event.fields) retired.add(field);
				break;
			default:
				break;
		}
	}
	return retired;
}

function legacyQuestionKey(event: QuestionEvent): string {
	return `${event.runId ?? ""}\0${event.sessionId ?? ""}\0${event.taskId}\0${event.questionId}`;
}

function safeId(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
	return /^[A-Za-z0-9]/u.test(normalized) ? normalized : `id_${normalized}`;
}
