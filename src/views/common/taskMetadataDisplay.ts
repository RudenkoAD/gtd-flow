import { formatDuration, INTENSITY_ANCHORS } from "../../core/estimates/format";
import type {
	EstimateField,
	FieldProvenance,
	TaskEstimateProvenance,
} from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import type { DurationLongStyle } from "../../settings/Settings";

export interface TaskMetadataDisplayPort {
	/** Resolve an immutable scope ID without making cards depend on catalog storage. */
	scopeName(scopeId: string): string | null;
	durationLongStyle?(): DurationLongStyle | null;
}

export interface TaskMetadataBadge {
	field: EstimateField;
	label: string;
	title: string;
}

/**
 * Screen-reader-visible labels and native tooltips for every populated metadata
 * value. Ownership is stated in words; color is intentionally not the signal.
 */
export function taskMetadataBadges(
	task: Task,
	port: TaskMetadataDisplayPort | null,
	provenance: TaskEstimateProvenance | null,
): TaskMetadataBadge[] {
	const out: TaskMetadataBadge[] = [];
	if (task.durationMinutes !== null) {
		const duration = displayDuration(task.durationMinutes, port?.durationLongStyle?.() ?? null);
		out.push({
			field: "duration",
			label: `⏱ ${duration}`,
			title: `Total elapsed duration: ${duration}. ${ownershipText(provenance?.fields.duration)}`,
		});
	}
	for (const [field, icon, name, value] of [
		["cognitive", "🧠", "Cognitive intensity", task.cognitiveIntensity],
		["emotional", "💓", "Emotional intensity", task.emotionalIntensity],
		["physical", "💪", "Physical intensity", task.physicalIntensity],
	] as const) {
		if (value === null) continue;
		out.push({
			field,
			label: `${icon} ${value}`,
			title: `${name}: ${value}/5 — ${INTENSITY_ANCHORS[field][value]}. ${ownershipText(provenance?.fields[field])}`,
		});
	}
	if (task.scopeId !== null) {
		const name = port?.scopeName(task.scopeId) ?? task.scopeId;
		out.push({
			field: "scope",
			label: `🧭 ${name}`,
			title: `Scope: ${name}${name === task.scopeId ? "" : ` (${task.scopeId})`}. ${ownershipText(provenance?.fields.scope)}`,
		});
	}
	return out;
}

export function displayDuration(minutes: number, longStyle: DurationLongStyle | null): string {
	return formatDuration(minutes, longStyle ?? "whole-days");
}

export function ownershipText(state: FieldProvenance | undefined): string {
	if (state === undefined) return "Ownership is unavailable.";
	if (state.owner === "user" || state.locked)
		return "Edited by you; locked against AI overwrite.";
	return "Suggested by AI; unlocked for explicit reprocessing.";
}
