import { formatDuration } from "../core/estimates/format";
import type { Task } from "../core/model/Task";
import { parseScopeCatalog, scopeById, type ScopeCatalog } from "../core/scope/scope";
import type { DurationLongStyle } from "../settings/Settings";

/** Serialized task metadata for widget renderers; all values are manual-only. */
export interface WidgetTaskMetadata {
	durationMinutes: number | null;
	durationLabel: string | null;
	cognitiveIntensity: number | null;
	emotionalIntensity: number | null;
	physicalIntensity: number | null;
	scopeId: string | null;
	scopeName: string | null;
}

export function widgetScopeCatalog(files: Record<string, string>, errors: string[]): ScopeCatalog {
	const raw = files[".gtd-flow/config/scopes.json"];
	if (raw === undefined) return { schemaVersion: 1, scopes: [] };
	try {
		const parsed = parseScopeCatalog(JSON.parse(raw));
		if (parsed.diagnostics.length > 0) errors.push("scope catalog contains invalid entries");
		return parsed.catalog;
	} catch {
		errors.push("scope catalog is not valid JSON");
		return { schemaVersion: 1, scopes: [] };
	}
}

export function widgetTaskMetadata(
	task: Task,
	catalog: ScopeCatalog,
	longStyle: DurationLongStyle = "whole-days",
): WidgetTaskMetadata {
	const resolvedScope = scopeById(catalog, task.scopeId);
	return {
		durationMinutes: task.durationMinutes,
		durationLabel:
			task.durationMinutes === null ? null : formatDuration(task.durationMinutes, longStyle),
		cognitiveIntensity: task.cognitiveIntensity,
		emotionalIntensity: task.emotionalIntensity,
		physicalIntensity: task.physicalIntensity,
		scopeId: task.scopeId,
		scopeName: resolvedScope?.name ?? task.scopeId,
	};
}
