/**
 * Токенизатор строки задачи (ТЗ §2 parser).
 *
 * Разбирает сырую строку на: отступ, маркер списка, статус в [ ] и
 * последовательность сегментов — простой текст и эмодзи-поля.
 * Каждый фрагмент хранится дословно: serializeTokens(tokenizeTaskLine(x)) === x
 * для любой строки-задачи (линчпин write-back без потерь, ТЗ §3, §12.1).
 *
 * Пробельные решения (задокументированный выбор):
 * - Разделителем полей считается любой символ класса \s, включая NBSP (U+00A0):
 *   строки, где поля разделены неразрывными пробелами (частый артефакт мобильных
 *   клавиатур), парсятся штатно, а исходные символы сохраняются дословно в gap.
 * - Отступ и пробел после маркера списка — только пробел/таб (как в Obsidian).
 * - Вариационный селектор U+FE0F после эмодзи поля поглощается в токен поля
 *   (и сохраняется дословно), чтобы «⏳️» распознавалось как «⏳».
 * - У 📅/⏳/🛫 payload может содержать время: «2026-07-25 14:30» и интервал
 *   «2026-07-25 14:30-16:00» (дефис БЕЗ пробелов сразу за временем начала).
 *   Валидное (TIME_RE) время захватывается в payload токена; невалидное
 *   остаётся следующему текст-сегменту. Конец интервала захватывается только
 *   валидным и СТРОГО позже начала; иначе «-…» уходит тексту, а время начала
 *   остаётся в payload (см. scanDateTimeToken).
 * - Хвостовой '\r' (CRLF-файл, разрезанный по '\n') отделяется в trailingCr и
 *   дословно возвращается в конце serializeTokens: иначе '$' не находил бы
 *   ^block-id, а вставка нового поля оказывалась бы ПОСЛЕ '\r' середи строки.
 */
import {
	ALL_FIELD_EMOJI,
	DATE_FIELD_EMOJI,
	VALUE_FIELD_EMOJI,
	PRIORITY_EMOJI,
	type DateFieldName,
	type ValueFieldName,
} from "./emoji";

export type FieldName = DateFieldName | ValueFieldName | "priority";

/** Дата-поля, допускающие опциональное время "HH:mm" после даты (фидбек-раунд 1). */
export type TimedDateFieldName = Extract<DateFieldName, "due" | "scheduled" | "start">;

const TIMED_DATE_FIELDS: ReadonlySet<FieldName> = new Set(["due", "scheduled", "start"]);

export function isTimedDateField(field: FieldName): field is TimedDateFieldName {
	return TIMED_DATE_FIELDS.has(field);
}

/** Валидное время "HH:mm", 24 часа. ЕДИНЫЙ гейт: токенизатор захватывает время
 *  в payload только по нему, парсер и setField валидируют им же — «записали,
 *  а прочиталось null» невозможно по построению (как с датами). */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Форма даты БЕЗ календарной валидации: границы захвата — дело токенизатора,
 *  смысл payload (2026-02-30 — мусор) решает parseDatePayload. */
const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FieldToken {
	kind: "field";
	field: FieldName;
	/** Эмодзи дословно, включая возможный U+FE0F. */
	emoji: string;
	/** Пробельный разделитель между эмодзи и payload, дословно (может быть NBSP). */
	gap: string;
	/** Payload дословно; у приоритета всегда "". */
	payload: string;
}

export interface TextToken {
	kind: "text";
	/** Текст дословно, включая окружающие пробелы. */
	text: string;
}

export type Segment = FieldToken | TextToken;

export interface BlockRef {
	/** Пробелы перед ^id, дословно. */
	spacing: string;
	/** "^id" дословно, с крышкой. */
	ref: string;
	/** Пробельный хвост после ^id (Obsidian его терпит), дословно. */
	trailing: string;
}

export interface TokenizedTaskLine {
	indent: string;
	bullet: "-" | "*" | "+";
	/** Пробелы между маркером списка и '['. */
	afterBullet: string;
	/** Символ внутри [ ]. */
	statusChar: string;
	/** Всё между ']' и хвостовым ^block-id, разбитое на сегменты без потерь. */
	segments: Segment[];
	/** Хвостовой ^block-id — отделён, чтобы новые поля вставлялись ПЕРЕД ним. */
	blockRef: BlockRef | null;
	/** "\r" от CRLF-файла либо ""; отделён, чтобы правки не попадали после него. */
	trailingCr: string;
}

/** Требуем пробел (любой \s) или конец строки после ']' — как Obsidian/CommonMark. */
const HEAD_RE = /^([ \t]*)([-*+])([ \t]+)\[(.)\](?=\s|$)/u;

const BLOCK_REF_RE = /(\s+)(\^[A-Za-z0-9-]+)(\s*)$/;

/** Длинные эмодзи первыми — на случай, если один окажется префиксом другого. */
const FIELD_EMOJI_DESC: readonly string[] = [...ALL_FIELD_EMOJI].sort(
	(a, b) => b.length - a.length,
);

const FIELD_OF_EMOJI: ReadonlyMap<string, FieldName> = (() => {
	const m = new Map<string, FieldName>();
	for (const [name, e] of Object.entries(DATE_FIELD_EMOJI) as [DateFieldName, string][])
		m.set(e, name);
	for (const [name, e] of Object.entries(VALUE_FIELD_EMOJI) as [ValueFieldName, string][])
		m.set(e, name);
	for (const e of Object.values(PRIORITY_EMOJI)) m.set(e, "priority");
	return m;
})();

function isWs(ch: string): boolean {
	return ch !== "" && /\s/.test(ch);
}

interface EmojiMatch {
	emoji: string;
	field: FieldName;
}

function matchFieldEmoji(s: string, i: number): EmojiMatch | null {
	for (const e of FIELD_EMOJI_DESC) {
		if (s.startsWith(e, i)) {
			const emoji = s.charCodeAt(i + e.length) === 0xfe0f ? s.slice(i, i + e.length + 1) : e;
			const field = FIELD_OF_EMOJI.get(e);
			if (field !== undefined) return { emoji, field };
		}
	}
	return null;
}

/** Один токен: до пробела, запятой или начала следующего поля.
 *  Запятая — разделитель списка ⛔, в id/датах не встречается. */
function scanToken(s: string, from: number): number {
	let j = from;
	while (j < s.length && !isWs(s.charAt(j)) && s.charAt(j) !== "," && !matchFieldEmoji(s, j)) j++;
	return j;
}

/** Payload дата-поля 📅/⏳/🛫: «дата[ HH:mm[-HH:mm]]». Валидное время
 *  захватывается В payload токена (а не в следующий текст-сегмент); невалидное —
 *  остаётся тексту: дата не ломается, хвост живёт в описании как раньше.
 *  Разделитель дата↔время — любой \s+ (включая NBSP), захватывается дословно.
 *  Конец интервала — «-HH:mm» БЕЗ пробелов сразу за временем начала, валиден
 *  только СТРОГО позже него; иначе в payload остаётся одно время начала,
 *  а «-…» уходит следующему текст-сегменту. */
function scanDateTimeToken(s: string, from: number): number {
	const dateEnd = scanToken(s, from);
	if (!DATE_SHAPE_RE.test(s.slice(from, dateEnd))) return dateEnd; // офсет ±Nd / мусор
	let k = dateEnd;
	while (k < s.length && isWs(s.charAt(k))) k++;
	if (k === dateEnd) return dateEnd; // «14:30» приклеено без разделителя — не время
	const tokEnd = scanToken(s, k);
	if (tokEnd === k) return dateEnd;
	const tok = s.slice(k, tokEnd);
	if (TIME_RE.test(tok)) return tokEnd; // одиночное «14:30»
	// «HH:mm» — всегда ровно 5 символов: режем кандидата на начало/дефис/конец
	const startPart = tok.slice(0, 5);
	if (!TIME_RE.test(startPart) || tok.charAt(5) !== "-") return dateEnd; // «14:30:00» и пр. — целиком тексту
	const endPart = tok.slice(6);
	// лексикографическое сравнение «HH:mm» == хронологическому (нули ведущие)
	if (TIME_RE.test(endPart) && endPart > startPart) return tokEnd; // «14:30-16:00»
	return k + 5; // начало валидно, конец («-13:00», «-», «-16:00x») — тексту
}

/** Список ⛔: токен, затем жадно «[\s*],[\s*]токен», пока после запятой есть токен.
 *  Пробелы вокруг запятых терпимы (канон — без пробелов); payload — дословный срез. */
function scanCommaList(s: string, from: number): number {
	let j = scanToken(s, from);
	if (j === from) return j;
	for (;;) {
		let k = j;
		while (k < s.length && isWs(s.charAt(k))) k++;
		if (s.charAt(k) !== ",") return j;
		k++;
		while (k < s.length && isWs(s.charAt(k))) k++;
		const e = scanToken(s, k);
		if (e === k) return j; // запятая без id после неё остаётся тексту
		j = e;
	}
}

/**
 * Разбить «хвост» строки (после ']', без ^block-id) на сегменты.
 * Соседние текстовые фрагменты сливаются в один токен; конкатенация всех
 * сегментов даёт исходную строку дословно.
 */
export function tokenizeSegments(rest: string): Segment[] {
	const segs: Segment[] = [];
	let textStart = 0;
	let i = 0;
	const flushText = (end: number): void => {
		if (end > textStart) segs.push({ kind: "text", text: rest.slice(textStart, end) });
	};
	while (i < rest.length) {
		const m = matchFieldEmoji(rest, i);
		if (m === null) {
			i++;
			continue;
		}
		flushText(i);
		i += m.emoji.length;
		if (m.field === "priority") {
			// приоритет — эмодзи без payload; пробел после него принадлежит тексту
			segs.push({ kind: "field", field: "priority", emoji: m.emoji, gap: "", payload: "" });
			textStart = i;
			continue;
		}
		let g = i;
		while (g < rest.length && isWs(rest.charAt(g))) g++;
		const gap = rest.slice(i, g);
		i = g;
		let payloadEnd: number;
		if (m.field === "recurrence") {
			// 🔁: payload до следующего эмодзи поля или конца строки;
			// хвостовые пробелы отдаём следующему текстовому сегменту
			let j = i;
			while (j < rest.length && matchFieldEmoji(rest, j) === null) j++;
			while (j > i && isWs(rest.charAt(j - 1))) j--;
			payloadEnd = j;
		} else if (m.field === "dependsOn" || m.field === "excludedDates") {
			// ⛔ (id) и 🚫 (даты) — поля-списки через запятую: одинаковый скан
			payloadEnd = scanCommaList(rest, i);
		} else if (isTimedDateField(m.field)) {
			payloadEnd = scanDateTimeToken(rest, i);
		} else {
			payloadEnd = scanToken(rest, i);
		}
		segs.push({
			kind: "field",
			field: m.field,
			emoji: m.emoji,
			gap,
			payload: rest.slice(i, payloadEnd),
		});
		i = payloadEnd;
		textStart = i;
	}
	flushText(rest.length);
	return segs;
}

/** null, если строка — не пункт чеклиста (- [x] ...). */
export function tokenizeTaskLine(rawLine: string): TokenizedTaskLine | null {
	if (rawLine.includes("\n")) return null;
	// хвостовой '\r' срезаем ДО разбора: он не должен утопить ^block-id
	// и не должен попадать в текстовые сегменты (правки вставляют ПЕРЕД ним)
	const trailingCr = rawLine.endsWith("\r") ? "\r" : "";
	const line = trailingCr === "" ? rawLine : rawLine.slice(0, -1);
	const h = HEAD_RE.exec(line);
	if (h === null) return null;
	let rest = line.slice(h[0].length);
	let blockRef: BlockRef | null = null;
	const b = BLOCK_REF_RE.exec(rest);
	if (b !== null) {
		blockRef = { spacing: b[1]!, ref: b[2]!, trailing: b[3]! };
		rest = rest.slice(0, b.index);
	}
	return {
		indent: h[1]!,
		bullet: h[2]! as "-" | "*" | "+",
		afterBullet: h[3]!,
		statusChar: h[4]!,
		segments: tokenizeSegments(rest),
		blockRef,
		trailingCr,
	};
}

/** Точная обратная операция к tokenizeTaskLine. */
export function serializeTokens(t: TokenizedTaskLine): string {
	let s = `${t.indent}${t.bullet}${t.afterBullet}[${t.statusChar}]`;
	for (const seg of t.segments) {
		s += seg.kind === "text" ? seg.text : seg.emoji + seg.gap + seg.payload;
	}
	if (t.blockRef !== null) s += t.blockRef.spacing + t.blockRef.ref + t.blockRef.trailing;
	return s + t.trailingCr;
}

/** Символ, допустимый в теле тега Obsidian (без '#'). */
export function isTagChar(ch: string): boolean {
	if (ch === "") return false;
	if (/[0-9A-Za-z_/-]/.test(ch)) return true;
	// любой не-ASCII, кроме пробельных (в т.ч. NBSP)
	return ch.charCodeAt(0) > 0x7f && !/\s/.test(ch);
}

/**
 * #теги из простого текста (теги — часть текста, не поля).
 * Правила Obsidian: латиница/цифры/_/-//, любой не-ASCII не-пробел;
 * минимум один нецифровой символ; '#' не внутри слова и не после '#'.
 */
export function extractTags(text: string): string[] {
	const out: string[] = [];
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
		if (body !== "" && /[^0-9]/.test(body)) out.push(text.slice(i, j));
		i = j > i + 1 ? j : i + 1;
	}
	return out;
}
