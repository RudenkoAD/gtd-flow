/**
 * Чистая логика компактного переключателя пространств (NamespaceSwitcher.svelte):
 * опции селектора и подпись пространства. Без obsidian/DOM — образец «логика рядом
 * с компонентом» (тестируется в node, см. namespaceSwitcher.test.ts).
 *
 * «Общее» — отображение встроенного пространства (sentinel DEFAULT_NS). По дизайну
 * отображение «Общего» — забота UI, а не ядра, поэтому подпись живёт здесь, а не в
 * core/namespace (ядро хранит только стабильный sentinel-идентификатор).
 */
import { ALL_NS, DEFAULT_NS, type NamespaceDef } from "../../core/namespace/namespace";

/** Отображаемое имя встроенного пространства «Общее» (sentinel DEFAULT_NS). */
export const DEFAULT_NS_LABEL = "Общее";

/** Отображаемое имя агрегата «Все пространства» (sentinel ALL_NS) — вкладка календаря. */
export const ALL_NS_LABEL = "Все";

/** Опция селектора пространств: значение <option> + подпись. */
export interface NamespaceOption {
	/** DEFAULT_NS для «Общего», ALL_NS для «Все», иначе имя пространства. */
	value: string;
	/** «Общее»/«Все» для sentinel'ов, иначе имя пространства. */
	label: string;
}

/**
 * Опции переключателя: «Общее» первым (встроенное пространство), затем именованные
 * в порядке настроек. При allowAll (только календарь) добавляется «Все» первой
 * опцией (агрегат всех пространств). При пустом defs — только «Общее» (сам компонент
 * при этом не рендерится: селектор виден лишь когда настроено ≥1 пространство,
 * поэтому «Все» без настроенных пространств не показывается).
 */
export function namespaceOptions(
	defs: readonly NamespaceDef[],
	allowAll = false,
): NamespaceOption[] {
	const opts: NamespaceOption[] = [];
	if (allowAll) opts.push({ value: ALL_NS, label: ALL_NS_LABEL });
	opts.push({ value: DEFAULT_NS, label: DEFAULT_NS_LABEL });
	for (const d of defs) opts.push({ value: d.name, label: d.name });
	return opts;
}

/** Подпись пространства по имени: «Общее» для DEFAULT_NS, «Все» для ALL_NS, иначе само имя. */
export function namespaceLabel(name: string): string {
	if (name === DEFAULT_NS) return DEFAULT_NS_LABEL;
	if (name === ALL_NS) return ALL_NS_LABEL;
	return name;
}
