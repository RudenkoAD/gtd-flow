/**
 * Стабильный ключ задачи (ТЗ §2, model v1):
 * 'id:<🆔>' при наличии id, иначе content-key
 * '<filePath>#<fnv1a(normalizedDescription) hex>#<occurrenceIndex>'.
 * occurrenceIndex дизамбигуирует одинаковые строки в одном файле — его
 * назначает индексатор в порядке следования по файлу.
 */
import { tokenizeSegments, tokenizeTaskLine } from "./tokenizer";

/** 32-битный FNV-1a по UTF-8 байтам — стабилен между платформами и раскладками. */
export function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) {
			h = mix(h, cp);
		} else if (cp < 0x800) {
			h = mix(h, 0xc0 | (cp >> 6));
			h = mix(h, 0x80 | (cp & 0x3f));
		} else if (cp < 0x10000) {
			h = mix(h, 0xe0 | (cp >> 12));
			h = mix(h, 0x80 | ((cp >> 6) & 0x3f));
			h = mix(h, 0x80 | (cp & 0x3f));
		} else {
			h = mix(h, 0xf0 | (cp >> 18));
			h = mix(h, 0x80 | ((cp >> 12) & 0x3f));
			h = mix(h, 0x80 | ((cp >> 6) & 0x3f));
			h = mix(h, 0x80 | (cp & 0x3f));
		}
	}
	return h >>> 0;
}

function mix(h: number, byte: number): number {
	// FNV-1a: xor, затем умножение на простое 16777619 в 32-битной арифметике
	return Math.imul(h ^ byte, 0x01000193);
}

/**
 * Нормализация описания для content-key: токены полей вырезаны, пробелы
 * схлопнуты, trim. Принимает и полную строку задачи, и голое описание —
 * результат совпадает с Task.description после parseTaskLine.
 */
export function normalizeDescription(input: string): string {
	const line = tokenizeTaskLine(input);
	const segments = line !== null ? line.segments : tokenizeSegments(input);
	let text = "";
	for (const s of segments) if (s.kind === "text") text += s.text;
	return text.replace(/\s+/g, " ").trim();
}

/** Структурно совместим с Task — computeKey(task) работает напрямую. */
export interface TaskKeySource {
	taskId: string | null;
	filePath: string;
	/** Описание или сырой текст — будет нормализовано. */
	description: string;
}

export function computeKey(src: TaskKeySource, occurrenceIndex = 0): string {
	if (src.taskId !== null && src.taskId !== "") return `id:${src.taskId}`;
	const hash = fnv1a(normalizeDescription(src.description)).toString(16).padStart(8, "0");
	return `${src.filePath}#${hash}#${occurrenceIndex}`;
}
