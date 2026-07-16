/**
 * Чистая логика компактного переключателя пространств (NamespaceSwitcher.svelte):
 * опции селектора и подпись пространства. Без obsidian/DOM — образец «логика рядом
 * с компонентом» (тестируется в node, см. namespaceSwitcher.test.ts).
 *
 * «Общее» — отображение встроенного пространства (sentinel DEFAULT_NS). По дизайну
 * отображение «Общего» — забота UI, а не ядра, поэтому подпись живёт здесь, а не в
 * core/namespace (ядро хранит только стабильный sentinel-идентификатор).
 */
import { DEFAULT_NS, type NamespaceDef } from "../../core/namespace/namespace";

/** Отображаемое имя встроенного пространства «Общее» (sentinel DEFAULT_NS). */
export const DEFAULT_NS_LABEL = "Общее";

/** Опция селектора пространств: значение <option> + подпись. */
export interface NamespaceOption {
	/** DEFAULT_NS для «Общего», иначе имя пространства (оно же — идентификатор). */
	value: string;
	/** «Общее» для DEFAULT_NS, иначе имя пространства. */
	label: string;
}

/**
 * Опции переключателя: «Общее» первым (встроенное пространство), затем именованные
 * в порядке настроек. При пустом defs — только «Общее» (сам компонент при этом не
 * рендерится: селектор виден лишь когда настроено ≥1 пространство).
 */
export function namespaceOptions(defs: readonly NamespaceDef[]): NamespaceOption[] {
	const opts: NamespaceOption[] = [{ value: DEFAULT_NS, label: DEFAULT_NS_LABEL }];
	for (const d of defs) opts.push({ value: d.name, label: d.name });
	return opts;
}

/** Подпись активного пространства по имени: «Общее» для DEFAULT_NS, иначе само имя. */
export function namespaceLabel(name: string): string {
	return name === DEFAULT_NS ? DEFAULT_NS_LABEL : name;
}
