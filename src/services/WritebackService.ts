/**
 * WritebackService (ТЗ §3): единственная точка записи intents в файлы.
 * Виды порождают Intent → dispatch() находит строку в актуальном содержимом
 * файла (сначала по 🆔, иначе по content-key + ближайшая к подсказке lineStart)
 * и применяет resolveLineTransform атомарно внутри WritePort.processFile.
 * Не нашли строку / трансформ упал — ноль записей и {ok:false}.
 *
 * Ноль импортов obsidian: запись идёт через структурный порт WritePort,
 * совместимый с VaultAdapter.processFile.
 */
import type { Intent } from "../core/intents/Intent";
import { resolveLineTransform } from "../core/intents/resolveIntent";
import type { Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { setValueField } from "../core/parser/serializeTaskLine";
import type { IndexFeed } from "./types";

export type IntentResult = { ok: true } | { ok: false; reason: string };

export interface IntentDispatcher {
	dispatch(intent: Intent): Promise<IntentResult>;
}

/** Структурно совместим с VaultAdapter.processFile — адаптер сюда не импортируем. */
export interface WritePort {
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
}

export interface WritebackDeps {
	write: WritePort;
	feed: IndexFeed;
	/** Ленивая вставка 🆔 при первой структурной правке (settings.autoInjectId). */
	autoInjectId: boolean;
	/** Генератор 🆔; по умолчанию 6 символов base36. */
	genId?: () => string;
}

/** Всё, что нужно для локализации строки: 🆔, нормализованное описание, подсказка. */
export interface LineTarget {
	taskId: string | null;
	description: string;
	/** ТОЛЬКО подсказка (advisory): выбор ближайшего кандидата, не идентичность. */
	lineStart: number;
}

/** Однострочные intents, адресуемые по key задачи. */
const KEYED_LINE_TYPES = new Set<Intent["type"]>([
	"set-date",
	"set-status",
	"set-priority",
	"move-column",
	"defer",
	"set-id",
]);

/** Структурные правки требуют адресуемости строки ⇒ ленивый 🆔.
 *  set-status — не структурная (чек-офф не должен засорять строку id),
 *  set-id вставляет id сам, advance-cursor адресуется по уже существующему 🆔. */
const STRUCTURAL_TYPES = new Set<Intent["type"]>([
	"set-date",
	"set-priority",
	"move-column",
	"defer",
]);

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function defaultGenId(): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += BASE36.charAt(Math.floor(Math.random() * BASE36.length));
	return s;
}

/** Парс строки файла вне индексатора: контекст файла для локализации не важен —
 *  нужны только taskId и нормализованное description. */
function parseAt(lines: readonly string[], i: number, filePath: string): Task | null {
	const raw = lines[i];
	if (raw === undefined) return null;
	return parseTaskLine(raw, {
		filePath,
		lineStart: i,
		parentLine: null,
		heading: null,
		container: "plain",
		projectActive: true,
	});
}

/**
 * Поиск строки задачи в актуальном содержимом (ТЗ §3):
 * 1) по 🆔, если он у задачи есть;
 * 2) иначе по content-key: строки с тем же normalizedDescription и БЕЗ 🆔
 *    (строка с 🆔 принадлежит id-ключу — захватывать её по содержимому нельзя).
 * Из нескольких кандидатов — ближайший к advisory lineStart. Не нашли → -1.
 *
 * Экспортирован: RecurrenceService локализует строку шаблона тем же механизмом
 * (правка 🔁 не выражается через Intent — recurrence-поле текстовое).
 */
export function locateTaskLine(lines: readonly string[], filePath: string, target: LineTarget): number {
	let best = -1;
	let bestDist = Infinity;
	for (let i = 0; i < lines.length; i++) {
		const t = parseAt(lines, i, filePath);
		if (t === null) continue;
		const hit =
			target.taskId !== null
				? t.taskId === target.taskId
				: t.taskId === null && t.description === target.description;
		if (!hit) continue;
		const dist = Math.abs(i - target.lineStart);
		if (dist < bestDist) {
			best = i;
			bestDist = dist;
		}
	}
	return best;
}

export class WritebackService implements IntentDispatcher {
	private readonly genId: () => string;

	constructor(private readonly deps: WritebackDeps) {
		this.genId = deps.genId ?? defaultGenId;
	}

	async dispatch(intent: Intent): Promise<IntentResult> {
		try {
			if (KEYED_LINE_TYPES.has(intent.type)) {
				// сужение через has() TS не выводит — но у всех KEYED_LINE_TYPES есть key
				return await this.dispatchKeyedLine(intent as Intent & { key: string });
			}
			switch (intent.type) {
				case "advance-cursor":
					return await this.dispatchCursor(intent.templateId, intent);
				case "move-line":
					return await this.moveLine(intent);
				case "delete-line":
					return await this.deleteLine(intent);
				default:
					// spawn-instances/reorder/графовые — этапы 4–7
					return { ok: false, reason: "not-implemented-stage" };
			}
		} catch {
			// отказ самой записи (WritePort бросил) — контракт IntentResult не рвём
			return { ok: false, reason: "write-failed" };
		}
	}

	// --- однострочные intents ---

	private async dispatchKeyedLine(intent: Intent & { key: string }): Promise<IntentResult> {
		const task = this.deps.feed.getIndex().get(intent.key);
		if (task === undefined) return { ok: false, reason: "task-not-found" };

		let injectId: string | null = null;
		if (task.taskId === null && this.deps.autoInjectId && STRUCTURAL_TYPES.has(intent.type)) {
			injectId = this.freshId();
			if (injectId === null) return { ok: false, reason: "id-collision" };
		}
		return this.applyToLine(task.filePath, task, intent, injectId);
	}

	private async dispatchCursor(templateId: string, intent: Intent): Promise<IntentResult> {
		const carriers = this.deps.feed.getIndex().resolveDep(templateId);
		if (carriers.length === 0) return { ok: false, reason: "task-not-found" };
		// fail-closed: при дублях 🆔 непонятно, чей курсор двигать — не пишем
		if (carriers.length > 1) return { ok: false, reason: "duplicate-id" };
		const t = carriers[0]!;
		return this.applyToLine(t.filePath, t, intent, null);
	}

	/**
	 * Атомарная правка одной строки: локализация и трансформ — внутри transform,
	 * на актуальном содержимом. Ленивый 🆔 и основная правка — одна запись.
	 */
	private async applyToLine(
		path: string,
		target: LineTarget,
		intent: Intent,
		injectId: string | null,
	): Promise<IntentResult> {
		let failure: string | null = "file-not-found"; // transform не вызван ⇒ файла нет
		await this.deps.write.processFile(path, (content) => {
			failure = null;
			const lines = content.split("\n"); // CRLF: '\r' остаётся в строке, tokenizer его бережёт
			const idx = locateTaskLine(lines, path, target);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			let line = lines[idx]!;
			try {
				if (injectId !== null) line = setValueField(line, "id", injectId);
				const next = resolveLineTransform(intent, line);
				if (next === null) {
					failure = "transform-failed";
					return null;
				}
				line = next;
			} catch {
				failure = "transform-failed";
				return null;
			}
			if (line === lines[idx]) return null; // no-op: успех без записи (идемпотентность)
			lines[idx] = line;
			return lines.join("\n");
		});
		return failure === null ? { ok: true } : { ok: false, reason: failure };
	}

	// --- перенос строки между файлами ---

	/**
	 * append в цель → delete из источника (ТЗ §3): сбой посередине оставляет
	 * ДУБЛЬ (оба носителя одного 🆔 видны линтом byId), потеря строки исключена.
	 * Перед append — 🆔 в исходную строку отдельной записью (независимо от
	 * autoInjectId: переносимая строка ОБЯЗАНА быть адресуемой, иначе дубль
	 * при сбое невидим, а delete нечем якорить). Повторный dispatch идемпотентен:
	 * append пропускается, если 🆔 уже есть в целевом файле.
	 */
	private async moveLine(intent: { key: string; toFile: string }): Promise<IntentResult> {
		const task = this.deps.feed.getIndex().get(intent.key);
		if (task === undefined) return { ok: false, reason: "task-not-found" };

		const needInject = task.taskId === null;
		let movedId: string;
		if (needInject) {
			const fresh = this.freshId();
			if (fresh === null) return { ok: false, reason: "id-collision" };
			movedId = fresh;
		} else {
			movedId = task.taskId!;
		}

		// Шаг 1: локализация в источнике; при необходимости — запись 🆔.
		let captured: string | null = null;
		let failure: string | null = "file-not-found";
		await this.deps.write.processFile(task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, task.filePath, task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			let line = lines[idx]!;
			if (!needInject) {
				captured = line;
				return null; // только чтение — содержимое не меняем
			}
			try {
				line = setValueField(line, "id", movedId);
			} catch {
				failure = "transform-failed";
				return null;
			}
			captured = line;
			lines[idx] = line;
			return lines.join("\n");
		});
		if (failure !== null) return { ok: false, reason: failure };
		const movedLine = captured!;

		// Шаг 2: append в цель; 🆔 уже там → пропуск (идемпотентность повтора).
		let targetSeen = false;
		await this.deps.write.processFile(intent.toFile, (content) => {
			targetSeen = true;
			const lines = content.split("\n");
			if (locateTaskLine(lines, intent.toFile, { taskId: movedId, description: "", lineStart: 0 }) !== -1)
				return null;
			return content.trimEnd()
				? content + (content.endsWith("\n") ? "" : "\n") + movedLine + "\n"
				: movedLine + "\n";
		});
		if (!targetSeen) return { ok: false, reason: "file-not-found" };

		// Шаг 3: удалить из источника — теперь строго по 🆔.
		let delFailure: string | null = "file-not-found";
		await this.deps.write.processFile(task.filePath, (content) => {
			delFailure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, task.filePath, {
				taskId: movedId,
				description: task.description,
				lineStart: task.lineStart,
			});
			if (idx === -1) {
				delFailure = "line-not-found";
				return null;
			}
			lines.splice(idx, 1);
			return lines.join("\n");
		});
		return delFailure === null ? { ok: true } : { ok: false, reason: delFailure };
	}

	// --- удаление строки (ТОЛЬКО дедуп регулярных, ТЗ §3/§6) ---

	/**
	 * Удалить ровно одну строку (вместе с её '\n'): локализация тем же
	 * механизмом, что у правок (🆔, иначе content-key + ближайшая lineStart).
	 * splice по массиву строк съедает и разделитель: удаление последней строки
	 * без хвостового '\n' забирает разделитель СЛЕВА — файл не копит пустых строк.
	 * Повторный dispatch после успеха даёт {ok:false,'line-not-found'} —
	 * для дедупа это штатный исход: строки уже нет, удалять нечего.
	 */
	private async deleteLine(intent: { key: string }): Promise<IntentResult> {
		const task = this.deps.feed.getIndex().get(intent.key);
		if (task === undefined) return { ok: false, reason: "task-not-found" };

		let failure: string | null = "file-not-found";
		await this.deps.write.processFile(task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, task.filePath, task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			lines.splice(idx, 1);
			return lines.join("\n");
		});
		return failure === null ? { ok: true } : { ok: false, reason: failure };
	}

	// --- генерация 🆔 ---

	/** Свежий id: коллизии проверяем по индексу (resolveDep — все носители). */
	private freshId(): string | null {
		for (let attempt = 0; attempt < 32; attempt++) {
			const id = this.genId();
			if (this.deps.feed.getIndex().resolveDep(id).length === 0) return id;
		}
		return null; // генератор зациклился на занятых id — не пишем
	}
}
