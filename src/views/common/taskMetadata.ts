import {
	isDurationMinutes,
	isIntensityLevel,
	type DurationMinutes,
	type IntensityLevel,
	type Task,
} from "../../core/model/Task";
import type { EstimateField, EstimatePatch } from "../../core/estimates/provenance";

/** Values kept by the multi-field metadata editor. Empty strings mean clear. */
export interface TaskMetadataDraft {
	durationMinutes: string;
	cognitiveIntensity: string;
	emotionalIntensity: string;
	physicalIntensity: string;
	scopeId: string;
}

export type MetadataEditorField = EstimateField;

export function metadataDraftFromTask(task: Task): TaskMetadataDraft {
	return {
		durationMinutes: task.durationMinutes === null ? "" : String(task.durationMinutes),
		cognitiveIntensity: task.cognitiveIntensity === null ? "" : String(task.cognitiveIntensity),
		emotionalIntensity: task.emotionalIntensity === null ? "" : String(task.emotionalIntensity),
		physicalIntensity: task.physicalIntensity === null ? "" : String(task.physicalIntensity),
		scopeId: task.scopeId ?? "",
	};
}

/**
 * Convert a user-entered multi-field draft to the smallest atomic intent patch.
 * Empty values deliberately clear their individual fields; untouched values are
 * omitted so opening the modal is never itself a mutation.
 */
export function metadataPatchFromDraft(task: Task, draft: TaskMetadataDraft): EstimatePatch {
	const duration = parseDuration(draft.durationMinutes);
	const cognitive = parseIntensity(draft.cognitiveIntensity);
	const emotional = parseIntensity(draft.emotionalIntensity);
	const physical = parseIntensity(draft.physicalIntensity);
	const scopeId = draft.scopeId.trim();

	const patch: EstimatePatch = {};
	if (duration !== task.durationMinutes) patch.durationMinutes = duration;
	if (cognitive !== task.cognitiveIntensity) patch.cognitiveIntensity = cognitive;
	if (emotional !== task.emotionalIntensity) patch.emotionalIntensity = emotional;
	if (physical !== task.physicalIntensity) patch.physicalIntensity = physical;
	if ((scopeId === "" ? null : scopeId) !== task.scopeId) {
		patch.scopeId = scopeId === "" ? null : scopeId;
	}
	return patch;
}

export function patchForMetadataField(field: EstimateField): EstimatePatch {
	switch (field) {
		case "duration":
			return { durationMinutes: null };
		case "cognitive":
			return { cognitiveIntensity: null };
		case "emotional":
			return { emotionalIntensity: null };
		case "physical":
			return { physicalIntensity: null };
		case "scope":
			return { scopeId: null };
		default: {
			const exhaustive: never = field;
			return exhaustive;
		}
	}
}

function parseDuration(raw: string): DurationMinutes | null {
	const value = raw.trim();
	if (value === "") return null;
	if (!/^\d+$/u.test(value))
		throw new Error("duration must use five-minute sub-day or whole-day increments");
	const minutes = Number(value);
	if (!isDurationMinutes(minutes)) {
		throw new Error("duration must use five-minute sub-day or whole-day increments");
	}
	return minutes;
}

function parseIntensity(raw: string): IntensityLevel | null {
	const value = raw.trim();
	if (value === "") return null;
	if (!/^\d+$/u.test(value)) throw new Error("intensity must be an integer from 0 to 5");
	const intensity = Number(value);
	if (!isIntensityLevel(intensity)) throw new Error("intensity must be an integer from 0 to 5");
	return intensity;
}
