import { formatDuration } from "../../core/estimates/format";
import type {
	EstimateField,
	FieldProvenance,
	TaskEstimateProvenance,
} from "../../core/estimates/provenance";
import type { IntensityLevel, Task } from "../../core/model/Task";
import type { DurationLongStyle } from "../../settings/Settings";

/**
 * Русские описания уровней для ИНТЕРФЕЙСА. Английские INTENSITY_ANCHORS из ядра
 * остаются якорями ДЛЯ МОДЕЛИ (их дословно уносит промпт InboxProcessor), а
 * тултип на карточке и выпадающий список редактора видит каждый пользователь —
 * включая тех, кто AI не включал. Порядок и смысл уровней совпадают.
 */
export const INTENSITY_LABELS_RU: Record<
	"cognitive" | "emotional" | "physical",
	Record<IntensityLevel, string>
> = {
	cognitive: {
		0: "не применимо",
		1: "рутина, почти на автомате",
		2: "лёгкое внимание",
		3: "устойчивая концентрация",
		4: "сложные рассуждения",
		5: "предельная концентрация или новая задача",
	},
	emotional: {
		0: "не применимо",
		1: "эмоционально нейтрально",
		2: "лёгкий дискомфорт",
		3: "заметное эмоциональное усилие",
		4: "сильное сопротивление или уязвимость",
		5: "исключительно тяжёлая эмоциональная нагрузка",
	},
	physical: {
		0: "не применимо",
		1: "почти без физических усилий",
		2: "лёгкая физическая активность",
		3: "умеренная длительная нагрузка",
		4: "тяжёлая физическая работа",
		5: "предельная безопасная нагрузка",
	},
};

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
			title: `Общая длительность: ${duration}. ${ownershipText(provenance?.fields.duration)}`,
		});
	}
	for (const [field, icon, name, value] of [
		["cognitive", "🧠", "Когнитивная нагрузка", task.cognitiveIntensity],
		["emotional", "💓", "Эмоциональная нагрузка", task.emotionalIntensity],
		["physical", "💪", "Физическая нагрузка", task.physicalIntensity],
	] as const) {
		if (value === null) continue;
		out.push({
			field,
			label: `${icon} ${value}`,
			title: `${name}: ${value}/5 — ${INTENSITY_LABELS_RU[field][value]}. ${ownershipText(provenance?.fields[field])}`,
		});
	}
	if (task.scopeId !== null) {
		const name = port?.scopeName(task.scopeId) ?? task.scopeId;
		out.push({
			field: "scope",
			label: `🧭 ${name}`,
			// «scope» намеренно не переводим: «пространство» в этом плагине —
			// ЛЕГАСИ-понятие (мастер миграции пространств в scope)
			title: `Scope: ${name}${name === task.scopeId ? "" : ` (${task.scopeId})`}. ${ownershipText(provenance?.fields.scope)}`,
		});
	}
	return out;
}

export function displayDuration(minutes: number, longStyle: DurationLongStyle | null): string {
	return formatDuration(minutes, longStyle ?? "whole-days");
}

export function ownershipText(state: FieldProvenance | undefined): string {
	if (state === undefined) return "Владелец значения неизвестен.";
	if (state.owner === "user" || state.locked) return "Изменено вами: AI не перезапишет.";
	return "Предложено AI: можно пересчитать вручную.";
}
