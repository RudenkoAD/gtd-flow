/**
 * Логика повторяющихся событий календаря (§события): построение и правка строки
 * серии, разбор/сборка хвоста времени "at HH:mm", создание и редактирование
 * серии через структурные порты. Ноль импортов obsidian — тестируется в node;
 * запись идёт через порт, совместимый с VaultAdapter.
 */
import type { IsoDate, Task } from "../../core/model/Task";
import { VALUE_FIELD_EMOJI } from "../../core/parser/emoji";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import {
	addExcludedDate,
	setDescription,
	setField,
	setValueField,
} from "../../core/parser/serializeTaskLine";
import { serializeTokens, tokenizeTaskLine, type FieldToken } from "../../core/parser/tokenizer";
import { isParseError, parseRule } from "../../core/recurrence/grammar";
import { locateTaskLine } from "../../services/WritebackService";

/** Структурный порт файла событий; совместим с VaultAdapter. */
export interface EventVaultPort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<unknown>;
}

export type EventWriteResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Чистые преобразования строки серии
// ---------------------------------------------------------------------------

/**
 * Проставить/снять 📍 на строке через setValueField ЯДРА. location === null | ""
 * — снять поле (или ничего не делать, если его нет). null-результат — недопустимое
 * место (эмодзи поля в тексте: setValueField бросает — ловим, как editEventLine).
 */
function applyLocation(line: string, location: string | null): string | null {
	const loc = (location ?? "").trim();
	try {
		return setValueField(line, "location", loc === "" ? null : loc);
	} catch {
		return null;
	}
}

/**
 * Строка новой серии: `- [ ] <name> 🔁 <ruleText> [📍 <место>]`. Пустое имя —
 * null (не пишем). Непустое место дописывается полем 📍 (setValueField ядра);
 * недопустимое место (эмодзи поля) — тоже null.
 */
export function buildEventLine(name: string, ruleText: string, location: string | null = null): string | null {
	const n = name.replace(/\s+/g, " ").trim();
	if (n === "") return null;
	return applyLocation(`- [ ] ${n} 🔁 ${ruleText.trim()}`, location);
}

/**
 * Атомарная правка строки серии: название через setDescription + payload 🔁 +
 * поле 📍 (setValueField) — ОДНОЙ трансформацией (не три intent'а). null — строка
 * не задача либо название/место содержит эмодзи поля (сеттеры бросают — ловим).
 * location === null | "" снимает 📍 (если было); непустое — ставит/меняет.
 */
export function editEventLine(
	rawLine: string,
	name: string,
	ruleText: string,
	location: string | null = null,
): string | null {
	const n = name.replace(/\s+/g, " ").trim();
	if (n === "") return null;
	let line: string;
	try {
		line = setDescription(rawLine, n);
	} catch {
		return null; // эмодзи поля в названии — недопустимо
	}
	const withRule = setRecurrencePayload(line, ruleText.trim());
	if (withRule === null) return null;
	return applyLocation(withRule, location);
}

/**
 * Замена payload ПОСЛЕДНЕГО 🔁 (его видит парсер), добавление поля при
 * отсутствии — та же механика, что RecurrenceService.setRecurrenceText.
 * round-trip без потерь гарантирует serializeTokens. null — строка не задача.
 */
function setRecurrencePayload(rawLine: string, ruleText: string): string | null {
	const t = tokenizeTaskLine(rawLine);
	if (t === null) return null;
	const idxs: number[] = [];
	for (let i = 0; i < t.segments.length; i++) {
		const s = t.segments[i]!;
		if (s.kind === "field" && s.field === "recurrence") idxs.push(i);
	}
	if (idxs.length > 0) {
		const tok = t.segments[idxs[idxs.length - 1]!] as FieldToken;
		if (tok.gap === "" && tok.payload === "") tok.gap = " ";
		tok.payload = ruleText;
	} else {
		t.segments.push(
			{ kind: "text", text: " " },
			{
				kind: "field",
				field: "recurrence",
				emoji: VALUE_FIELD_EMOJI.recurrence,
				gap: " ",
				payload: ruleText,
			},
		);
	}
	return serializeTokens(t);
}

/**
 * Разбить правило на «без времени» + «время» для полей модала: хвост
 * "… at HH:mm" / "… at HH:mm-HH:mm" отщепляется в поле времени. Нет хвоста —
 * time пустой. Разбор чисто текстовый (та же форма, что грамматика 'at').
 */
export function splitEventRule(ruleText: string): { rule: string; time: string } {
	const m = /^(.*?)\s+at\s+(\S+)\s*$/i.exec(ruleText.trim());
	if (m !== null && m[1] !== undefined && m[2] !== undefined) {
		return { rule: m[1].trim(), time: m[2] };
	}
	return { rule: ruleText.trim(), time: "" };
}

/** Собрать правило из полей модала: непустое время — хвостом " at <time>". */
export function joinEventRule(rule: string, time: string): string {
	const r = rule.trim();
	const t = time.trim();
	return t === "" ? r : `${r} at ${t}`;
}

/**
 * Закрепить чётность недель НОВОЙ серии: для weekly с byDay и n>1 без явного
 * from дописать 'from <дата серии>'. Иначе фаза недель у серии не закреплена —
 * разворот в календаре опирался бы на эпоха-фолбэк (стабильно, но фаза
 * произвольна). Первым вхождением явный from делает ближайший день byDay ≥ даты
 * создания (фаза считается от него, см. snapWeekAnchor); когда дата создания сама
 * попадает на день byDay — первым вхождением становится она.
 * Идемпотентно: from уже есть / правило не weekly-n>1-byDay / битое — текст как есть.
 * from вставляется ПЕРЕД хвостом 'at' (splitEventRule на правке остаётся рабочим).
 */
export function withSeriesAnchor(ruleText: string, seriesDate: IsoDate): string {
	const parsed = parseRule(ruleText);
	if (isParseError(parsed)) return ruleText;
	if (parsed.freq !== "weekly" || parsed.byDay.length === 0 || parsed.n <= 1) return ruleText;
	if (parsed.from !== undefined) return ruleText;
	const { rule, time } = splitEventRule(ruleText);
	return joinEventRule(`${rule} from ${seriesDate}`, time);
}

/**
 * Строка одноразового события-переноса вхождения серии:
 * `- [ ] <name> 📅 <date>[ HH:mm[-HH:mm]] [🧬 <seriesId>]`. Пустое имя — null.
 * Конец интервала пишется только строго позже начала (иначе выпадает — как в
 * каноне генератора парсера). 🧬 (провенанс серии) добавляется при seriesId.
 */
export function buildSingleOccurrenceLine(
	name: string,
	date: IsoDate,
	time: string | null,
	timeEnd: string | null,
	seriesId: string | null,
): string | null {
	const n = name.replace(/\s+/g, " ").trim();
	if (n === "") return null;
	let timeTail = "";
	if (time !== null) {
		timeTail = ` ${time}`;
		if (timeEnd !== null && timeEnd > time) timeTail += `-${timeEnd}`;
	}
	const prov = seriesId !== null ? ` ${VALUE_FIELD_EMOJI.spawnedFrom} ${seriesId}` : "";
	return `- [ ] ${n} 📅 ${date}${timeTail}${prov}`;
}

// ---------------------------------------------------------------------------
// Создание / правка серии через порты
// ---------------------------------------------------------------------------

/** append-блок серии в конец файла (форма '\n' — как WritebackService.moveLine). */
function appendLine(content: string, line: string): string {
	return content.trimEnd() !== ""
		? content + (content.endsWith("\n") ? "" : "\n") + line + "\n"
		: line + "\n";
}

/**
 * Создать серию-событие: ensureFile(eventsFile) + frontmatter gtd-events: true
 * (СТРОГО до append — иначе строка успела бы прожить как обычная задача и
 * протечь во входящие), затем append строки серии. Правило валидируется parseRule.
 */
export async function createEventSeries(deps: {
	vault: EventVaultPort;
	eventsFile: string;
	name: string;
	ruleText: string;
	/** Опциональное место 📍 (пусто/undefined — без поля). */
	location?: string | null;
}): Promise<EventWriteResult> {
	if (isParseError(parseRule(deps.ruleText))) return { ok: false, reason: "invalid-rule" };
	const line = buildEventLine(deps.name, deps.ruleText, deps.location ?? null);
	if (line === null) {
		// buildEventLine отдаёт null по ДВУМ причинам: пустое имя ИЛИ недопустимое
		// место (эмодзи поля в 📍). Различаем повторной сборкой без места — иначе
		// заполненное имя ошибочно рапортовалось бы как "empty-name" (модал место
		// не валидирует), и создание падало бы молча с неверной причиной.
		const reason =
			buildEventLine(deps.name, deps.ruleText) === null ? "empty-name" : "invalid-location";
		return { ok: false, reason };
	}
	try {
		await deps.vault.ensureFile(deps.eventsFile);
		await deps.vault.processFrontmatter(deps.eventsFile, (fm) => {
			fm["gtd-events"] = true;
		});
	} catch {
		return { ok: false, reason: "events-file-create-failed" };
	}
	const ok = await deps.vault.processFile(deps.eventsFile, (content) => appendLine(content, line));
	return ok ? { ok: true } : { ok: false, reason: "write-failed" };
}

/**
 * Создать ОДНОРАЗОВОЕ событие — строку `- [ ] <name> 📅 <date>[ HH:mm[-HH:mm]]` в
 * файле событий (формат buildSingleOccurrenceLine, без 🧬 — новое событие, не
 * перенос вхождения). Дата и время начала-конца берутся из клика/драга по сетке
 * (в месячной сетке времени нет — событие «Весь день»). ensureFile + frontmatter
 * gtd-events: true СТРОГО до append (иначе строка успела бы прожить обычной задачей
 * и протечь во входящие), затем append строки. Параллель createEventSeries для 🔁.
 */
export async function createSingleEvent(deps: {
	vault: EventVaultPort;
	eventsFile: string;
	name: string;
	date: IsoDate;
	time: string | null;
	timeEnd: string | null;
	/** Опциональное место 📍 (пусто/null/undefined — без поля); эмодзи поля — invalid-location. */
	location?: string | null;
}): Promise<EventWriteResult> {
	const base = buildSingleOccurrenceLine(deps.name, deps.date, deps.time, deps.timeEnd, null);
	if (base === null) return { ok: false, reason: "empty-name" };
	// место дописывается той же трансформацией строки (setValueField ядра); эмодзи
	// поля в значении даёт null — согласовано с createEventSeries ("invalid-location")
	const line = applyLocation(base, deps.location ?? null);
	if (line === null) return { ok: false, reason: "invalid-location" };
	try {
		await deps.vault.ensureFile(deps.eventsFile);
		await deps.vault.processFrontmatter(deps.eventsFile, (fm) => {
			fm["gtd-events"] = true;
		});
	} catch {
		return { ok: false, reason: "events-file-create-failed" };
	}
	const ok = await deps.vault.processFile(deps.eventsFile, (content) => appendLine(content, line));
	return ok ? { ok: true } : { ok: false, reason: "write-failed" };
}

/**
 * Копия серии-события в ТОТ ЖЕ файл, что источник, но с НОВЫМ, свежим 🆔.
 * Идентичность серии в этом коде — 🆔/taskId (locateTaskLine адресует правки/
 * удаление по нему; 🧬 — это провенанс переноса ВХОЖДЕНИЯ, не серии). Свежий 🆔
 * делает копию адресуемой отдельно от источника даже когда пользователь не тронул
 * название/правило (иначе две одинаковые строки — двойники для локализации).
 * Поля (название, правило, место) приходят из источника преднаполненными и
 * правятся в модале. Валидация — как createEventSeries (invalid-rule / empty-name /
 * invalid-location). genId — детерминированный в тестах.
 */
export async function copyEventSeries(deps: {
	vault: EventVaultPort;
	/** Файл источника — копия ложится рядом (тот же container events). */
	eventsFile: string;
	name: string;
	ruleText: string;
	/** Опциональное место 📍 (пусто/null — без поля). */
	location?: string | null;
	/** Ленивый генератор 🆔 (тесты передают детерминированный). */
	genId?: () => string;
}): Promise<EventWriteResult> {
	if (isParseError(parseRule(deps.ruleText))) return { ok: false, reason: "invalid-rule" };
	// пред-валидация имени и места ДО касания файла (различаем empty-name /
	// invalid-location повторной сборкой без места — как createEventSeries)
	if (buildEventLine(deps.name, deps.ruleText, deps.location ?? null) === null) {
		const reason =
			buildEventLine(deps.name, deps.ruleText) === null ? "empty-name" : "invalid-location";
		return { ok: false, reason };
	}
	const genId = deps.genId ?? defaultEventId;
	const n = deps.name.replace(/\s+/g, " ").trim();
	try {
		await deps.vault.ensureFile(deps.eventsFile);
		await deps.vault.processFrontmatter(deps.eventsFile, (fm) => {
			fm["gtd-events"] = true;
		});
	} catch {
		return { ok: false, reason: "events-file-create-failed" };
	}
	let failure: string | null = null;
	const ok = await deps.vault.processFile(deps.eventsFile, (content) => {
		const lines = content.split("\n");
		// свежий 🆔, не совпадающий с уже занятыми в файле (в т.ч. с 🆔 источника)
		const id = freshEventId(existingIds(lines, deps.eventsFile), genId);
		// канонический порядок полей — 🆔 перед 📍 (как в editEventLine): id на строку
		// без места, затем место (место пред-валидировано выше — applyLocation ≠ null)
		let line: string;
		try {
			line = setValueField(`- [ ] ${n} 🔁 ${deps.ruleText.trim()}`, "id", id);
		} catch {
			failure = "transform-failed";
			return null;
		}
		const withLoc = applyLocation(line, deps.location ?? null);
		if (withLoc === null) {
			failure = "invalid-location";
			return null;
		}
		return appendLine(content, withLoc);
	});
	if (failure !== null) return { ok: false, reason: failure };
	return ok ? { ok: true } : { ok: false, reason: "write-failed" };
}

/**
 * Правка серии: локализация строки (по 🆔/описанию, как WritebackService) и
 * атомарная замена названия+правила ОДНОЙ трансформацией. Правило валидируется
 * parseRule до записи.
 */
export async function editEventSeries(deps: {
	vault: EventVaultPort;
	task: Task;
	name: string;
	ruleText: string;
	/** Опциональное место 📍 (пусто/null — снять поле). */
	location?: string | null;
}): Promise<EventWriteResult> {
	if (isParseError(parseRule(deps.ruleText))) return { ok: false, reason: "invalid-rule" };
	if (buildEventLine(deps.name, deps.ruleText) === null) return { ok: false, reason: "empty-name" };
	let failure: string | null = "file-not-found";
	try {
		await deps.vault.processFile(deps.task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, deps.task.filePath, deps.task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			const next = editEventLine(lines[idx]!, deps.name, deps.ruleText, deps.location ?? null);
			if (next === null) {
				// имя (стр. выше) и правило (parseRule) уже валидны — значит null
				// дало недопустимое место; отделяем его от прочих сбоев правкой без
				// места (согласовано с createEventSeries: "invalid-location")
				failure =
					editEventLine(lines[idx]!, deps.name, deps.ruleText) === null
						? "transform-failed"
						: "invalid-location";
				return null;
			}
			if (next === lines[idx]) return null; // без изменений — успех без записи
			lines[idx] = next;
			return lines.join("\n");
		});
	} catch {
		return { ok: false, reason: "write-failed" };
	}
	return failure === null ? { ok: true } : { ok: false, reason: failure };
}

// ---------------------------------------------------------------------------
// Операции над ОТДЕЛЬНЫМИ вхождениями (перенос / удаление, раунд 6)
// ---------------------------------------------------------------------------

/**
 * Правка ТОЛЬКО поля 📍 строки события (серии или одноразового) одной атомарной
 * записью: setValueField(line, "location", ...) на локализованной строке.
 * location === null | "" — снять поле. Локализация — по 🆔/описанию (как
 * editEventSeries). Работает и с чипа вхождения серии — правит строку серии.
 * Место с эмодзи поля недопустимо (setValueField бросает) — reason transform-failed.
 */
export async function setEventLocation(deps: {
	vault: EventVaultPort;
	task: Task;
	location: string | null;
}): Promise<EventWriteResult> {
	const loc = (deps.location ?? "").trim();
	let failure: string | null = "file-not-found";
	try {
		await deps.vault.processFile(deps.task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, deps.task.filePath, deps.task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			let next: string;
			try {
				next = setValueField(lines[idx]!, "location", loc === "" ? null : loc);
			} catch {
				failure = "transform-failed";
				return null;
			}
			if (next === lines[idx]) return null; // без изменений — успех без записи
			lines[idx] = next;
			return lines.join("\n");
		});
	} catch {
		return { ok: false, reason: "write-failed" };
	}
	return failure === null ? { ok: true } : { ok: false, reason: failure };
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 6-символьный base36-id серии для ленивого проставления 🆔 при переносе. */
function defaultEventId(): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += BASE36.charAt(Math.floor(Math.random() * BASE36.length));
	return s;
}

/** 🆔, уже занятые в файле событий (сверка для ленивого генератора). */
function existingIds(lines: readonly string[], filePath: string): Set<string> {
	const ids = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const t = parseTaskLine(lines[i]!, {
			filePath,
			lineStart: i,
			parentLine: null,
			heading: null,
			container: "events",
			projectActive: true,
		});
		if (t?.taskId != null) ids.add(t.taskId);
	}
	return ids;
}

/** Свежий 🆔, не совпадающий с уже занятыми в файле; крайний случай — последний кандидат. */
function freshEventId(taken: ReadonlySet<string>, genId: () => string): string {
	let id = genId();
	for (let attempt = 0; attempt < 64 && taken.has(id); attempt++) id = genId();
	return id;
}

/**
 * Удалить ОДНО вхождение серии: добавить 🚫 <date> к строке серии (addExcludedDate)
 * одной атомарной правкой. Обратимо (дата живёт в 🚫), потому без confirm.
 * Локализация строки — по 🆔/описанию (как editEventSeries). Повторный вызов на
 * уже исключённой дате — успех без записи (addExcludedDate идемпотентен).
 */
export async function excludeEventOccurrence(deps: {
	vault: EventVaultPort;
	task: Task;
	date: IsoDate;
}): Promise<EventWriteResult> {
	let failure: string | null = "file-not-found";
	try {
		await deps.vault.processFile(deps.task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, deps.task.filePath, deps.task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			const next = addExcludedDate(lines[idx]!, deps.date);
			if (next === lines[idx]) return null; // уже исключена — успех без записи
			lines[idx] = next;
			return lines.join("\n");
		});
	} catch {
		return { ok: false, reason: "write-failed" };
	}
	return failure === null ? { ok: true } : { ok: false, reason: failure };
}

/**
 * Перенести ОДНО вхождение события на новую дату/время.
 *
 * kind "series" — ОДНА атомарная запись в файле событий: строка серии получает
 *   🚫 <fromDate> (исходное вхождение гаснет) и, если у серии нет 🆔, — ленивый
 *   🆔 (тем же processFile); следом в файл добавляется строка одноразового
 *   события `- [ ] <name> 📅 <toDate> <время> 🧬 <🆔 серии>` (провенанс переноса).
 * kind "single" — правка собственной 📅/времени строки события (setField), тоже
 *   одной записью. fromDate у single не используется (переносится сама строка).
 *
 * time — "HH:mm" начала (null — «Весь день»), timeEnd — конец интервала (null —
 * без конца; строго позже начала гарантирует вызыватель). Локализация — по
 * 🆔/описанию (как editEventSeries).
 */
export async function transferEventOccurrence(deps: {
	vault: EventVaultPort;
	task: Task;
	kind: "series" | "single";
	fromDate: IsoDate;
	toDate: IsoDate;
	time: string | null;
	timeEnd: string | null;
	/** Ленивый генератор 🆔 серии (тесты передают детерминированный). */
	genId?: () => string;
}): Promise<EventWriteResult> {
	const genId = deps.genId ?? defaultEventId;
	let failure: string | null = "file-not-found";
	try {
		await deps.vault.processFile(deps.task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, deps.task.filePath, deps.task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			if (deps.kind === "single") {
				// одноразовое событие: правим его собственную дату/время
				let line: string;
				try {
					line = setField(lines[idx]!, "due", deps.toDate, deps.time, deps.timeEnd);
				} catch {
					failure = "transform-failed";
					return null;
				}
				if (line === lines[idx]) return null;
				lines[idx] = line;
				return lines.join("\n");
			}
			// серия: 🚫 исходной даты + ленивый 🆔 + append одноразовой строки.
			// 🆔 читаем из САМОЙ строки (не из индекса): устойчиво к отставанию
			// индекса на окне дебаунса — не подменим уже вписанный id новым.
			let seriesLine = addExcludedDate(lines[idx]!, deps.fromDate);
			const located = parseTaskLine(lines[idx]!, {
				filePath: deps.task.filePath,
				lineStart: idx,
				parentLine: null,
				heading: null,
				container: "events",
				projectActive: true,
			});
			let seriesId = located?.taskId ?? null;
			if (seriesId === null) {
				seriesId = freshEventId(existingIds(lines, deps.task.filePath), genId);
				try {
					seriesLine = setValueField(seriesLine, "id", seriesId);
				} catch {
					failure = "transform-failed";
					return null;
				}
			}
			const single = buildSingleOccurrenceLine(
				deps.task.description,
				deps.toDate,
				deps.time,
				deps.timeEnd,
				seriesId,
			);
			if (single === null) {
				failure = "transform-failed";
				return null;
			}
			lines[idx] = seriesLine;
			return appendLine(lines.join("\n"), single);
		});
	} catch {
		return { ok: false, reason: "write-failed" };
	}
	return failure === null ? { ok: true } : { ok: false, reason: failure };
}
