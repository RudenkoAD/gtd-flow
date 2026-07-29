import { describe, expect, it } from "vitest";
import type { Task } from "../core/model/Task";
import type {
	EstimateCorrectedEvent,
	EstimateFieldSuggestedEvent,
	EstimateSuggestedEvent,
} from "./EstimateFeedbackService";
import { buildConfirmedExamples, EstimateMemoryService } from "./EstimateMemoryService";

const suggestion: EstimateSuggestedEvent = {
	schemaVersion: 1,
	id: "prediction-1",
	kind: "estimate-suggested",
	taskId: "task-1",
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
	confidence: {
		duration: 0.8,
		cognitive: 0.8,
		emotional: 0.8,
		physical: 0.8,
		scope: 0.8,
	},
	appliedFields: ["duration", "cognitive", "emotional", "physical", "scope"],
	actualModel: "free/model",
	provider: "openrouter",
	promptVersion: "v1",
	schemaVersionId: "v1",
	retrievedExampleIds: [],
};

function correction(value: number): EstimateCorrectedEvent {
	return {
		schemaVersion: 1,
		id: "correction-1",
		kind: "estimate-corrected",
		taskId: "task-1",
		createdAt: "2026-07-28T00:01:00.000Z",
		runId: null,
		sessionId: null,
		field: "duration",
		previousValue: 30,
		value,
	};
}

describe("EstimateMemoryService", () => {
	it("does not train on an unreviewed suggestion", () => {
		expect(buildConfirmedExamples([suggestion])).toEqual([]);
	});

	it("uses explicit corrections as labels and preserves the task snapshot", () => {
		const examples = buildConfirmedExamples([suggestion, correction(45)]);
		expect(examples).toHaveLength(1);
		expect(examples[0]).toMatchObject({
			id: "prediction-1",
			taskText: "Reconcile invoices",
			confirmedFields: ["duration"],
			values: { durationMinutes: 45 },
		});
	});

	it("learns a corrected field-local chat suggestion without placeholder-field leakage", () => {
		const chatSuggestion: EstimateFieldSuggestedEvent = {
			schemaVersion: 1,
			id: "chat-duration-1",
			kind: "estimate-field-suggested",
			taskId: "task-1",
			createdAt: "2026-07-28T00:00:00.000Z",
			runId: null,
			sessionId: "chat-1",
			field: "duration",
			value: 30,
			taskSnapshot: suggestion.taskSnapshot,
			confidence: 0,
			actualModel: "free/model",
			provider: "openrouter",
			promptVersion: "chat-tools-v1",
			schemaVersionId: "chat-tool-metadata-v1",
			retrievedExampleIds: [],
		};

		const examples = buildConfirmedExamples([chatSuggestion, correction(45)]);

		expect(examples).toEqual([
			expect.objectContaining({
				id: "chat-duration-1",
				confirmedFields: ["duration"],
				values: expect.objectContaining({ durationMinutes: 45 }),
			}),
		]);
	});

	it("keeps a correction with the suggestion it follows instead of a later suggestion", () => {
		const laterSuggestion: EstimateSuggestedEvent = {
			...suggestion,
			id: "prediction-2",
			createdAt: "2026-07-28T00:02:00.000Z",
			values: { ...suggestion.values, durationMinutes: 60 },
		};
		const laterCorrection = {
			...correction(45),
			id: "correction-2",
			createdAt: "2026-07-28T00:03:00.000Z",
			previousValue: 60,
			value: 75,
		};
		const examples = buildConfirmedExamples([
			suggestion,
			correction(45),
			laterSuggestion,
			laterCorrection,
		]);
		expect(examples).toEqual([
			expect.objectContaining({
				id: "prediction-1",
				confirmedFields: ["duration"],
				values: expect.objectContaining({ durationMinutes: 45 }),
			}),
			expect.objectContaining({
				id: "prediction-2",
				confirmedFields: ["duration"],
				values: expect.objectContaining({ durationMinutes: 75 }),
			}),
		]);
	});

	it("keeps a historical correction after ownership is explicitly unlocked", () => {
		const examples = buildConfirmedExamples([
			suggestion,
			correction(45),
			{
				schemaVersion: 1,
				id: "unlock-1",
				kind: "field-unlocked",
				taskId: "task-1",
				createdAt: "2026-07-28T00:02:00.000Z",
				runId: null,
				sessionId: null,
				fields: ["duration"],
			},
		]);
		expect(examples).toEqual([
			expect.objectContaining({
				id: "prediction-1",
				confirmedFields: ["duration"],
				values: expect.objectContaining({ durationMinutes: 45 }),
			}),
		]);
	});

	it("orders equivalent ISO representations by instant rather than lexicographically", () => {
		const offsetSuggestion: EstimateSuggestedEvent = {
			...suggestion,
			createdAt: "2026-07-28T01:00:00+02:00",
		};
		const laterCorrection: EstimateCorrectedEvent = {
			...correction(45),
			createdAt: "2026-07-28T00:00:00Z",
		};
		expect(buildConfirmedExamples([laterCorrection, offsetSuggestion])).toEqual([
			expect.objectContaining({
				id: "prediction-1",
				confirmedFields: ["duration"],
				values: expect.objectContaining({ durationMinutes: 45 }),
			}),
		]);
	});

	it("uses a bounded snapshot on standalone manual feedback as a label", () => {
		const examples = buildConfirmedExamples([
			{
				...correction(45),
				id: "manual-1",
				kind: "estimate-manual",
				previousValue: null,
				taskSnapshot: suggestion.taskSnapshot,
			},
		]);
		expect(examples).toEqual([
			expect.objectContaining({
				id: "manual-1",
				taskText: "Reconcile invoices",
				confirmedFields: ["duration"],
				values: expect.objectContaining({ durationMinutes: 45 }),
			}),
		]);
	});

	it("uses a standalone scope change as a scope label", () => {
		const examples = buildConfirmedExamples([
			{
				...correction(45),
				id: "manual-scope-1",
				kind: "scope-changed",
				field: "scope",
				previousValue: null,
				value: "life",
				taskSnapshot: suggestion.taskSnapshot,
			},
		]);
		expect(examples).toEqual([
			expect.objectContaining({
				id: "manual-scope-1",
				confirmedFields: ["scope"],
				values: expect.objectContaining({ scopeId: "life" }),
			}),
		]);
	});

	it("returns bounded field-specific prompt examples", async () => {
		const service = new EstimateMemoryService({
			readAll: async () => ({
				events: [suggestion, correction(45)],
				invalidPaths: [],
			}),
		});
		const task = {
			description: "Reconcile vendor invoices",
			scopeId: "work",
			tags: ["finance"],
			container: "inbox",
			heading: "Admin",
			recurrence: null,
		} as Task;
		await expect(service.examplesFor(task, "duration")).resolves.toEqual([
			{ id: "prediction-1", text: "Reconcile invoices", value: 45 },
		]);
		await expect(service.examplesFor(task, "physical")).resolves.toEqual([]);
	});
});
