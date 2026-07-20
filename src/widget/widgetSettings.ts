/**
 * Загрузка настроек и разрешение пространств для виджет-бандла.
 *
 * Настройки читаются из СЫРОГО data.json тем же mergeSettings + DEFAULT_SETTINGS +
 * normalizeActiveNamespace, что и плагин/MCP (config.ts) — namespaces, commonRoot,
 * eventsFile, calendarPlacement, inboxIncludePlain трактуются идентично. Отличие от
 * mcp/config: источник — строка из входа (а не файл на диске), поэтому здесь нет fs.
 * null / битый JSON ⇒ чистые дефолты (виджет работает и без плагина).
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
import { normalizeActiveNamespace } from "../core/namespace/namespace";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "../settings/Settings";
import { mergeSettings } from "../settings/mergeSettings";

/** Отображаемое имя встроенного пространства «Общее» (всё вне корней). */
export const COMMON_LABEL = "Общее";
/** Отображаемое имя агрегата «Все пространства». */
export const ALL_LABEL = "Все";

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
	const merged = mergeSettings(DEFAULT_SETTINGS, loaded);
	merged.activeNamespace = normalizeActiveNamespace(merged.activeNamespace, merged.namespaces);
	return { settings: merged, error };
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
