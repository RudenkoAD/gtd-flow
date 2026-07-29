import {
	isDurationMinutes,
	isIntensityLevel,
	type DurationMinutes,
	type IntensityLevel,
} from "../model/Task";
import { isActiveScopeId, type ScopeCatalog } from "../scope/scope";

export const ESTIMATE_FIELDS = ["duration", "cognitive", "emotional", "physical", "scope"] as const;

export type EstimateField = (typeof ESTIMATE_FIELDS)[number];
export type FieldOwner = "ai" | "user";

export interface FieldProvenance {
	owner: FieldOwner;
	locked: boolean;
	lastPredictionEventId: string | null;
	updatedAt: string;
}

export interface TaskEstimateProvenance {
	schemaVersion: 1;
	taskId: string;
	fields: Record<EstimateField, FieldProvenance>;
}

export interface EstimateValues {
	durationMinutes: DurationMinutes | null;
	cognitiveIntensity: IntensityLevel;
	emotionalIntensity: IntensityLevel;
	physicalIntensity: IntensityLevel;
	scopeId: string;
}

export interface EstimatePatch {
	durationMinutes?: DurationMinutes | null;
	cognitiveIntensity?: IntensityLevel | null;
	emotionalIntensity?: IntensityLevel | null;
	physicalIntensity?: IntensityLevel | null;
	scopeId?: string | null;
}

export interface PredictionApplication {
	patch: EstimatePatch;
	provenance: TaskEstimateProvenance;
	applied: EstimateField[];
	skippedLocked: EstimateField[];
}

export function emptyTaskProvenance(taskId: string, now: string): TaskEstimateProvenance {
	if (taskId.trim() === "") throw new Error("task-id-required");
	return {
		schemaVersion: 1,
		taskId,
		fields: Object.fromEntries(
			ESTIMATE_FIELDS.map((field) => [
				field,
				{
					owner: "ai",
					locked: false,
					lastPredictionEventId: null,
					updatedAt: now,
				} satisfies FieldProvenance,
			]),
		) as Record<EstimateField, FieldProvenance>,
	};
}

/**
 * Convert a validated prediction to the single atomic Markdown patch while
 * preserving every user-owned lock independently.
 */
export function applyAiPrediction(input: {
	taskId: string;
	values: EstimateValues;
	catalog: ScopeCatalog;
	predictionEventId: string;
	now: string;
	current?: TaskEstimateProvenance | null;
	onlyFields?: readonly EstimateField[];
}): PredictionApplication {
	validateEstimateValues(input.values, input.catalog);
	if (input.predictionEventId.trim() === "") throw new Error("prediction-event-id-required");
	const provenance = cloneProvenance(
		input.current ?? emptyTaskProvenance(input.taskId, input.now),
	);
	if (provenance.taskId !== input.taskId) throw new Error("provenance-task-id-mismatch");
	const requested = new Set(input.onlyFields ?? ESTIMATE_FIELDS);
	const patch: EstimatePatch = {};
	const applied: EstimateField[] = [];
	const skippedLocked: EstimateField[] = [];

	for (const field of ESTIMATE_FIELDS) {
		if (!requested.has(field)) continue;
		const state = provenance.fields[field];
		if (state.locked || state.owner === "user") {
			skippedLocked.push(field);
			continue;
		}
		assignPatchValue(patch, field, input.values);
		provenance.fields[field] = {
			owner: "ai",
			locked: false,
			lastPredictionEventId: input.predictionEventId,
			updatedAt: input.now,
		};
		applied.push(field);
	}
	return { patch, provenance, applied, skippedLocked };
}

/**
 * Any edit whose origin is not provably the current AI mutation is treated as
 * a user edit. That deliberately favors false locking over lost corrections.
 */
export function lockUserEditedFields(input: {
	provenance: TaskEstimateProvenance | null;
	taskId: string;
	fields: readonly EstimateField[];
	now: string;
}): TaskEstimateProvenance {
	const next = cloneProvenance(input.provenance ?? emptyTaskProvenance(input.taskId, input.now));
	if (next.taskId !== input.taskId) throw new Error("provenance-task-id-mismatch");
	for (const field of new Set(input.fields)) {
		next.fields[field] = {
			...next.fields[field],
			owner: "user",
			locked: true,
			updatedAt: input.now,
		};
	}
	return next;
}

export function unlockFields(input: {
	provenance: TaskEstimateProvenance;
	fields: readonly EstimateField[];
	now: string;
}): TaskEstimateProvenance {
	const next = cloneProvenance(input.provenance);
	for (const field of new Set(input.fields)) {
		next.fields[field] = {
			...next.fields[field],
			owner: "ai",
			locked: false,
			updatedAt: input.now,
		};
	}
	return next;
}

export function parseTaskEstimateProvenance(value: unknown): TaskEstimateProvenance | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		record["schemaVersion"] !== 1 ||
		typeof record["taskId"] !== "string" ||
		record["taskId"].trim() === "" ||
		typeof record["fields"] !== "object" ||
		record["fields"] === null ||
		Array.isArray(record["fields"])
	) {
		return null;
	}
	const rawFields = record["fields"] as Record<string, unknown>;
	const fields = {} as Record<EstimateField, FieldProvenance>;
	for (const field of ESTIMATE_FIELDS) {
		const raw = rawFields[field];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const state = raw as Record<string, unknown>;
		if (
			(state["owner"] !== "ai" && state["owner"] !== "user") ||
			typeof state["locked"] !== "boolean" ||
			(state["lastPredictionEventId"] !== null &&
				typeof state["lastPredictionEventId"] !== "string") ||
			typeof state["updatedAt"] !== "string"
		) {
			return null;
		}
		fields[field] = {
			owner: state["owner"],
			locked: state["locked"],
			lastPredictionEventId: state["lastPredictionEventId"],
			updatedAt: state["updatedAt"],
		};
	}
	return { schemaVersion: 1, taskId: record["taskId"], fields };
}

function validateEstimateValues(values: EstimateValues, catalog: ScopeCatalog): void {
	if (values.durationMinutes !== null && !isDurationMinutes(values.durationMinutes)) {
		throw new Error("invalid-duration");
	}
	if (
		!isIntensityLevel(values.cognitiveIntensity) ||
		!isIntensityLevel(values.emotionalIntensity) ||
		!isIntensityLevel(values.physicalIntensity)
	) {
		throw new Error("invalid-intensity");
	}
	if (!isActiveScopeId(catalog, values.scopeId)) throw new Error("invalid-active-scope");
}

function assignPatchValue(
	patch: EstimatePatch,
	field: EstimateField,
	values: EstimateValues,
): void {
	switch (field) {
		case "duration":
			patch.durationMinutes = values.durationMinutes;
			break;
		case "cognitive":
			patch.cognitiveIntensity = values.cognitiveIntensity;
			break;
		case "emotional":
			patch.emotionalIntensity = values.emotionalIntensity;
			break;
		case "physical":
			patch.physicalIntensity = values.physicalIntensity;
			break;
		case "scope":
			patch.scopeId = values.scopeId;
			break;
		default: {
			const exhaustive: never = field;
			return exhaustive;
		}
	}
}

function cloneProvenance(value: TaskEstimateProvenance): TaskEstimateProvenance {
	return {
		schemaVersion: 1,
		taskId: value.taskId,
		fields: Object.fromEntries(
			ESTIMATE_FIELDS.map((field) => [field, { ...value.fields[field] }]),
		) as Record<EstimateField, FieldProvenance>,
	};
}
