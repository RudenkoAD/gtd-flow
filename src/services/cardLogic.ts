/**
 * Чистая логика заметок-карточек (ТЗ §4): имя файла, содержимое-заготовка,
 * вставка [[ссылки]] в строку задачи, прогресс чеклиста.
 *
 * Ноль импортов obsidian — тестируется в голом node. Потребитель — CardService.
 */
import type { Task } from "../core/model/Task";
import { ALL_FIELD_EMOJI } from "../core/parser/emoji";
import { serializeTokens, tokenizeTaskLine } from "../core/parser/tokenizer";

/**
 * Символы, запрещённые в именах файлов Windows (\ / : * ? " < > |) и/или
 * ломающие [[ссылки]] Obsidian (# ^ [ ]). Заменяются пробелом; управляющие
 * символы (код < 32) вычищаются отдельным проходом в sanitizeCardName —
 * без числовых escape в регулярке.
 */
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|#^\[\]]/g;

/** Предел длины описательной части имени файла карточки (ТЗ §4: «~60 симв.»). */
export const MAX_CARD_NAME_LEN = 60;

/** Управляющие символы (код < 32) → пробел; NUL в имени файла недопустим. */
function stripControlChars(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		out += text.charCodeAt(i) < 32 ? " " : text.charAt(i);
	}
	return out;
}

/**
 * Очистка текста для имени файла: запрещённые/управляющие символы → пробел,
 * схлопывание пробелов, обрезка до maxLen. Хвостовые пробелы/точки срезаются
 * ПОСЛЕ обрезки — Windows не терпит имена, оканчивающиеся на точку или пробел.
 */
export function sanitizeCardName(text: string, maxLen: number = MAX_CARD_NAME_LEN): string {
	const cleaned = stripControlChars(text)
		.replace(FORBIDDEN_NAME_CHARS, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.slice(0, maxLen).replace(/[ .]+$/, "");
}

/**
 * Имя файла карточки: "<🆔> <очищенное описание>.md"; пустое описание — "<🆔>.md".
 * 🆔 прогоняется через ту же очистку (пользовательский id может содержать
 * запрещённые символы); полностью «съеденный» id заменяется литералом "card" —
 * идентичность карточки живёт во frontmatter, а не в имени файла.
 */
export function cardFileName(taskId: string, description: string): string {
	const id = sanitizeCardName(taskId) || "card";
	const name = sanitizeCardName(description);
	return name === "" ? `${id}.md` : `${id} ${name}.md`;
}

/** Путь карточки в папке настроек; пустая папка ⇒ корень vault. */
export function cardPath(cardsFolder: string, fileName: string): string {
	const folder = cardsFolder.trim().replace(/^\/+|\/+$/g, "");
	return folder === "" ? fileName : `${folder}/${fileName}`;
}

/**
 * Содержимое новой карточки: frontmatter gtd-card-of (распознаётся
 * fileContextFromFrontmatter как container 'card' ⇒ DETAIL §1) + заголовок +
 * заготовка чеклиста "- [ ] ". Id в кавычках: голый числовой id YAML прочитал
 * бы числом, а символы вроде ':' сломали бы парсинг; JSON-строка — валидный
 * YAML-скаляр с тем же значением.
 */
export function buildCardContent(taskId: string, description: string): string {
	const heading = description.trim() === "" ? taskId : description.trim();
	return `---\ngtd-card-of: ${JSON.stringify(taskId)}\n---\n\n# ${heading}\n\n- [ ] \n`;
}

/**
 * Вставить " [[noteName]]" в строку задачи ПЕРЕД первым эмодзи-полем
 * (ТЗ §4, cardLinkInLine): ссылка — часть текста описания, как тег; дописанная
 * в конец строки она была бы проглочена payload'ом 🔁 или приклеена к 🆔.
 * Механика повторяет addTag: вставка в конец текстового префикса, до его
 * хвостовых пробелов (они разделяют первое поле).
 *
 * Идемпотентность: ссылка уже есть в любом текстовом сегменте → строка
 * возвращается без изменений (вызывающий сравнивает по ===). Имя с эмодзи
 * поля (пользователь переименовал карточку в «📅 план») вставлять НЕЛЬЗЯ —
 * токен поля посреди описания сломал бы парс и повторное обнаружение дубля —
 * тоже возврат без изменений. null — строка не является задачей.
 */
export function insertCardLink(rawLine: string, noteName: string): string | null {
	const t = tokenizeTaskLine(rawLine);
	if (t === null) return null;
	for (const e of ALL_FIELD_EMOJI) {
		if (noteName.includes(e)) return rawLine;
	}
	const link = `[[${noteName}]]`;
	for (const seg of t.segments) {
		if (seg.kind === "text" && seg.text.includes(link)) return rawLine;
	}
	const first = t.segments[0];
	if (first === undefined) {
		t.segments.push({ kind: "text", text: ` ${link}` });
	} else if (first.kind === "text") {
		// вставка перед хвостовыми пробелами префикса — они разделяют первое поле
		const m = /\s*$/.exec(first.text)!;
		first.text = `${first.text.slice(0, m.index)} ${link}${first.text.slice(m.index)}`;
	} else {
		// защитный случай: строка начинается сразу с поля (после ']' нет текста)
		t.segments.unshift({ kind: "text", text: ` ${link}` });
	}
	return serializeTokens(t);
}

/**
 * Прогресс чеклиста карточки (ТЗ §4): done — статус x/X, total — все чек-строки.
 * CANCELLED ('-') и DOING ('/') входят в total, но не в done.
 */
export function checklistProgress(tasks: readonly Pick<Task, "statusChar">[]): {
	done: number;
	total: number;
} {
	let done = 0;
	for (const t of tasks) {
		if (t.statusChar === "x" || t.statusChar === "X") done++;
	}
	return { done, total: tasks.length };
}
