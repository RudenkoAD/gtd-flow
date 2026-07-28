/**
 * Отображение аргумента `namespace` инструментов ↔ внутренние пространства ядра.
 *
 * Ядро использует sentinel'ы DEFAULT_NS/ALL_NS с ведущим NUL (недостижимы вводом);
 * агенту же удобно писать «Общее», «Все» или имя пространства. Здесь — единственная
 * точка перевода: имя из аргумента → NamespaceFilter, и обратно (метка для ответа).
 */
import {
	ALL_NS,
	DEFAULT_NS,
	resolveNamespace,
	type NamespaceDef,
	type NamespaceFilter,
} from "../core/namespace/namespace";
import { ALL_NAMESPACES_LABEL, COMMON_NAMESPACE_LABEL } from "../core/namespace/labels";
import type { GtdFlowSettings } from "../settings/Settings";

/** Отображаемое имя встроенного пространства «Общее» (всё вне корней). */
export const COMMON_LABEL = COMMON_NAMESPACE_LABEL;
/** Отображаемое имя агрегата «Все пространства». */
export const ALL_LABEL = ALL_NAMESPACES_LABEL;

/** Внутреннее активное имя пространства → человекочитаемая метка для ответов. */
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
 * Аргумент `namespace` → NamespaceFilter. undefined/пусто ⇒ активное пространство
 * настроек. Точное имя пользовательского пространства побеждает зарезервированные
 * слова (пространство «All» или «Default» остаётся достижимым); затем
 * «Все»/«all»/«*» ⇒ ALL_NS, «Общее»/«common»/«default» ⇒ DEFAULT_NS.
 * Неизвестное имя ⇒ ошибка со списком доступных.
 */
export function resolveNamespaceFilter(
	arg: string | undefined,
	settings: GtdFlowSettings,
): NamespaceFilter {
	const defs = settings.namespaces;
	if (arg === undefined || arg.trim() === "") {
		return { active: settings.activeNamespace, defs };
	}
	const a = arg.trim();
	// Пользовательские имена — первыми: иначе пространство, названное «All» или
	// «Default», было бы навсегда затенено зарезервированными словами ниже.
	if (defs.some((d) => d.name === a)) return { active: a, defs };
	const lower = a.toLowerCase();
	if (a === ALL_LABEL || lower === "all" || a === "*") return { active: ALL_NS, defs };
	if (a === COMMON_LABEL || lower === "common" || lower === "default") {
		return { active: DEFAULT_NS, defs };
	}
	const names = [COMMON_LABEL, ...defs.map((d) => d.name)].map((n) => `'${n}'`).join(", ");
	throw new Error(`unknown namespace '${a}'. Available: ${names} (or 'all')`);
}

/**
 * Как resolveNamespaceFilter, но для инструментов ЗАПИСИ (add_task/add_event):
 * агрегат «Все» не является местом записи (у него нет конкретного корня) —
 * отвергаем с внятной ошибкой.
 */
export function resolveWriteNamespace(
	arg: string | undefined,
	settings: GtdFlowSettings,
): NamespaceFilter {
	const filter = resolveNamespaceFilter(arg, settings);
	if (filter.active === ALL_NS) {
		throw new Error("namespace 'all' is not a write target — pick a concrete space or 'Общее'");
	}
	return filter;
}
