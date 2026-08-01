import {
	retrieveEstimateExamples,
	type EstimateExample,
	type EstimateQuery,
} from "../core/estimates/memory";
import type { EstimateField } from "../core/estimates/provenance";
import type { Task } from "../core/model/Task";
import type {
	EstimateCorrectedEvent,
	EstimateFeedbackEvent,
	EstimateFieldSuggestedEvent,
	EstimateSuggestedEvent,
	EstimateTaskSnapshot,
	FeedbackReadResult,
} from "./EstimateFeedbackService";
import type { EstimateExamplePort, EstimatePromptExample } from "../ai/processing/InboxProcessor";

export interface EstimateMemoryHistory {
	readAll(): Promise<FeedbackReadResult>;
}

/**
 * Projects immutable feedback into the deterministic lexical retrieval corpus.
 * It is rebuildable: deleting this service's future cache loses no labels.
 */
export class EstimateMemoryService implements EstimateExamplePort {
	constructor(private readonly history: EstimateMemoryHistory) {}

	async examplesFor(task: Task, field: EstimateField): Promise<readonly EstimatePromptExample[]> {
		const { events } = await this.history.readAll();
		const examples = buildConfirmedExamples(events);
		const query: EstimateQuery = {
			taskText: task.description,
			scopeId: task.scopeId,
			tags: task.tags,
			container: task.container,
			heading: task.heading,
			recurrence: task.recurrence,
		};
		return retrieveEstimateExamples(examples, query, field, 5).map(({ example }) => ({
			id: example.id,
			text: example.taskText.slice(0, 500),
			value: fieldValue(example, field),
		}));
	}
}

export function buildConfirmedExamples(
	events: readonly EstimateFeedbackEvent[],
): EstimateExample[] {
	const ordered = [...events].sort(
		(left, right) =>
			Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
			left.id.localeCompare(right.id),
	);
	const candidates: ReplayCandidate[] = [];
	const activeByTask = new Map<string, Map<EstimateField, ReplayCandidate>>();
	for (const event of ordered) {
		if (event.kind === "estimate-suggested") {
			const candidate = candidateFromSuggestion(event);
			candidates.push(candidate);
			const active =
				activeByTask.get(event.taskId) ?? new Map<EstimateField, ReplayCandidate>();
			for (const field of event.appliedFields) active.set(field, candidate);
			activeByTask.set(event.taskId, active);
			continue;
		}
		if (event.kind === "estimate-field-suggested") {
			const candidate = candidateFromFieldSuggestion(event);
			candidates.push(candidate);
			const active =
				activeByTask.get(event.taskId) ?? new Map<EstimateField, ReplayCandidate>();
			active.set(event.field, candidate);
			activeByTask.set(event.taskId, active);
			continue;
		}
		if (
			event.kind === "estimate-corrected" ||
			event.kind === "estimate-manual" ||
			event.kind === "scope-changed"
		) {
			const active =
				activeByTask.get(event.taskId) ?? new Map<EstimateField, ReplayCandidate>();
			if (event.value === null) {
				const candidate = active.get(event.field);
				if (candidate !== undefined) {
					candidate.confirmedFields.delete(event.field);
					clearCandidateValue(candidate.values, event.field);
				}
				active.delete(event.field);
				continue;
			}
			let candidate = active.get(event.field);
			if (candidate === undefined && event.taskSnapshot !== undefined) {
				candidate = candidateFromStandaloneCorrection(event);
				candidates.push(candidate);
				active.set(event.field, candidate);
				activeByTask.set(event.taskId, active);
			}
			if (candidate === undefined) continue;
			candidate.confirmedFields.add(event.field);
			applyCorrectedValue(candidate.values, event.field, event.value);
			continue;
		}
		if (event.kind === "field-unlocked") {
			const active = activeByTask.get(event.taskId);
			if (active === undefined) continue;
			for (const field of event.fields) {
				// Unlocking changes future ownership, not historical truth. Keep the
				// explicit correction as a training label, but detach it from future
				// corrections until a new suggestion becomes active.
				active.delete(field);
			}
		}
	}

	return candidates
		.filter((candidate) => candidate.confirmedFields.size > 0)
		.map(asEstimateExample)
		.sort(
			(left, right) =>
				Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
}

interface ReplayCandidate {
	id: string;
	taskId: string;
	createdAt: string;
	snapshot: EstimateTaskSnapshot;
	values: EstimateSuggestedEvent["values"];
	confirmedFields: Set<EstimateField>;
}

function candidateFromSuggestion(event: EstimateSuggestedEvent): ReplayCandidate {
	return {
		id: event.id,
		taskId: event.taskId,
		createdAt: event.createdAt,
		snapshot: event.taskSnapshot,
		values: { ...event.values },
		confirmedFields: new Set<EstimateField>(),
	};
}

function candidateFromFieldSuggestion(event: EstimateFieldSuggestedEvent): ReplayCandidate {
	const candidate: ReplayCandidate = {
		id: event.id,
		taskId: event.taskId,
		createdAt: event.createdAt,
		snapshot: event.taskSnapshot,
		values: emptyCandidateValues(),
		confirmedFields: new Set<EstimateField>(),
	};
	applyCorrectedValue(candidate.values, event.field, event.value);
	return candidate;
}

function candidateFromStandaloneCorrection(event: EstimateCorrectedEvent): ReplayCandidate {
	if (event.taskSnapshot === undefined) throw new Error("feedback-task-snapshot-required");
	const values = emptyCandidateValues();
	applyCorrectedValue(values, event.field, event.value);
	return {
		id: event.id,
		taskId: event.taskId,
		createdAt: event.createdAt,
		snapshot: event.taskSnapshot,
		values,
		confirmedFields: new Set<EstimateField>(),
	};
}

function emptyCandidateValues(): EstimateSuggestedEvent["values"] {
	return {
		durationMinutes: null,
		cognitiveIntensity: 0,
		emotionalIntensity: 0,
		physicalIntensity: 0,
		scopeId: "",
	};
}

function asEstimateExample(candidate: ReplayCandidate): EstimateExample {
	return {
		id: candidate.id,
		taskId: candidate.taskId,
		taskText: candidate.snapshot.text,
		scopeId: candidate.values.scopeId,
		tags: candidate.snapshot.tags,
		container: candidate.snapshot.container,
		heading: candidate.snapshot.heading,
		recurrence: candidate.snapshot.recurrence,
		values: candidate.values,
		confirmedFields: [...candidate.confirmedFields],
		createdAt: candidate.createdAt,
	};
}

function applyCorrectedValue(
	values: EstimateSuggestedEvent["values"],
	field: EstimateField,
	value: number | string | null,
): void {
	switch (field) {
		case "duration":
			if (value === null || typeof value === "number") values.durationMinutes = value;
			break;
		case "cognitive":
			if (typeof value === "number")
				values.cognitiveIntensity = value as 0 | 1 | 2 | 3 | 4 | 5;
			break;
		case "emotional":
			if (typeof value === "number")
				values.emotionalIntensity = value as 0 | 1 | 2 | 3 | 4 | 5;
			break;
		case "physical":
			if (typeof value === "number")
				values.physicalIntensity = value as 0 | 1 | 2 | 3 | 4 | 5;
			break;
		case "scope":
			if (typeof value === "string") values.scopeId = value;
			break;
	}
}

function clearCandidateValue(values: EstimateSuggestedEvent["values"], field: EstimateField): void {
	switch (field) {
		case "duration":
			values.durationMinutes = null;
			break;
		case "cognitive":
			values.cognitiveIntensity = 0;
			break;
		case "emotional":
			values.emotionalIntensity = 0;
			break;
		case "physical":
			values.physicalIntensity = 0;
			break;
		case "scope":
			values.scopeId = "";
			break;
	}
}

function fieldValue(example: EstimateExample, field: EstimateField): number | string | null {
	switch (field) {
		case "duration":
			return example.values.durationMinutes;
		case "cognitive":
			return example.values.cognitiveIntensity;
		case "emotional":
			return example.values.emotionalIntensity;
		case "physical":
			return example.values.physicalIntensity;
		case "scope":
			return example.values.scopeId;
	}
}

/** Useful to adapters that distinguish label-producing correction records. */
export function isCorrectionEvent(event: EstimateFeedbackEvent): event is EstimateCorrectedEvent {
	return (
		event.kind === "estimate-corrected" ||
		event.kind === "estimate-manual" ||
		event.kind === "scope-changed"
	);
}
