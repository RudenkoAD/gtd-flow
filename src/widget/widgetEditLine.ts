/**
 * buildEditedLine — СИНХРОННАЯ правка одной строки задачи/события для «шторки
 * деталей» Android-виджета. Возвращает JSON-строку результата:
 *   {ok:true, line:string} | {ok:false, error:string}.
 *
 * Семантика по ВИДУ строки (определяется структурно из самой строки):
 *  • задача / одноразовое событие / ПОВТОРЯЮЩАЯСЯ задача (нет 🔁 ЛИБО есть 🔁 вместе
 *    с полем-датой 📅/⏳/🛫): title→setDescription; дата→ПЕРВОЕ имеющееся поле из
 *    📅/⏳/🛫 (или 📅, если дат нет); время — хвост той же даты; место→📍. У
 *    одноразового события дата всегда 📅, поэтому «первое имеющееся» совпадает с 📅.
 *    У повторяющейся задачи (стиль Obsidian Tasks: `🔁 every … 📅 <дата>`) расписание
 *    несёт поле-дата, а 🔁 — лишь маркер повтора; правим дату/время В ПОЛЕ, правило
 *    🔁 не трогаем (computeWidgetData такую строку размещает placeEvents и отдаёт как
 *    itemKind='task' — этот путь согласован с тем, как виджет её показывает).
 *  • серия-СОБЫТИЕ (есть 🔁, но НЕТ поля-даты 📅/⏳/🛫 — расписание задаёт само правило):
 *    title→setDescription; место→📍; время — хвост «at HH:mm[-HH:mm]» ВНУТРИ правила
 *    🔁; правка даты серии запрещена (перенос вхождения — отдельная операция) →
 *    {ok:false,'series-date-not-editable'}.
 *
 * Реализация строго поверх ЧИСТЫХ хелперов ядра (serializeTaskLine: setDescription/
 * setField/setValueField; tokenizer; recurrence/grammar). Из src/views и src/services
 * НЕ импортируем (контракт зоны движка): мелкие текстовые хелперы ПРОДУБЛИРОВАНЫ здесь
 * минимально, с указанием исходников-образцов:
 *   • отщепление хвоста «at …» правила  — образец src/views/calendar/eventSeries.ts
 *     (splitEventRule); правка payload 🔁 — там же (setRecurrencePayload);
 *   • разбор диапазона времени «HH:mm[-HH:mm]» — образец
 *     src/views/calendar/calendarLogic.ts (parseTimeRange), но конец ОБЯЗАН быть
 *     строго позже начала (правило 'at' и запись на диск требуют этого).
 */
import type { IsoDate } from "../core/model/Task";
import {
	setDescription,
	setField,
	setValueField,
} from "../core/parser/serializeTaskLine";
import {
	serializeTokens,
	TIME_RE,
	tokenizeTaskLine,
	type FieldName,
	type FieldToken,
	type TokenizedTaskLine,
} from "../core/parser/tokenizer";
import { isParseError, parseRule } from "../core/recurrence/grammar";

/** Правки шторки; каждое поле опционально — присутствие ключа = «применить». */
export interface LineEdits {
	/** Новый заголовок (описание). Пустой после схлопывания пробелов — ошибка. */
	title?: string;
	/** 'YYYY-MM-DD' — установить дату; null — снять поле-дату. */
	date?: string | null;
	/** 'HH:mm' | 'HH:mm-HH:mm' — установить время; null — снять время. */
	timeRange?: string | null;
	/** Место 📍; null/пустая строка — снять поле. */
	location?: string | null;
}

type EditOk = { ok: true; line: string };
type EditErr = { ok: false; error: string };
type EditResult = EditOk | EditErr;

const ISO_DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Приоритет целевого поля-даты (§4 UI шторки): 📅 → ⏳ → 🛫. */
const DATE_FIELD_ORDER = ["due", "scheduled", "start"] as const;
type TargetDateField = (typeof DATE_FIELD_ORDER)[number];

function err(code: string): EditErr {
	return { ok: false, error: code };
}

function hasField(t: TokenizedTaskLine, field: FieldName): boolean {
	return t.segments.some((s) => s.kind === "field" && s.field === field);
}

/** ПЕРВОЕ имеющееся из 📅/⏳/🛫 (порядок due→scheduled→start), либо null. */
function firstDateField(t: TokenizedTaskLine): TargetDateField | null {
	for (const f of DATE_FIELD_ORDER) if (hasField(t, f)) return f;
	return null;
}

/** ISO-дата ПОСЛЕДНЕГО токена поля (его видит парсер, «последний побеждает»), либо null. */
function fieldDate(t: TokenizedTaskLine, field: FieldName): IsoDate | null {
	let payload: string | null = null;
	for (const s of t.segments) if (s.kind === "field" && s.field === field) payload = s.payload;
	if (payload === null) return null;
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(payload);
	return m ? m[1]! : null;
}

/** ПОСЛЕДНИЙ токен 🔁 (его видит парсер), либо null. */
function recurrenceToken(t: TokenizedTaskLine): FieldToken | null {
	let tok: FieldToken | null = null;
	for (const s of t.segments) if (s.kind === "field" && s.field === "recurrence") tok = s;
	return tok;
}

/**
 * Отщепить хвост «at HH:mm[-HH:mm]» правила серии (образец splitEventRule): хвост
 * стоит в конце правила (joinEventRule/withSeriesAnchor дописывают 'at' последним).
 * Нет хвоста — правило возвращается как есть.
 */
function stripAtTail(ruleText: string): string {
	const m = /^(.*?)\s+at\s+\S+\s*$/i.exec(ruleText.trim());
	return m && m[1] !== undefined ? m[1].trim() : ruleText.trim();
}

/**
 * Разбор диапазона времени: 'HH:mm' → только начало; 'HH:mm-HH:mm' → начало+конец.
 * Пусто/битое/конец ≤ начала → null (конец строго позже начала: правило 'at' и
 * запись на диск требуют этого — вырожденный конец отклоняем сразу). Лексикографика
 * "HH:mm" == хронология.
 */
function parseTimeRange(input: string): { time: string; timeEnd: string | null } | null {
	const s = input.trim();
	if (s === "") return null;
	const dash = s.indexOf("-");
	if (dash === -1) return TIME_RE.test(s) ? { time: s, timeEnd: null } : null;
	const a = s.slice(0, dash).trim();
	const b = s.slice(dash + 1).trim();
	if (!TIME_RE.test(a) || !TIME_RE.test(b) || b <= a) return null;
	return { time: a, timeEnd: b };
}

/**
 * Правка времени серии: заменить/снять хвост «at …» ВНУТРИ payload ПОСЛЕДНЕГО 🔁.
 * timeRange === null снимает время; строка ставит/меняет. Итоговое правило
 * валидируется тем же parseRule, что и календарь (ловит «duplicate 'at'» на
 * нестандартном порядке клауз, битый диапазон и т.п.).
 */
function applySeriesTime(line: string, timeRange: string | null): EditResult {
	const t = tokenizeTaskLine(line);
	if (t === null) return err("not-a-task");
	const tok = recurrenceToken(t);
	if (tok === null) return err("not-a-series");
	const base = stripAtTail(tok.payload);
	let newRule: string;
	if (timeRange === null) {
		newRule = base;
	} else {
		if (typeof timeRange !== "string") return err("invalid-time-range");
		const pr = parseTimeRange(timeRange);
		if (pr === null) return err("invalid-time-range");
		const tail = pr.timeEnd !== null ? `${pr.time}-${pr.timeEnd}` : pr.time;
		newRule = `${base} at ${tail}`;
	}
	const parsed = parseRule(newRule);
	if (isParseError(parsed)) return err("invalid-rule");
	// серия-СОБЫТИЕ с «every!» невозможна (событие не «выполняется», §every!):
	// такая строка не должна создаваться, но если попала руками — правку отклоняем
	if (parsed.fromCompletion) return err("series-completion-not-allowed");
	// голый 🔁 без payload — дописать разделитель перед новым правилом
	if (tok.gap === "" && tok.payload === "") tok.gap = " ";
	tok.payload = newRule;
	return { ok: true, line: serializeTokens(t) };
}

/**
 * Правка даты/времени задачи или одноразового события: цель — ПЕРВОЕ имеющееся поле
 * из 📅/⏳/🛫 (или 📅, если дат нет). dateEdit: undefined — сохранить текущую дату,
 * null — снять поле, строка — установить. timeEdit: undefined — сохранить время,
 * null — снять, строка — установить (разбор parseTimeRange).
 */
function applyDateTime(
	line: string,
	dateEdit: string | null | undefined,
	timeEdit: string | null | undefined,
): EditResult {
	const t = tokenizeTaskLine(line);
	if (t === null) return err("not-a-task");
	const field = firstDateField(t) ?? "due";
	const existingDate = fieldDate(t, field);

	// целевая дата
	let newDate: IsoDate | null;
	if (dateEdit === undefined) newDate = existingDate;
	else if (dateEdit === null) newDate = null;
	else {
		if (typeof dateEdit !== "string" || !ISO_DATE_SHAPE_RE.test(dateEdit)) return err("invalid-date");
		newDate = dateEdit;
	}

	// время: undefined сохранить, null снять, строка разобрать
	let timeArg: string | null | undefined;
	let timeEndArg: string | null | undefined;
	if (timeEdit === undefined) {
		timeArg = undefined;
		timeEndArg = undefined;
	} else if (timeEdit === null) {
		timeArg = null;
		timeEndArg = null;
	} else {
		if (typeof timeEdit !== "string") return err("invalid-time-range");
		const pr = parseTimeRange(timeEdit);
		if (pr === null) return err("invalid-time-range");
		timeArg = pr.time;
		timeEndArg = pr.timeEnd;
	}

	// время без даты недопустимо (setField бы бросил): чистый код вместо исключения
	if (newDate === null && typeof timeArg === "string") return err("time-without-date");

	try {
		return { ok: true, line: setField(line, field, newDate, timeArg, timeEndArg) };
	} catch {
		// сюда попадаем на календарно-битой дате (2026-02-30): shape прошла, parseDatePayload нет
		return err("invalid-date");
	}
}

/** Внутренняя реализация: собирает EditResult; buildEditedLine сериализует его в JSON. */
function editLine(rawLine: unknown, editsRaw: unknown): EditResult {
	if (typeof rawLine !== "string") return err("not-a-task");
	const t0 = tokenizeTaskLine(rawLine);
	if (t0 === null) return err("not-a-task");
	const edits: LineEdits =
		editsRaw !== null && typeof editsRaw === "object" ? (editsRaw as LineEdits) : {};
	// «Серия-событие» = 🔁 БЕЗ явного поля-даты (расписание задаёт само правило).
	// Строка с 🔁 И полем 📅/⏳/🛫 — повторяющаяся ЗАДАЧА (Obsidian Tasks): дату несёт
	// поле, а не правило, поэтому она правится как обычная задача (applyDateTime),
	// а 🔁 остаётся нетронутым. Это выравнивает классификацию с computeWidgetData,
	// которая размещает такую строку через placeEvents и отдаёт itemKind='task' —
	// иначе шторка показывает элемент задачей, а движок отвергает ЛЮБУЮ правку.
	const isSeries = hasField(t0, "recurrence") && firstDateField(t0) === null;

	// дату серии не двигаем (перенос вхождения — отдельная операция) — ранний отказ
	if (isSeries && edits.date !== undefined) return err("series-date-not-editable");

	let line = rawLine;

	// title → setDescription (пустой запрещён; эмодзи поля запрещены; ведущий 📍 допустим)
	if (edits.title !== undefined) {
		if (typeof edits.title !== "string") return err("invalid-title");
		const canon = edits.title.replace(/\s+/g, " ").trim();
		if (canon === "") return err("empty-title");
		try {
			line = setDescription(line, canon);
		} catch {
			return err("invalid-title");
		}
	}

	// location → setValueField (null/'' снимает; эмодзи поля запрещены)
	if (edits.location !== undefined) {
		if (edits.location !== null && typeof edits.location !== "string") {
			return err("invalid-location");
		}
		const loc = edits.location === null ? "" : edits.location.trim();
		try {
			line = setValueField(line, "location", loc === "" ? null : loc);
		} catch {
			return err("invalid-location");
		}
	}

	if (isSeries) {
		if (edits.timeRange !== undefined) {
			const r = applySeriesTime(line, edits.timeRange);
			if (!r.ok) return r;
			line = r.line;
		}
	} else if (edits.date !== undefined || edits.timeRange !== undefined) {
		const r = applyDateTime(line, edits.date, edits.timeRange);
		if (!r.ok) return r;
		line = r.line;
	}

	return { ok: true, line };
}

/**
 * Публичный синхронный экспорт бандла (звать как GtdWidgetCore.buildEditedLine).
 * Аргументы приходят из внешнего движка — не гарантированы; результат ВСЕГДА
 * валидная JSON-строка {ok:true,line} | {ok:false,error} (исключения не пробрасываем).
 */
export function buildEditedLine(rawLine: string, edits: LineEdits): string {
	try {
		return JSON.stringify(editLine(rawLine, edits));
	} catch (e) {
		return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
}
