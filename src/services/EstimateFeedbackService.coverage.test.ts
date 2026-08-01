import { describe, expect, it } from "vitest";
import type { Task } from "../core/model/Task";
import type { EstimateField } from "../core/estimates/provenance";
import {
	EstimateFeedbackService,
	FEEDBACK_FOLDER,
	FEEDBACK_OUTBOX_FOLDER,
	isStoredTaskProvenance,
	parseFeedbackEvent,
	type EstimateCorrectedEvent,
	type EstimateFeedbackEvent,
	type EstimateSuggestedEvent,
} from "./EstimateFeedbackService";
import {
	buildConfirmedExamples,
	EstimateMemoryService,
	isCorrectionEvent,
} from "./EstimateMemoryService";

class MemoryStorage {
	readonly files = new Map<string, string>();

	async list(path: string): Promise<string[]> {
		return [...this.files.keys()].filter((file) => file.startsWith(`${path}/`));
	}

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

	async delete(path: string): Promise<void> {
		this.files.delete(path);
	}
}

function suggested(id = "prediction-1", taskId = "task-1"): EstimateSuggestedEvent {
	return {
		schemaVersion: 1,
		id,
		kind: "estimate-suggested",
		taskId,
		createdAt: "2026-07-28T00:00:00.000Z",
		runId: "run-1",
		sessionId: "session-1",
		taskSnapshot: {
			text: "Reconcile invoices",
			tags: ["finance"],
			container: "inbox",
			heading: "Admin",
			recurrence: null,
		},
		values: {
			durationMinutes: 30,
			cognitiveIntensity: 3,
			emotionalIntensity: 1,
			physicalIntensity: 0,
			scopeId: "work",
		},
		confidence: { duration: 0.8, cognitive: 0.8, emotional: 0.8, physical: 0.8, scope: 0.8 },
		appliedFields: ["duration", "cognitive", "emotional", "physical", "scope"],
		actualModel: "model",
		provider: "openrouter",
		promptVersion: "v1",
		schemaVersionId: "v1",
		retrievedExampleIds: ["example-1"],
	};
}

function corrected(
	id: string,
	field: EstimateField,
	value: number | string | null,
	taskId = "task-1",
): EstimateCorrectedEvent {
	return {
		schemaVersion: 1,
		id,
		kind: field === "scope" ? "scope-changed" : "estimate-corrected",
		taskId,
		createdAt: "2026-07-28T00:01:00.000Z",
		runId: null,
		sessionId: null,
		field,
		previousValue: null,
		value,
	};
}

describe("Estimate feedback parsing and recovery breadth", () => {
	it("validates every persisted event family and rejects malformed sensitive input", () => {
		const prediction = suggested();
		expect(parseFeedbackEvent(prediction)).toEqual(prediction);
		expect(
			parseFeedbackEvent({
				...prediction,
				id: "unlock-1",
				kind: "field-unlocked",
				fields: ["duration", "duration", "scope"],
			}),
		).toMatchObject({ kind: "field-unlocked", fields: ["duration", "scope"] });
		expect(
			parseFeedbackEvent({
				...prediction,
				id: "question-1",
				kind: "question-answered",
				questionId: "q1",
				affectedFields: ["physical"],
				text: "How strenuous?",
			}),
		).toMatchObject({ kind: "question-answered", questionId: "q1" });
		expect(parseFeedbackEvent({ ...prediction, id: "bad/id" })).toBeNull();
		expect(parseFeedbackEvent({ ...prediction, apiKey: "not allowed" })).toBeNull();
		expect(parseFeedbackEvent({ ...prediction, provider: "other" })).toBeNull();
		expect(parseFeedbackEvent({ ...prediction, confidence: { duration: 2 } })).toBeNull();
		expect(
			parseFeedbackEvent({
				...prediction,
				taskSnapshot: { ...prediction.taskSnapshot, text: "x".repeat(2_001) },
			}),
		).toBeNull();
		expect(
			parseFeedbackEvent({ ...prediction, kind: "question-asked", affectedFields: ["bad"] }),
		).toBeNull();
	});

	it("retains canonical and task-state conflicts without guessing through them", async () => {
		const storage = new MemoryStorage();
		let now = new Date("2026-07-28T00:02:00.000Z");
		const service = new EstimateFeedbackService(storage, () => now);
		const event = corrected("canonical-conflict", "duration", 45);
		await service.prepareMutation(event, [
			{ field: "duration", previousValue: null, intendedValue: 45 },
		]);
		storage.files.set(
			`${FEEDBACK_FOLDER}/${event.id}.json`,
			JSON.stringify(corrected(event.id, "duration", 60)),
		);
		await expect(service.commitPrepared(event.id)).rejects.toThrow("feedback-event-conflict");
		expect(
			JSON.parse(storage.files.get(`${FEEDBACK_OUTBOX_FOLDER}/${event.id}.json`)!),
		).toMatchObject({
			state: "conflict",
			conflictReason: "canonical-event-conflict",
		});

		const missing = corrected("task-missing", "scope", "life");
		await service.prepareMutation(missing, [
			{ field: "scope", previousValue: null, intendedValue: "life" },
		]);
		storage.files.set(`${FEEDBACK_OUTBOX_FOLDER}/invalid.json`, "not-json");
		now = new Date("2026-07-28T00:03:00.000Z");
		await expect(service.recoverPending(() => null)).resolves.toMatchObject({
			conflicts: [
				expect.objectContaining({ id: "canonical-conflict" }),
				expect.objectContaining({ id: "task-missing", reason: "task-missing" }),
			],
			invalidPaths: [`${FEEDBACK_OUTBOX_FOLDER}/invalid.json`],
		});
		await expect(service.commitPrepared("absent")).rejects.toThrow("feedback-outbox-not-found");
	});

	it("rebuilds provenance and examples across correction field types", async () => {
		const prediction = suggested();
		const events: EstimateFeedbackEvent[] = [
			corrected("scope", "scope", "life"),
			corrected("physical", "physical", 2),
			corrected("emotional", "emotional", "not-a-number"),
			corrected("cognitive", "cognitive", 4),
			corrected("duration", "duration", null),
			prediction,
			{
				...prediction,
				id: "orphan-correction",
				taskId: "orphan",
				kind: "estimate-manual",
				field: "duration",
				previousValue: null,
				value: 50,
			},
			{
				...prediction,
				id: "question",
				kind: "question-asked",
				questionId: "q",
				affectedFields: ["duration"],
				text: "Question",
			},
		];
		const examples = buildConfirmedExamples(events);
		expect(examples).toHaveLength(2);
		expect(examples).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					values: expect.objectContaining({
						durationMinutes: null,
						cognitiveIntensity: 4,
						physicalIntensity: 2,
						scopeId: "life",
					}),
					confirmedFields: ["cognitive", "emotional", "physical", "scope"],
				}),
				expect.objectContaining({
					id: "orphan-correction",
					confirmedFields: ["duration"],
					values: expect.objectContaining({ durationMinutes: 50 }),
				}),
			]),
		);
		expect(isCorrectionEvent(corrected("manual", "duration", 45))).toBe(true);
		expect(isCorrectionEvent(prediction)).toBe(false);

		const history = new EstimateFeedbackService(new MemoryStorage());
		for (const event of [
			prediction,
			corrected("manual", "duration", 45),
			{
				...prediction,
				id: "unlock",
				createdAt: "2026-07-28T00:02:00.000Z",
				kind: "field-unlocked" as const,
				fields: ["duration" as const],
			},
		])
			await history.append(event);
		const provenance = await history.provenanceForTask("task-1", "2026-07-28T00:05:00.000Z");
		expect(provenance.fields.duration).toMatchObject({ owner: "ai", locked: false });
		expect(isStoredTaskProvenance(provenance)).toBe(true);
		expect(isStoredTaskProvenance({})).toBe(false);

		const memory = new EstimateMemoryService({
			readAll: async () => ({ events, invalidPaths: [] }),
		});
		const task = {
			description: "Reconcile invoices for the quarter",
			scopeId: "life",
			tags: ["finance"],
			container: "inbox",
			heading: "Admin",
			recurrence: null,
		} as Task;
		await expect(memory.examplesFor(task, "scope")).resolves.toEqual([
			expect.objectContaining({ value: "life" }),
		]);
	});
});
