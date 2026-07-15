/**
 * serializeTaskLine — правка ОДНОГО поля строки без потерь (ТЗ §3, §15).
 *
 * Инварианты:
 * - Меняется только целевой токен; чужие поля, текст, теги, отступы,
 *   исходные пробелы (включая NBSP) и хвостовой ^block-id — дословно.
 * - Новое поле добавляется в конец строки (перед ^block-id) с одним
 *   ведущим пробелом.
 * - Удаление поля съедает ровно один смежный пробел (сначала слева,
 *   иначе справа).
 * - При дублях поля: замена правит ПОСЛЕДНИЙ токен (его видит парсер,
 *   «последний побеждает»), удаление убирает ВСЕ токены поля — иначе
 *   после удаления «воскресал» бы более ранний дубль.
 * - Вызов на строке-не-задаче — ошибка программы: бросаем, а не молча
 *   возвращаем строку (защита от тихой порчи write-back).
 * - Исключение из «одного поля» — setDescription: заменяет ВСЕ текстовые
 *   сегменты одной строкой, поля при этом дословны (см. её комментарий).
 */
import type { IsoDate, Priority } from "../model/Task";
import {
	ALL_FIELD_EMOJI,
	DATE_FIELD_EMOJI,
	PRIORITY_EMOJI,
	VALUE_FIELD_EMOJI,
	type DateFieldName,
} from "./emoji";
import { parseDatePayload, splitDateTimePayload } from "./parseTaskLine";
import {
	extractTags,
	isTagChar,
	isTimedDateField,
	serializeTokens,
	tokenizeTaskLine,
	TIME_RE,
	type FieldName,
	type FieldToken,
	type Segment,
	type TokenizedTaskLine,
} from "./tokenizer";

function mustTokenize(rawLine: string): TokenizedTaskLine {
	const t = tokenizeTaskLine(rawLine);
	if (t === null) {
		throw new Error(`serializeTaskLine: строка не является задачей: ${JSON.stringify(rawLine)}`);
	}
	return t;
}

/** id и одиночные значения: без пробелов и запятых (запятая — разделитель ⛔). */
function assertToken(value: string, what: string): void {
	if (value === "" || /\s/.test(value) || value.includes(",")) {
		throw new Error(`serializeTaskLine: недопустимое значение ${what}: ${JSON.stringify(value)}`);
	}
}

function fieldIndices(segs: readonly Segment[], field: FieldName): number[] {
	const out: number[] = [];
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i]!;
		if (s.kind === "field" && s.field === field) out.push(i);
	}
	return out;
}

/** Удалить сегмент + ровно один смежный пробел (слева, иначе справа). */
function removeSegmentAt(segs: Segment[], idx: number): void {
	const prev = segs[idx - 1];
	const next = segs[idx + 1];
	if (prev !== undefined && prev.kind === "text" && /\s$/.test(prev.text)) {
		prev.text = prev.text.slice(0, -1);
	} else if (next !== undefined && next.kind === "text" && /^\s/.test(next.text)) {
		next.text = next.text.slice(1);
	}
	segs.splice(idx, 1);
}

/**
 * После удаления первый сегмент обязан начинаться с пробела: HEAD_RE требует
 * \s (или конец строки) сразу после ']', иначе строка перестаёт быть задачей.
 * Удаление могло съесть именно этот единственный разделитель (поле/тег были
 * приклеены к следующему токену: "- [ ] ⏫Call" → "- [ ]Call").
 */
function ensureHeadSeparator(segs: Segment[]): void {
	const first = segs[0];
	if (first === undefined) return; // "- [ ]" валиден через (?=$)
	if (first.kind === "text") {
		if (!/^\s/.test(first.text)) first.text = ` ${first.text}`;
	} else {
		segs.unshift({ kind: "text", text: " " });
	}
}

/** Слить соседние текстовые сегменты и выкинуть пустые — конкатенацию не меняет. */
function coalesceText(segs: Segment[]): void {
	for (let i = segs.length - 1; i >= 0; i--) {
		const s = segs[i]!;
		if (s.kind !== "text") continue;
		if (s.text === "") {
			segs.splice(i, 1);
			continue;
		}
		const prev = segs[i - 1];
		if (prev !== undefined && prev.kind === "text") {
			prev.text += s.text;
			segs.splice(i, 1);
		}
	}
}

function setPayloadField(
	rawLine: string,
	field: Exclude<FieldName, "priority">,
	emoji: string,
	payload: string | null,
): string {
	const t = mustTokenize(rawLine);
	const idxs = fieldIndices(t.segments, field);
	if (payload === null) {
		if (idxs.length === 0) return rawLine;
		for (let k = idxs.length - 1; k >= 0; k--) removeSegmentAt(t.segments, idxs[k]!);
		coalesceText(t.segments);
		ensureHeadSeparator(t.segments);
		return serializeTokens(t);
	}
	if (idxs.length > 0) {
		const tok = t.segments[idxs[idxs.length - 1]!] as FieldToken;
		// голый эмодзи в конце строки («📅» без значения) — добавить разделитель
		if (tok.gap === "" && tok.payload === "") tok.gap = " ";
		tok.payload = payload;
		return serializeTokens(t);
	}
	t.segments.push({ kind: "text", text: " " }, { kind: "field", field, emoji, gap: " ", payload });
	return serializeTokens(t);
}

/** Время «HH:mm» (и конец интервала) из ПОСЛЕДНЕГО токена поля — именно его
 *  правит замена («последний побеждает» и у парсера). Нет поля/времени — null. */
function existingFieldTimes(
	t: TokenizedTaskLine,
	field: DateFieldName,
): { time: string | null; timeEnd: string | null } {
	const idxs = fieldIndices(t.segments, field);
	if (idxs.length === 0) return { time: null, timeEnd: null };
	const tok = t.segments[idxs[idxs.length - 1]!] as FieldToken;
	const { time, timeEnd } = splitDateTimePayload(tok.payload);
	return { time, timeEnd };
}

/**
 * Вставить/заменить/удалить (value === null) поле-дату.
 *
 * time — ТОЛЬКО для 📅/⏳/🛫 (due/scheduled/start):
 * - undefined (аргумент опущен) — сохранить существующее время поля: старые
 *   вызовы без 4-го аргумента при замене даты НЕ стирают время;
 * - null — снять время (остаётся голая дата); снимается и конец интервала;
 * - "HH:mm" — установить (валидация TIME_RE, мусор — throw, как у дат).
 *
 * timeEnd — конец интервала «-HH:mm», семантика та же (undefined сохранить,
 * null снять, строка установить). Строка-timeEnd при отсутствии времени начала
 * (в т.ч. time === undefined на строке без времени) — throw; timeEnd <= времени
 * начала — throw (на диске конец живёт только СТРОГО позже начала).
 */
export function setField(
	rawLine: string,
	field: DateFieldName,
	value: IsoDate | null,
	time?: string | null,
	timeEnd?: string | null,
): string {
	// писатель не мягче читателя: валидируем ТЕМ ЖЕ parseDatePayload, что и парсер,
	// иначе записанная дата (2026-13-05) молча читалась бы обратно как null
	if (value !== null && parseDatePayload(value).kind !== "date") {
		throw new Error(`serializeTaskLine: не ISO-дата: ${JSON.stringify(value)}`);
	}
	if (time !== undefined) {
		if (!isTimedDateField(field)) {
			throw new Error(`serializeTaskLine: поле ${field} не имеет времени`);
		}
		if (time !== null && !TIME_RE.test(time)) {
			throw new Error(`serializeTaskLine: не время HH:mm: ${JSON.stringify(time)}`);
		}
		if (time !== null && value === null) {
			throw new Error(`serializeTaskLine: время без даты: ${JSON.stringify(time)}`);
		}
	}
	if (timeEnd !== undefined) {
		if (!isTimedDateField(field)) {
			throw new Error(`serializeTaskLine: поле ${field} не имеет времени`);
		}
		if (timeEnd !== null && !TIME_RE.test(timeEnd)) {
			throw new Error(`serializeTaskLine: не время HH:mm: ${JSON.stringify(timeEnd)}`);
		}
		if (timeEnd !== null && value === null) {
			throw new Error(`serializeTaskLine: время без даты: ${JSON.stringify(timeEnd)}`);
		}
	}
	if (value === null) {
		// удаление поля сносит и его время с интервалом: они живут внутри payload токена
		return setPayloadField(rawLine, field, DATE_FIELD_EMOJI[field], null);
	}
	let effTime: string | null = time ?? null;
	let effTimeEnd: string | null = timeEnd ?? null;
	if (isTimedDateField(field) && (time === undefined || timeEnd === undefined)) {
		const existing = existingFieldTimes(mustTokenize(rawLine), field);
		if (time === undefined) effTime = existing.time;
		// снятие времени начала (time === null) сносит и конец интервала
		if (timeEnd === undefined) effTimeEnd = time === null ? null : existing.timeEnd;
	}
	if (effTimeEnd !== null) {
		// итоговая пара обязана быть валидной НА ДИСКЕ: конец без начала или
		// не позже начала токенизатор не прочитал бы обратно — отклоняем на записи
		if (effTime === null) {
			throw new Error(
				`serializeTaskLine: конец интервала без времени начала: ${JSON.stringify(effTimeEnd)}`,
			);
		}
		if (effTimeEnd <= effTime) {
			throw new Error(
				`serializeTaskLine: конец интервала не позже начала: ${JSON.stringify(`${effTime}-${effTimeEnd}`)}`,
			);
		}
	}
	const payload =
		effTime === null
			? value
			: effTimeEnd === null
				? `${value} ${effTime}`
				: `${value} ${effTime}-${effTimeEnd}`;
	return setPayloadField(rawLine, field, DATE_FIELD_EMOJI[field], payload);
}

/** Вставить/заменить/удалить 🆔 или 🧬. */
export function setValueField(
	rawLine: string,
	field: "id" | "spawnedFrom",
	value: string | null,
): string {
	if (value !== null) assertToken(value, field);
	return setPayloadField(rawLine, field, VALUE_FIELD_EMOJI[field], value);
}

/** Полная замена списка ⛔; пустой список удаляет поле. */
export function setDependsOn(rawLine: string, ids: string[]): string {
	for (const id of ids) assertToken(id, "dependsOn id");
	return setPayloadField(
		rawLine,
		"dependsOn",
		VALUE_FIELD_EMOJI.dependsOn,
		ids.length === 0 ? null : ids.join(","),
	);
}

export function setStatusChar(rawLine: string, ch: string): string {
	// ровно один code point — иначе строка перестанет парситься как задача;
	// '\r' и '\n' не совпадают с '.' в HEAD_RE
	if ([...ch].length !== 1 || ch === "]" || ch === "\n" || ch === "\r") {
		throw new Error(`serializeTaskLine: недопустимый статус: ${JSON.stringify(ch)}`);
	}
	const t = mustTokenize(rawLine);
	t.statusChar = ch;
	return serializeTokens(t);
}

export function setPriority(rawLine: string, p: Priority): string {
	const t = mustTokenize(rawLine);
	const idxs = fieldIndices(t.segments, "priority");
	if (p === "none") {
		if (idxs.length === 0) return rawLine;
		for (let k = idxs.length - 1; k >= 0; k--) removeSegmentAt(t.segments, idxs[k]!);
		coalesceText(t.segments);
		ensureHeadSeparator(t.segments);
		return serializeTokens(t);
	}
	const emoji = PRIORITY_EMOJI[p];
	if (idxs.length > 0) {
		(t.segments[idxs[idxs.length - 1]!] as FieldToken).emoji = emoji;
		return serializeTokens(t);
	}
	t.segments.push(
		{ kind: "text", text: " " },
		{ kind: "field", field: "priority", emoji, gap: "", payload: "" },
	);
	return serializeTokens(t);
}

/** '#tag' или 'tag' → '#tag'; валидация через сам экстрактор тегов. */
function normalizeTag(tag: string): string {
	const norm = tag.startsWith("#") ? tag : `#${tag}`;
	const found = extractTags(` ${norm} `);
	if (found.length !== 1 || found[0] !== norm) {
		throw new Error(`serializeTaskLine: недопустимый тег: ${JSON.stringify(tag)}`);
	}
	// токенизатор режет строку по эмодзи полей ДО извлечения тегов, поэтому тег
	// с 📅/⏫/… никогда не прочитается обратно целиком — отклоняем на входе
	for (const e of ALL_FIELD_EMOJI) {
		if (norm.includes(e)) {
			throw new Error(
				`serializeTaskLine: недопустимый тег (эмодзи поля): ${JSON.stringify(tag)}`,
			);
		}
	}
	return norm;
}

function collectTags(segs: readonly Segment[]): string[] {
	const out: string[] = [];
	for (const s of segs) {
		if (s.kind !== "text") continue;
		for (const t of extractTags(s.text)) if (!out.includes(t)) out.push(t);
	}
	return out;
}

/**
 * Добавить тег. Тег — часть текста описания, поэтому вставляется в КОНЕЦ
 * текстового префикса (до первого поля), а не в конец строки: тег, дописанный
 * после 🔁, был бы проглочен payload'ом правила повтора.
 * Если тег уже есть — строка возвращается без изменений.
 */
export function addTag(rawLine: string, tag: string): string {
	const norm = normalizeTag(tag);
	const t = mustTokenize(rawLine);
	if (collectTags(t.segments).includes(norm)) return rawLine;
	const first = t.segments[0];
	if (first === undefined) {
		t.segments.push({ kind: "text", text: ` ${norm}` });
	} else if (first.kind === "text") {
		// вставка перед хвостовыми пробелами префикса — они разделяют первое поле
		const m = /\s*$/.exec(first.text)!;
		first.text = `${first.text.slice(0, m.index)} ${norm}${first.text.slice(m.index)}`;
	} else {
		// защитный случай: строка начинается сразу с поля (после ']' нет текста)
		t.segments.unshift({ kind: "text", text: ` ${norm}` });
	}
	return serializeTokens(t);
}

function removeTagFromText(text: string, tag: string): string {
	let out = text;
	let idx = 0;
	while ((idx = out.indexOf(tag, idx)) !== -1) {
		const before = idx > 0 ? out.charAt(idx - 1) : "";
		const after = out.charAt(idx + tag.length);
		// границы: '#work' не должен цеплять 'x#work', '##work' и '#work/sub'
		if (before === "#" || isTagChar(before) || isTagChar(after)) {
			idx += 1;
			continue;
		}
		let s = idx;
		let e = idx + tag.length;
		if (s > 0 && /\s/.test(out.charAt(s - 1))) s--;
		else if (after !== "" && /\s/.test(after)) e++;
		out = out.slice(0, s) + out.slice(e);
		idx = s;
	}
	return out;
}

/**
 * Полная замена текста описания (инлайн-редактирование карточки).
 *
 * Все текстовые сегменты заменяются ОДНОЙ строкой текста; поле-токены остаются
 * в исходном порядке с исходными байтами (эмодзи + gap + payload — включая
 * NBSP-разделители и payload 🔁 дословно); ^block-id и хвостовой \r — на месте.
 * Разделители: ' ' между текстом и первым полем и по ' ' между полями.
 *
 * text канонизируется как description парсера (\s+ → ' ', trim; \n сюда же) —
 * повторный parse даёт description === канон. Пустой канон валиден:
 * «- [ ] 📅 2026-01-01» — задача без описания.
 * Эмодзи полей внутри text — throw (как addTag): парсер прочитал бы их
 * как поля, а не как текст.
 */
export function setDescription(rawLine: string, text: string): string {
	const canon = text.replace(/\s+/g, " ").trim();
	for (const e of ALL_FIELD_EMOJI) {
		if (canon.includes(e)) {
			throw new Error(
				`serializeTaskLine: эмодзи поля в тексте описания: ${JSON.stringify(text)}`,
			);
		}
	}
	const t = mustTokenize(rawLine);
	const fieldToks = t.segments.filter((s): s is FieldToken => s.kind === "field");
	const segs: Segment[] = [];
	if (canon !== "") segs.push({ kind: "text", text: ` ${canon}` });
	for (const f of fieldToks) segs.push({ kind: "text", text: " " }, f);
	t.segments = segs;
	coalesceText(t.segments); // « текст» + « » → один сегмент; сериализацию не меняет
	return serializeTokens(t);
}

/** Удалить все вхождения тега (плюс по одному смежному пробелу на каждое). */
export function removeTag(rawLine: string, tag: string): string {
	const norm = normalizeTag(tag);
	const t = mustTokenize(rawLine);
	let changed = false;
	for (const seg of t.segments) {
		if (seg.kind !== "text") continue;
		const out = removeTagFromText(seg.text, norm);
		if (out !== seg.text) {
			seg.text = out;
			changed = true;
		}
	}
	if (!changed) return rawLine;
	coalesceText(t.segments);
	ensureHeadSeparator(t.segments);
	return serializeTokens(t);
}
