/**
 * Minimal settings reader for the standalone widget bundle. Widgets use the
 * unified inbox and task scope IDs; they deliberately have no namespace model,
 * OAuth client, or AI runtime dependency.
 */
import { legacyInboxCandidates } from "../core/scope/namespaceMigration";
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
	if (isUsablePath(raw.inboxFile)) {
		settings.inboxFile = raw.inboxFile.trim();
	} else {
		// data.json ещё не мигрирован (v1): плагин выводит единый файл входящих из
		// настроек пространств, и виджет ОБЯЗАН выводить его так же — иначе захват
		// с телефона уходит в файл, который плагин входящими уже НЕ считает
		// (QueryEngine.isInInbox сверяет filePath с inboxFile), и задача пропадает.
		// Первого кандидата достаточно: как только десктопный плагин загрузится, он
		// запишет своё решение в data.json явным полем.
		const legacy = legacyInboxCandidates(raw).find(isUsablePath);
		if (legacy !== undefined) settings.inboxFile = legacy.trim();
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

/** NUL — единственный запрещённый символ пути (как в pathString). */
const NUL_RE = /\u0000/u;

/** Те же границы, что у pathString(false) в mergeSettings плагина. */
function isUsablePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= 1024 &&
		!NUL_RE.test(value)
	);
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
