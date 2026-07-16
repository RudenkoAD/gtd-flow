/**
 * Слияние сохранённых настроек с дефолтами (ТЗ §9).
 *
 * Плоский Object.assign терял бы вложенные дефолты: частичный data.json вида
 * `{"recurring":{"spawnTarget":…}}` обнулил бы catchUp/catchUpCap (политика
 * undefined читается как «none» — регулярные молча теряют вхождения), а
 * недостающий debounceMs.fileReindex дал бы setTimeout(cb, undefined) = 0 мс.
 * Поэтому debounceMs и recurring сливаются поключево. Массивы (namespaces,
 * calendarPlacement, deferPresets) и statusMap заменяются целиком — осознанная
 * семантика. Неизвестные ключи (в т.ч. из будущих версий И выпиленный inboxSources
 * из старого data.json) сохраняются как есть — миграция бесшумна, поля не роняют.
 */
import type { GtdFlowSettings } from "./Settings";

export function mergeSettings(defaults: GtdFlowSettings, loaded: unknown): GtdFlowSettings {
	const data = asObject<GtdFlowSettings>(loaded);
	return {
		...defaults,
		...data,
		debounceMs: { ...defaults.debounceMs, ...asObject<GtdFlowSettings["debounceMs"]>(data.debounceMs) },
		recurring: { ...defaults.recurring, ...asObject<GtdFlowSettings["recurring"]>(data.recurring) },
	};
}

/** Мусор вместо объекта (число/строка/null из руками правленного data.json)
 *  не должен ломать спред: {..."abc"} дал бы индексные ключи. */
function asObject<T>(v: unknown): Partial<T> {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Partial<T>) : {};
}
