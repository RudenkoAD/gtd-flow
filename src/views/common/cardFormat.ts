/**
 * Презентационные чистые функции TaskCard: сегментация описания на текст/теги
 * (подсветка #тегов до полноценного markdown-рендера) и словари иконок.
 */
import { isTagChar } from "../../core/parser/tokenizer";
import type { Priority, Task } from "../../core/model/Task";

export interface Segment {
	text: string;
	tag: boolean;
}

/**
 * Режет описание на чередующиеся сегменты plain/tag по правилам тегов Obsidian
 * (те же, что в extractTags: '#' не внутри слова, тело не только из цифр).
 * Инвариант: конкатенация сегментов == исходной строке.
 */
export function segmentDescription(text: string): Segment[] {
	const out: Segment[] = [];
	let plainFrom = 0;
	let i = 0;
	while (i < text.length) {
		if (text.charAt(i) !== "#") {
			i++;
			continue;
		}
		const prev = i > 0 ? text.charAt(i - 1) : "";
		if (prev === "#" || isTagChar(prev)) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < text.length && isTagChar(text.charAt(j))) j++;
		const body = text.slice(i + 1, j);
		if (body !== "" && /[^0-9]/.test(body)) {
			if (i > plainFrom) out.push({ text: text.slice(plainFrom, i), tag: false });
			out.push({ text: text.slice(i, j), tag: true });
			plainFrom = j;
			i = j;
		} else {
			i = j > i + 1 ? j : i + 1;
		}
	}
	if (plainFrom < text.length) out.push({ text: text.slice(plainFrom), tag: false });
	return out;
}

export const PRIORITY_ICONS: Record<Priority, string> = {
	highest: "🔺",
	high: "⏫",
	medium: "🔼",
	low: "🔽",
	lowest: "⏬",
	none: "",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
	highest: "🔺 наивысший",
	high: "⏫ высокий",
	medium: "🔼 средний",
	low: "🔽 низкий",
	lowest: "⏬ низший",
	none: "без приоритета",
};

/** Порядок пунктов меню «Приоритет»: 5 уровней + сброс. */
export const PRIORITY_ORDER: readonly Priority[] = [
	"highest",
	"high",
	"medium",
	"low",
	"lowest",
	"none",
];

export type BadgeField = "due" | "scheduled" | "start";

export interface DateBadge {
	icon: string;
	date: string;
	field: BadgeField;
}

export function dateBadges(t: Task): DateBadge[] {
	const out: DateBadge[] = [];
	if (t.due !== null) out.push({ icon: "📅", date: t.due, field: "due" });
	if (t.scheduled !== null) out.push({ icon: "⏳", date: t.scheduled, field: "scheduled" });
	if (t.start !== null) out.push({ icon: "🛫", date: t.start, field: "start" });
	return out;
}
