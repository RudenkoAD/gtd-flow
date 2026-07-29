/**
 * Minimal settings reader for the standalone widget bundle. Widgets use the
 * unified inbox and task scope IDs; they deliberately have no namespace model,
 * OAuth client, or AI runtime dependency.
 */
import { DEFAULT_SETTINGS, type CalendarField, type GtdFlowSettings } from "../settings/Settings";

export interface LoadedSettings {
	settings: GtdFlowSettings;
	error: string | null;
}

export function loadWidgetSettings(dataJson: string | null): LoadedSettings {
	let raw: unknown = null;
	let error: string | null = null;
	if (dataJson !== null && dataJson !== undefined) {
		try {
			raw = JSON.parse(dataJson);
		} catch (cause) {
			error = `invalid data.json: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}
	return { settings: mergeWidgetSettings(raw), error };
}

function mergeWidgetSettings(raw: unknown): GtdFlowSettings {
	const settings: GtdFlowSettings = {
		...DEFAULT_SETTINGS,
		calendarPlacement: [...DEFAULT_SETTINGS.calendarPlacement],
	};
	if (!isRecord(raw)) return settings;
	if (
		typeof raw.inboxFile === "string" &&
		raw.inboxFile.trim() !== "" &&
		raw.inboxFile.length <= 1024 &&
		!raw.inboxFile.includes("\u0000")
	) {
		settings.inboxFile = raw.inboxFile.trim();
	}
	if (typeof raw.inboxIncludePlain === "boolean")
		settings.inboxIncludePlain = raw.inboxIncludePlain;
	if (
		raw.durationLongStyle === "unconfigured" ||
		raw.durationLongStyle === "total-hours" ||
		raw.durationLongStyle === "days-hours" ||
		raw.durationLongStyle === "whole-days"
	) {
		settings.durationLongStyle = "whole-days";
	}
	if (isCalendarPlacement(raw.calendarPlacement))
		settings.calendarPlacement = [...raw.calendarPlacement];
	return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendarPlacement(value: unknown): value is CalendarField[] {
	return (
		Array.isArray(value) &&
		value.length === 3 &&
		value.every(
			(field): field is CalendarField =>
				field === "due" || field === "scheduled" || field === "start",
		) &&
		new Set(value).size === 3
	);
}
