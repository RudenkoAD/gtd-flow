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

/** Сегмент — структурный тег колонки доски ('#kanban/<board>/<col>'). */
function isColumnTagSegment(seg: Segment): boolean {
	return seg.tag && seg.text.startsWith("#kanban/");
}

/**
 * Убирает из текста описания структурные теги колонок '#kanban/...': на доске
 * колонка и так видна, а во входящих/календаре/тикле эти теги — визуальный шум.
 * Пробелы на шве вырезанного тега схлопываются, крайние обрезаются. В самом
 * файле теги остаются — правится ТОЛЬКО отображение. Без тегов колонок строка
 * возвращается как есть (идемпотентно, без лишней нормализации пробелов).
 */
export function stripColumnTags(text: string): string {
	const segments = segmentDescription(text);
	if (!segments.some(isColumnTagSegment)) return text;
	return segments
		.filter((seg) => !isColumnTagSegment(seg))
		.map((seg) => seg.text)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Сегменты описания для карточки: как segmentDescription, но без структурных
 * тегов колонок доски (stripColumnTags). Единая точка рендера текста карточки
 * во всех видах, использующих TaskCard (доска/входящие/тикль).
 */
export function displaySegments(text: string): Segment[] {
	return segmentDescription(stripColumnTags(text));
}

/** Базовое имя цели вики-ссылки: без пути, без ".md", без #заголовка/#^блока. */
export function wikiLinkBasename(target: string): string {
	const noSub = target.split("#")[0]!; // [[note#heading]] / [[note#^block]]
	const last = noSub.split("/").pop() ?? noSub;
	return last.replace(/\.md$/i, "").trim();
}

/**
 * Рендер вики-ссылок описания в плоский текст карточки:
 *   [[target|alias]] → alias, [[target]] → basename (без пути и .md).
 * Спец-случай: ссылка на собственную карточку-заметку — target или basename
 * начинается с taskId (файлы карточек именуются "<id> <текст>") — прячется
 * целиком: о существовании карточки уже сигналит бейдж прогресса n/m.
 * Незакрытые/пустые скобки остаются текстом как есть.
 */
export function renderWikiLinks(text: string, taskId: string | null): string {
	const re = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;
	let out = "";
	let from = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const target = m[1]!.trim();
		const alias = m[2]?.trim() ?? "";
		const base = wikiLinkBasename(target);
		const chunk = text.slice(from, m.index);
		const hidden =
			taskId !== null && taskId !== "" && (target.startsWith(taskId) || base.startsWith(taskId));
		if (hidden) {
			// схлопнуть двойной пробел на шве: «до [[ссылка]] после» → «до после»
			out +=
				/\s$/.test(chunk) && /^\s/.test(text.slice(re.lastIndex))
					? chunk.replace(/\s+$/, "")
					: chunk;
		} else {
			out += chunk + (alias !== "" ? alias : base);
		}
		from = re.lastIndex;
	}
	out += text.slice(from);
	return out.trim();
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
