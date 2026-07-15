/**
 * Таблица эмодзи ↔ поле (ТЗ §0, «Зафиксированные решения»).
 * Формат совместим со строками Obsidian Tasks; 🔜 и 🧬 — собственные поля GTD Flow.
 */
import type { Priority } from "../model/Task";

/** Поля-даты: эмодзи + следом YYYY-MM-DD (в шаблонах — офсет ±Nd). */
export const DATE_FIELD_EMOJI = {
	due: "📅",
	scheduled: "⏳",
	start: "🛫",
	created: "➕",
	done: "✅",
	cancelled: "❌",
	nextSpawn: "🔜",
} as const;

export type DateFieldName = keyof typeof DATE_FIELD_EMOJI;

/** Поля-значения: эмодзи + произвольный токен/текст. */
export const VALUE_FIELD_EMOJI = {
	recurrence: "🔁", // текст правила до следующего поля
	id: "🆔", // один токен
	dependsOn: "⛔", // список id через запятую без пробелов
	spawnedFrom: "🧬", // один токен
	excludedDates: "🚫", // список дат-исключений вхождений серии через запятую без пробелов
} as const;

export type ValueFieldName = keyof typeof VALUE_FIELD_EMOJI;

export const PRIORITY_EMOJI: Record<Exclude<Priority, "none">, string> = {
	highest: "🔺",
	high: "⏫",
	medium: "🔼",
	low: "🔽",
	lowest: "⏬",
};

export const EMOJI_TO_PRIORITY: ReadonlyMap<string, Priority> = new Map(
	(Object.entries(PRIORITY_EMOJI) as [Priority, string][]).map(([p, e]) => [e, p]),
);

/** Все эмодзи, начинающие поле, — для токенизатора (граница «описание | поля»). */
export const ALL_FIELD_EMOJI: readonly string[] = [
	...Object.values(DATE_FIELD_EMOJI),
	...Object.values(VALUE_FIELD_EMOJI),
	...Object.values(PRIORITY_EMOJI),
];
