/**
 * Логика повторяющихся событий календаря (§события): построение и правка строки
 * серии, разбор/сборка хвоста времени "at HH:mm", создание и редактирование
 * серии через структурные порты. Ноль импортов obsidian — тестируется в node;
 * запись идёт через порт, совместимый с VaultAdapter.
 */
import type { Task } from "../../core/model/Task";
import { VALUE_FIELD_EMOJI } from "../../core/parser/emoji";
import { setDescription } from "../../core/parser/serializeTaskLine";
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

/** Строка новой серии: `- [ ] <name> 🔁 <ruleText>`. Пустое имя — null (не пишем). */
export function buildEventLine(name: string, ruleText: string): string | null {
	const n = name.replace(/\s+/g, " ").trim();
	if (n === "") return null;
	return `- [ ] ${n} 🔁 ${ruleText.trim()}`;
}

/**
 * Атомарная правка строки серии: название через setDescription + payload 🔁
 * через токенизатор — ОДНОЙ трансформацией (не два intent'а). null — строка не
 * задача либо название содержит эмодзи поля (setDescription бросает — ловим).
 */
export function editEventLine(rawLine: string, name: string, ruleText: string): string | null {
	const n = name.replace(/\s+/g, " ").trim();
	if (n === "") return null;
	let line: string;
	try {
		line = setDescription(rawLine, n);
	} catch {
		return null; // эмодзи поля в названии — недопустимо
	}
	return setRecurrencePayload(line, ruleText.trim());
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
}): Promise<EventWriteResult> {
	if (isParseError(parseRule(deps.ruleText))) return { ok: false, reason: "invalid-rule" };
	const line = buildEventLine(deps.name, deps.ruleText);
	if (line === null) return { ok: false, reason: "empty-name" };
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
 * Правка серии: локализация строки (по 🆔/описанию, как WritebackService) и
 * атомарная замена названия+правила ОДНОЙ трансформацией. Правило валидируется
 * parseRule до записи.
 */
export async function editEventSeries(deps: {
	vault: EventVaultPort;
	task: Task;
	name: string;
	ruleText: string;
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
			const next = editEventLine(lines[idx]!, deps.name, deps.ruleText);
			if (next === null) {
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
