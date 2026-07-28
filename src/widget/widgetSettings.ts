/**
 * Загрузка настроек и разрешение пространств для виджет-бандла.
 *
 * Настройки читаются из СЫРОГО data.json и нормализуются к widget-подмножеству
 * (namespaces, commonRoot, calendarPlacement, inboxIncludePlain). Полная
 * versioned Zod-валидация живёт в plugin-only settings/mergeSettings: тащить её
 * в QuickJS-бандл нельзя, потому что зависимость использует Node globals. Отличие
 * от mcp/config: источник — строка из входа (а не файл на диске), поэтому здесь
 * нет fs. null / битый JSON ⇒ чистые дефолты (виджет работает и без плагина).
 *
 * Разрешение имени пространства (аргумент виджета «Работа»/«Общее»/«Все»/null) —
 * ЛЕНИЕНТНОЕ (в отличие от mcp/namespaces.resolveNamespaceFilter, который бросает):
 * виджет не должен падать из-за устаревшего имени в своей конфигурации — неизвестное
 * имя откатывается к «Общему», а факт отмечается в errors.
 */
import {
	ALL_NS,
	DEFAULT_NS,
	resolveNamespace,
	type NamespaceDef,
	type NamespaceFilter,
} from "../core/namespace/namespace";
import { ALL_NAMESPACES_LABEL, COMMON_NAMESPACE_LABEL } from "../core/namespace/labels";
import { normalizeActiveNamespace } from "../core/namespace/namespace";
import { DEFAULT_SETTINGS, type CalendarField, type GtdFlowSettings } from "../settings/Settings";

/** Отображаемое имя встроенного пространства «Общее» (всё вне корней). */
export const COMMON_LABEL = COMMON_NAMESPACE_LABEL;
/** Отображаемое имя агрегата «Все пространства». */
export const ALL_LABEL = ALL_NAMESPACES_LABEL;

export interface LoadedSettings {
	settings: GtdFlowSettings;
	/** Сообщение об ошибке разбора data.json (для errors[]), либо null. */
	error: string | null;
}

/** Слить сырой data.json с дефолтами. null/битый JSON ⇒ дефолты (+ error). */
export function loadWidgetSettings(dataJson: string | null): LoadedSettings {
	let loaded: unknown = null;
	let error: string | null = null;
	if (dataJson !== null && dataJson !== undefined) {
		try {
			loaded = JSON.parse(dataJson);
		} catch (e) {
			error = `invalid data.json: ${e instanceof Error ? e.message : String(e)}`;
			loaded = null;
		}
	}
	const merged = mergeWidgetSettings(loaded);
	merged.activeNamespace = normalizeActiveNamespace(merged.activeNamespace, merged.namespaces);
	return { settings: merged, error };
}

/**
 * Widget reads only four persisted settings. Validate precisely those fields and
 * deep-copy their collections; everything else remains a factory default. This
 * keeps the standalone QuickJS artifact free of Node-oriented validation code
 * while malformed data.json still cannot crash namespace/calendar rendering.
 */
function mergeWidgetSettings(raw: unknown): GtdFlowSettings {
	const settings: GtdFlowSettings = {
		...DEFAULT_SETTINGS,
		calendarPlacement: [...DEFAULT_SETTINGS.calendarPlacement],
		namespaces: [],
	};
	if (!isRecord(raw)) return settings;
	if (
		typeof raw.commonRoot === "string" &&
		raw.commonRoot.length <= 1024 &&
		!raw.commonRoot.includes("\u0000")
	) {
		settings.commonRoot = raw.commonRoot.trim();
	}
	if (typeof raw.inboxIncludePlain === "boolean")
		settings.inboxIncludePlain = raw.inboxIncludePlain;
	if (typeof raw.activeNamespace === "string" && raw.activeNamespace.length <= 256) {
		settings.activeNamespace = raw.activeNamespace;
	}
	const placement = raw.calendarPlacement;
	if (isCalendarPlacement(placement)) settings.calendarPlacement = [...placement];
	const namespaces = raw.namespaces;
	if (Array.isArray(namespaces)) {
		const seen = new Set<string>();
		for (const entry of namespaces) {
			if (
				!isRecord(entry) ||
				typeof entry.name !== "string" ||
				typeof entry.root !== "string"
			)
				continue;
			const name = entry.name.trim();
			const root = entry.root.trim().replace(/\/+$/, "");
			if (
				name === "" ||
				root === "" ||
				seen.has(name) ||
				name.length > 256 ||
				root.length > 1024
			)
				continue;
			seen.add(name);
			settings.namespaces.push({ name, root });
		}
	}
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

/** Внутреннее активное имя пространства → человекочитаемая метка. */
export function nsLabel(active: string): string {
	if (active === DEFAULT_NS) return COMMON_LABEL;
	if (active === ALL_NS) return ALL_LABEL;
	return active;
}

/** Эффективное пространство файла как метка (для сериализации задач/событий). */
export function fileNsLabel(
	filePath: string,
	nsOverride: string | null | undefined,
	defs: readonly NamespaceDef[],
): string {
	return nsLabel(resolveNamespace(filePath, nsOverride, defs));
}

/**
 * Аргумент пространства виджета → активное внутреннее имя (sentinel/имя).
 * null/пусто ⇒ DEFAULT_NS («Общее»). «Все»/«all»/«*» ⇒ ALL_NS. «Общее»/«common»/
 * «default» ⇒ DEFAULT_NS. Иначе — имя пользовательского пространства; неизвестное
 * имя ⇒ DEFAULT_NS + запись в errors (ленитентно, без throw). allowAll=false
 * (контекст записи) откатывает «Все» к «Общему».
 */
export function resolveWidgetActive(
	arg: string | null | undefined,
	settings: GtdFlowSettings,
	errors: string[],
	allowAll = true,
): string {
	if (arg === null || arg === undefined || arg.trim() === "") return DEFAULT_NS;
	const a = arg.trim();
	// Same precedence as MCP: a real namespace named "All"/"Default" remains
	// addressable instead of being shadowed by a convenient alias.
	if (settings.namespaces.some((d) => d.name === a)) return a;
	const lower = a.toLowerCase();
	if (a === ALL_LABEL || lower === "all" || a === "*") {
		return allowAll ? ALL_NS : DEFAULT_NS;
	}
	if (a === COMMON_LABEL || lower === "common" || lower === "default") return DEFAULT_NS;
	if (settings.namespaces.some((d) => d.name === a)) return a;
	errors.push(`unknown namespace '${a}' — falling back to '${COMMON_LABEL}'`);
	return DEFAULT_NS;
}

/** Собрать NamespaceFilter из активного имени. */
export function widgetFilter(active: string, settings: GtdFlowSettings): NamespaceFilter {
	return { active, defs: settings.namespaces };
}
