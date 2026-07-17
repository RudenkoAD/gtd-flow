/**
 * parseTaskLine — строка + контекст файла → Task (ТЗ §2 parser).
 *
 * Семантика полей:
 * - Дубли одного поля: побеждает ПОСЛЕДНЕЕ вхождение (rawLine хранит все).
 * - Офсеты ±Nd (легальны только в шаблонах, ТЗ §6) в due/start/... НЕ попадают —
 *   поле остаётся null, офсет живёт в rawLine и разворачивается движком повторов.
 * - Невалидный payload даты тоже даёт null (но токен уже вырезан из description).
 * - У 📅/⏳/🛫 payload может нести время «HH:mm» после даты → dueTime/scheduledTime/
 *   startTime и конец интервала «-HH:mm» сразу за ним → dueTimeEnd/scheduledTimeEnd/
 *   startTimeEnd; невалидное время (и невалидный/не больший конец) в payload не
 *   попадает (токенизатор оставляет его тексту), поэтому дата при этом парсится
 *   штатно, время/конец = null.
 * - description: текст без токенов полей, схлопнутые пробелы, trim; теги ОСТАЮТСЯ
 *   в description и дополнительно собираются в tags[] (с '#', без дублей).
 */
import type { ContainerKind, DateOffset, IsoDate, Priority, Task } from "../model/Task";
import { EMOJI_TO_PRIORITY, type DateFieldName } from "./emoji";
import {
	extractTags,
	isTimedDateField,
	tokenizeTaskLine,
	TIME_RE,
	type TimedDateFieldName,
} from "./tokenizer";
import { computeKey } from "./taskKey";

export interface ParseContext {
	filePath: string;
	lineStart: number;
	parentLine: number | null;
	heading: string | null;
	container: ContainerKind;
	projectActive: boolean;
	/** Сырой frontmatter gtd-namespace файла (override пространства). Опционально:
	 *  отсутствие ⇒ Task.nsOverride = null. Индексатор прокидывает сюда
	 *  snap.context.nsOverride; синтетические парсы (write-back) его не задают. */
	nsOverride?: string | null;
}

export type DatePayload =
	| { kind: "date"; date: IsoDate }
	| { kind: "offset"; offset: DateOffset }
	| { kind: "empty" }
	| { kind: "invalid"; raw: string };

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_RE = /^([+-])(\d{1,3})d$/;

/** Дней в месяце (григорианский календарь). Дублирует recurrence/dateMath
 *  сознательно: parser не зависит от recurrence (dateMath — приватная утилита
 *  движка повторов), а логика тривиальна и зафиксирована тестами. */
function daysInMonth(y: number, m: number): number {
	if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Классификация payload поля-даты: дата / офсет ±Nd / мусор.
 *  Валидация календарная (2026-02-30 → invalid). Это ЕДИНЫЙ гейт для чтения
 *  и записи: setField валидирует этим же предикатом, поэтому «записали, а
 *  прочиталось null» невозможно по построению. */
export function parseDatePayload(payload: string): DatePayload {
	if (payload === "") return { kind: "empty" };
	const d = ISO_DATE_RE.exec(payload);
	if (d !== null) {
		const year = Number(d[1]);
		const month = Number(d[2]);
		const day = Number(d[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month))
			return { kind: "date", date: payload };
		return { kind: "invalid", raw: payload };
	}
	const o = OFFSET_RE.exec(payload);
	if (o !== null) {
		return { kind: "offset", offset: { sign: o[1] === "-" ? -1 : 1, days: Number(o[2]) } };
	}
	return { kind: "invalid", raw: payload };
}

/** Отщепить опциональное время «HH:mm[-HH:mm]» от payload дата-поля 📅/⏳/🛫.
 *  Токенизатор кладёт время (и конец интервала) в payload только валидным, но
 *  здесь перепроверяем тем же TIME_RE — функция обязана быть корректной на
 *  произвольной строке (её использует и setField для «сохранить существующее
 *  время»). Мусорный хвост ⇒ весь payload считается datePart (и не пройдёт
 *  parseDatePayload) — как и раньше для невалидного времени. */
export function splitDateTimePayload(payload: string): {
	datePart: string;
	time: string | null;
	timeEnd: string | null;
} {
	const m = /^(\S+)\s+(\S+)$/.exec(payload);
	if (m !== null) {
		const tok = m[2]!;
		if (TIME_RE.test(tok)) return { datePart: m[1]!, time: tok, timeEnd: null };
		// интервал «14:30-16:00»: «HH:mm» — ровно 5 символов, дефис без пробелов;
		// конец обязан быть валидным и СТРОГО позже начала (лексикографика == хронология)
		const startPart = tok.slice(0, 5);
		const endPart = tok.slice(6);
		if (
			tok.charAt(5) === "-" &&
			TIME_RE.test(startPart) &&
			TIME_RE.test(endPart) &&
			endPart > startPart
		) {
			return { datePart: m[1]!, time: startPart, timeEnd: endPart };
		}
	}
	return { datePart: payload, time: null, timeEnd: null };
}

/**
 * Разобрать payload поля-списка 🚫 в даты-исключения: split по запятой, trim,
 * оставить ТОЛЬКО валидные ISO-даты (тем же parseDatePayload, что и остальные
 * даты). Невалидные элементы молча выпадают — но живут в rawLine (лослесс).
 * Порядок сохраняется (сортировку/дедуп делает сериализатор при записи).
 */
export function parseExcludedDates(payload: string): IsoDate[] {
	const out: IsoDate[] = [];
	for (const part of payload.split(",")) {
		const s = part.trim();
		if (s === "") continue;
		if (parseDatePayload(s).kind === "date") out.push(s);
	}
	return out;
}

/** U+FE0F не участвует в таблицах эмодзи — срезаем перед поиском приоритета. */
function stripVariationSelector(emoji: string): string {
	let out = "";
	for (let i = 0; i < emoji.length; i++) {
		if (emoji.charCodeAt(i) !== 0xfe0f) out += emoji.charAt(i);
	}
	return out;
}

export function parseTaskLine(rawLine: string, ctx: ParseContext): Task | null {
	// 📍-место распознаём как поле ТОЛЬКО в файлах-событиях (container "events").
	// В обычных задачах 📍 — часть текста: иначе рукописный 📍 съел бы #теги и
	// хвост описания после него (потеря членства в доске/#waiting и content-key).
	const tok = tokenizeTaskLine(rawLine, { location: ctx.container === "events" });
	if (tok === null) return null;

	const dates: Record<DateFieldName, IsoDate | null> = {
		due: null,
		scheduled: null,
		start: null,
		created: null,
		done: null,
		cancelled: null,
		nextSpawn: null,
	};
	// время только у 📅/⏳/🛫; при дублях поля — как и дата — побеждает последнее
	const times: Record<TimedDateFieldName, string | null> = {
		due: null,
		scheduled: null,
		start: null,
	};
	const timeEnds: Record<TimedDateFieldName, string | null> = {
		due: null,
		scheduled: null,
		start: null,
	};
	let recurrence: string | null = null;
	let taskId: string | null = null;
	let spawnedFrom: string | null = null;
	let dependsOn: string[] = [];
	let excludedDates: IsoDate[] = [];
	let location: string | null = null;
	let priority: Priority = "none";
	const textParts: string[] = [];
	const tags: string[] = [];

	for (const seg of tok.segments) {
		if (seg.kind === "text") {
			textParts.push(seg.text);
			// теги ищем по-сегментно: границы тегов не должны «склеиваться» через поля
			for (const t of extractTags(seg.text)) if (!tags.includes(t)) tags.push(t);
			continue;
		}
		switch (seg.field) {
			case "priority": {
				const p = EMOJI_TO_PRIORITY.get(stripVariationSelector(seg.emoji));
				if (p !== undefined) priority = p;
				break;
			}
			case "recurrence": {
				const rule = seg.payload.trim();
				recurrence = rule === "" ? null : rule;
				break;
			}
			case "id": {
				taskId = seg.payload === "" ? null : seg.payload;
				break;
			}
			case "spawnedFrom": {
				spawnedFrom = seg.payload === "" ? null : seg.payload;
				break;
			}
			case "dependsOn": {
				dependsOn = seg.payload
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s !== "");
				break;
			}
			case "excludedDates": {
				// невалидные даты в списке игнорируются (остаются в rawLine)
				excludedDates = parseExcludedDates(seg.payload);
				break;
			}
			case "location": {
				// 📍 — свободный текст места; пустой (после trim) payload = нет поля
				const loc = seg.payload.trim();
				location = loc === "" ? null : loc;
				break;
			}
			default: {
				if (isTimedDateField(seg.field)) {
					const { datePart, time, timeEnd } = splitDateTimePayload(seg.payload);
					const parsed = parseDatePayload(datePart);
					const ok = parsed.kind === "date";
					dates[seg.field] = ok ? parsed.date : null;
					times[seg.field] = ok ? time : null;
					timeEnds[seg.field] = ok ? timeEnd : null;
				} else {
					const parsed = parseDatePayload(seg.payload);
					dates[seg.field] = parsed.kind === "date" ? parsed.date : null;
				}
			}
		}
	}

	const description = textParts.join("").replace(/\s+/g, " ").trim();

	return {
		// occurrenceIndex здесь всегда 0 — дизамбигуацию одинаковых строк
		// в одном файле делает индексатор, пересчитывая key через computeKey
		key: computeKey({ taskId, filePath: ctx.filePath, description }, 0),
		taskId,
		filePath: ctx.filePath,
		lineStart: ctx.lineStart,
		lineEnd: ctx.lineStart,
		parentLine: ctx.parentLine,
		heading: ctx.heading,
		description,
		rawLine,
		statusChar: tok.statusChar,
		due: dates.due,
		scheduled: dates.scheduled,
		start: dates.start,
		created: dates.created,
		done: dates.done,
		cancelled: dates.cancelled,
		dueTime: times.due,
		scheduledTime: times.scheduled,
		startTime: times.start,
		dueTimeEnd: timeEnds.due,
		scheduledTimeEnd: timeEnds.scheduled,
		startTimeEnd: timeEnds.start,
		recurrence,
		nextSpawn: dates.nextSpawn,
		spawnedFrom,
		priority,
		dependsOn,
		excludedDates,
		location,
		tags,
		container: ctx.container,
		projectActive: ctx.projectActive,
		nsOverride: ctx.nsOverride ?? null,
	};
}
