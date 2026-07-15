/**
 * Статусы дней и покраска календаря (фича «красить дни по статусам»).
 *
 * Источник — один markdown-файл с флагом `gtd-day-status: true`:
 *   - frontmatter `statuses: { имя: "#цвет", … }` — определения статусов;
 *   - тело — назначения `<спец>: <имя статуса>`, по одному на строку, где спец:
 *       • одиночная дата     `2026-07-20`
 *       • диапазон           `2026-08-01..2026-08-10`
 *       • правило повторения `every saturday,sunday` (грамматика core/recurrence).
 *
 * Разделитель — ПОСЛЕДНЕЕ двоеточие строки (имя статуса двоеточий не содержит),
 * поэтому времена внутри правил («at 19:00») не ломают разбор. Побеждает ПОСЛЕДНЕЕ
 * подходящее назначение с определённым цветом — так одиночная дата переопределяет
 * повторяющееся правило, стоящее выше. Чистый модуль: ноль obsidian/DOM.
 */
import type { IsoDate } from "../model/Task";
import { compare, isValidIsoDate } from "../recurrence/dateMath";
import { isParseError, parseRule, type Rule } from "../recurrence/grammar";
import { expandOccurrences } from "../recurrence/occurrences";

export type DayAssignment =
	| { kind: "single"; date: IsoDate; status: string }
	| { kind: "range"; from: IsoDate; to: IsoDate; status: string }
	| { kind: "recurring"; rule: Rule; status: string };

export interface DayStatusModel {
	/** Имя статуса → цвет (валидированный непустой); порядок = порядок объявления. */
	defs: Map<string, string>;
	/** Назначения в порядке файла (позже — приоритетнее при разрешении даты). */
	assignments: DayAssignment[];
}

export const EMPTY_DAY_STATUS_MODEL: DayStatusModel = { defs: new Map(), assignments: [] };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/**
 * Определения статусов из значения frontmatter `statuses` (объект имя→цвет).
 * Пустые имена/не-строковые/пустые цвета отбрасываются; первое объявление имени
 * выигрывает. Любое не-object значение → пустая карта.
 */
export function normalizeStatusDefs(raw: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [name, color] of Object.entries(raw as Record<string, unknown>)) {
		const n = name.trim();
		if (n === "" || typeof color !== "string") continue;
		const c = color.trim();
		if (c === "" || out.has(n)) continue;
		out.set(n, c);
	}
	return out;
}

/** Разбор одной строки-назначения; null — пустая/заголовок/не распознано. */
export function parseAssignmentLine(line: string): DayAssignment | null {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return null;
	// последнее двоеточие — разделитель (имя статуса двоеточий не содержит,
	// а «at 19:00» внутри правила стоит раньше)
	const sep = trimmed.lastIndexOf(":");
	if (sep === -1) return null;
	const spec = trimmed.slice(0, sep).trim();
	const status = trimmed.slice(sep + 1).trim();
	if (spec === "" || status === "") return null;

	const range = RANGE_RE.exec(spec);
	if (range !== null) {
		let from = range[1]!;
		let to = range[2]!;
		if (!isValidIsoDate(from) || !isValidIsoDate(to)) return null;
		if (compare(from, to) > 0) [from, to] = [to, from];
		return { kind: "range", from, to, status };
	}
	if (ISO_RE.test(spec)) {
		if (!isValidIsoDate(spec)) return null;
		return { kind: "single", date: spec, status };
	}
	const rule = parseRule(spec);
	if (isParseError(rule)) return null;
	return { kind: "recurring", rule, status };
}

/** Разбор всех строк тела в список назначений (порядок сохранён). */
export function parseAssignments(body: string): DayAssignment[] {
	const out: DayAssignment[] = [];
	for (const line of body.split(/\r?\n/)) {
		const a = parseAssignmentLine(line);
		if (a !== null) out.push(a);
	}
	return out;
}

/** Собрать модель из значения frontmatter.statuses и тела файла. */
export function buildDayStatusModel(rawStatuses: unknown, body: string): DayStatusModel {
	return { defs: normalizeStatusDefs(rawStatuses), assignments: parseAssignments(body) };
}

function assignmentMatches(a: DayAssignment, date: IsoDate): boolean {
	switch (a.kind) {
		case "single":
			return a.date === date;
		case "range":
			return compare(a.from, date) <= 0 && compare(date, a.to) <= 0;
		case "recurring":
			return expandOccurrences(a.rule, date, date, 1).length > 0;
	}
}

/**
 * Статус и цвет дня: последнее подходящее назначение с ОПРЕДЕЛЁННЫМ цветом
 * (позже в файле = приоритетнее). null — день не покрашен.
 */
export function statusForDate(
	model: DayStatusModel,
	date: IsoDate,
): { name: string; color: string } | null {
	for (let i = model.assignments.length - 1; i >= 0; i--) {
		const a = model.assignments[i]!;
		if (!assignmentMatches(a, date)) continue;
		const color = model.defs.get(a.status);
		if (color === undefined) continue;
		return { name: a.status, color };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Writeback: правка ТЕЛА файла (frontmatter не трогаем)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Применить edit к телу файла, сохранив блок frontmatter как есть. */
export function withEditedBody(content: string, edit: (body: string) => string): string {
	const m = FRONTMATTER_RE.exec(content);
	const head = m !== null ? m[0] : "";
	const body = m !== null ? content.slice(m[0].length) : content;
	const nextBody = edit(body);
	const sep = head === "" || head.endsWith("\n") ? "" : "\n";
	return head + sep + nextBody;
}

/** Append строки в тело: ровно один перевод строки в конце. */
function appendBodyLine(body: string, line: string): string {
	const trimmed = body.replace(/\s+$/, "");
	return trimmed === "" ? line + "\n" : `${trimmed}\n${line}\n`;
}

/** Убрать одиночные назначения ровно на дату (перекраска/сброс дня). */
export function removeSingleForDate(body: string, date: IsoDate): string {
	return body
		.split(/\r?\n/)
		.filter((line) => {
			const a = parseAssignmentLine(line);
			return !(a !== null && a.kind === "single" && a.date === date);
		})
		.join("\n");
}

/** Тело после покраски одного дня: снять прежнюю одиночную метку даты и дописать новую. */
export function setSingleDayBody(body: string, date: IsoDate, status: string): string {
	return appendBodyLine(removeSingleForDate(body, date), `${date}: ${status}`);
}

/** Тело после сброса статуса дня (снимает только одиночную метку этой даты). */
export function clearSingleDayBody(body: string, date: IsoDate): string {
	const cleaned = removeSingleForDate(body, date);
	return cleaned.replace(/\s+$/, "") === "" ? "" : cleaned.replace(/\s+$/, "") + "\n";
}

/** Тело после покраски диапазона (from..to дописывается новой строкой). */
export function setRangeBody(body: string, from: IsoDate, to: IsoDate, status: string): string {
	const [a, b] = compare(from, to) > 0 ? [to, from] : [from, to];
	return appendBodyLine(body, `${a}..${b}: ${status}`);
}
