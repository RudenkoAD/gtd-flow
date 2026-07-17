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
import type { ContainerKind, Task } from "../core/model/Task";
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
	/** Порядковый номер среди id-less двойников с тем же описанием в файле
	 *  (0-based, в порядке файла) — назначает индексатор. При наличии делает
	 *  адресацию content-key ДЕТЕРМИНИРОВАННОЙ: локатор берёт ровно n-ное
	 *  совпадение в файле, а не «ближайшее к lineStart». undefined — фолбэк на
	 *  lineStart-подсказку (строки вне индексатора: фикстуры, шаблоны и пр.). */
	occurrenceIndex?: number;
	/** ТОЛЬКО подсказка (advisory): фолбэк-выбор ближайшего кандидата, когда
	 *  occurrenceIndex недоступен/протух (в файле меньше совпадений, чем ждал
	 *  индекс). Не идентичность. */
	lineStart: number;
	/** Контейнер файла задачи. Нужен ЛИШЬ для распознавания поля места 📍 при
	 *  локализации: в файлах-событиях ("events") 📍 — поле (вырезано из
	 *  description), в обычных задачах — текст. Без него локатор парсил бы
	 *  строку-событие как "plain" и для id-less событий с 📍 получал бы иное
	 *  описание, чем индекс → строку не находил бы. Отсутствует ⇒ "plain".
	 *  Task структурно совместим (передаётся напрямую). */
	container?: ContainerKind;
}

/** Однострочные intents, адресуемые по key задачи. */
const KEYED_LINE_TYPES = new Set<Intent["type"]>([
	"set-date",
	"set-status",
	"set-priority",
	"move-column",
	"defer",
	"set-id",
	"set-text",
]);

/** Структурные правки требуют адресуемости строки ⇒ ленивый 🆔.
 *  set-status — не структурная (чек-офф не должен засорять строку id),
 *  set-id вставляет id сам, advance-cursor адресуется по уже существующему 🆔. */
const STRUCTURAL_TYPES = new Set<Intent["type"]>([
	"set-date",
	"set-priority",
	"move-column",
	"defer",
	// set-text меняет описание, а значит и content-key задачи: без 🆔 задача
	// после правки потеряла бы адресуемость (старый ключ умирает при реиндексе).
	"set-text",
]);

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function defaultGenId(): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += BASE36.charAt(Math.floor(Math.random() * BASE36.length));
	return s;
}

/** Парс строки файла вне индексатора: контекст файла для локализации не важен —
 *  нужны только taskId и нормализованное description. Исключение — поле места 📍:
 *  в файлах-событиях оно вырезано из description, поэтому такие строки парсим с
 *  container "events" (parseLocation), иначе id-less событие с 📍 не нашлось бы. */
function parseAt(
	lines: readonly string[],
	i: number,
	filePath: string,
	parseLocation = false,
): Task | null {
	const raw = lines[i];
	if (raw === undefined) return null;
	return parseTaskLine(raw, {
		filePath,
		lineStart: i,
		parentLine: null,
		heading: null,
		container: parseLocation ? "events" : "plain",
		projectActive: true,
	});
}

/** Индексы строк — носителей 🆔, в порядке файла (id уникален; дубли id
 *  fail-clos'ятся выше по стеку — advance-cursor/move-line). */
function idMatchIndices(
	lines: readonly string[],
	filePath: string,
	taskId: string,
	parseLocation = false,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = parseAt(lines, i, filePath, parseLocation);
		if (t !== null && t.taskId === taskId) out.push(i);
	}
	return out;
}

/** Индексы id-less строк с данным описанием, в порядке файла — популяция, по
 *  которой индексатор нумерует occurrenceIndex (та же дисциплина content-key:
 *  строка с 🆔 принадлежит id-ключу и в дубли по содержимому не входит). */
function idlessMatchIndices(
	lines: readonly string[],
	filePath: string,
	description: string,
	parseLocation = false,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = parseAt(lines, i, filePath, parseLocation);
		if (t !== null && t.taskId === null && t.description === description) out.push(i);
	}
	return out;
}

/**
 * Выбор из совпадений: детерминированно n-ное (occurrenceIndex), иначе — ближайшее
 * к advisory lineStart. occurrenceIndex вне диапазона (в файле меньше совпадений,
 * чем ждал индекс) ⇒ фолбэк на подсказку; протухание в бо́льшую сторону ловит
 * отдельная fail-closed сверка count в вызывающем коде.
 */
function pickMatch(matches: readonly number[], occurrenceIndex: number | undefined, lineStart: number): number {
	if (matches.length === 0) return -1;
	if (occurrenceIndex !== undefined && occurrenceIndex >= 0 && occurrenceIndex < matches.length) {
		return matches[occurrenceIndex]!;
	}
	let best = -1;
	let bestDist = Infinity;
	for (const i of matches) {
		const dist = Math.abs(i - lineStart);
		if (dist < bestDist) {
			best = i;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * Поиск строки задачи в актуальном содержимом (ТЗ §3):
 * 1) по 🆔, если он у задачи есть;
 * 2) иначе по content-key: строки с тем же normalizedDescription и БЕЗ 🆔
 *    (строка с 🆔 принадлежит id-ключу — захватывать её по содержимому нельзя).
 * Для двойников без 🆔 берётся ровно occurrenceIndex-ное совпадение в файле
 * (детерминизм: перетаскивание/правка второй из одинаковых задач бьёт именно во
 * вторую, а не в «ближайшую к подсказке» — lineStart дрейфует при сдвиге строк
 * выше). Нет occurrenceIndex → ближайший к advisory lineStart. Не нашли → -1.
 *
 * Экспортирован: RecurrenceService локализует строку шаблона тем же механизмом
 * (правка 🔁 не выражается через Intent — recurrence-поле текстовое).
 */
export function locateTaskLine(lines: readonly string[], filePath: string, target: LineTarget): number {
	// строки-события парсим с распознаванием 📍 — иначе их description расходится
	// с индексом (см. LineTarget.container)
	const parseLocation = target.container === "events";
	const matches =
		target.taskId !== null
			? idMatchIndices(lines, filePath, target.taskId, parseLocation)
			: idlessMatchIndices(lines, filePath, target.description, parseLocation);
	// occurrenceIndex осмыслен только для content-key (id-адресация уникальна)
	const occ = target.taskId === null ? target.occurrenceIndex : undefined;
	return pickMatch(matches, occ, target.lineStart);
}

/**
 * Локализация для УДАЛЕНИЯ строки: поверх критериев locateTaskLine кандидат
 * обязан текстуально совпадать с rawLine задачи (trimEnd: хвостовые пробелы
 * и '\r' CRLF-файлов не в счёт). Удаляем только строки, чей точный текст
 * известен (дедуп — доказуемо машинные копии): идентичные пристин-копии
 * взаимозаменяемы, поэтому «ближайшая к подсказке» безопасна, а изменённую
 * пользователем строку (кипера дедупа) текстовый фильтр не отдаст даже при
 * протухшей после сдвига строк подсказке lineStart.
 * exclude — индексы, уже занятые другими жертвами батч-удаления дедупа.
 */
export function locateExactTaskLine(
	lines: readonly string[],
	filePath: string,
	target: LineTarget & { rawLine: string },
	exclude?: ReadonlySet<number>,
): number {
	const want = target.rawLine.trimEnd();
	const parseLocation = target.container === "events"; // 📍-поле у строк-событий
	// content-key двойники: сперва детерминированно выбираем occurrenceIndex-ного
	// кандидата, ПОТОМ сверяем его текст (удаление необратимо — не бьём вслепую по
	// изменённой пользователем строке; протухшая подсказка не подсунет чужую).
	if (
		target.taskId === null &&
		target.occurrenceIndex !== undefined &&
		target.occurrenceIndex >= 0
	) {
		const matches = idlessMatchIndices(lines, filePath, target.description, parseLocation);
		if (target.occurrenceIndex >= matches.length) {
			// в файле меньше двойников, чем ждал индекс, — не угадываем, фолбэк ниже
		} else {
			const idx = matches[target.occurrenceIndex]!;
			if (exclude !== undefined && exclude.has(idx)) return -1;
			return lines[idx]!.trimEnd() === want ? idx : -1;
		}
	}
	// Фолбэк (id-адресация ЛИБО нет occurrenceIndex): среди кандидатов с ТОЧНЫМ
	// текстом строки — ближайший к advisory lineStart.
	let best = -1;
	let bestDist = Infinity;
	for (let i = 0; i < lines.length; i++) {
		if (exclude !== undefined && exclude.has(i)) continue;
		if (lines[i]!.trimEnd() !== want) continue;
		const t = parseAt(lines, i, filePath, parseLocation);
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

/** Ширина ведущего отступа строки (пробелы/табы как символы). В пределах одного
 *  файла отступ списков консистентен, поэтому сравнение длин надёжно отличает
 *  ребёнка (глубже) от родителя/сиблинга. */
function leadingWsWidth(line: string): number {
	const m = /^[ \t]*/.exec(line);
	return m !== null ? m[0].length : 0;
}

/** Длина вложенного блока задачи на строке idx: сколько непосредственно
 *  следующих строк имеют отступ СТРОГО глубже родительского. Останов на первой
 *  строке с отступом ≤ родительского ИЛИ на пустой строке (см. deleteLine:
 *  консервативно, чтобы не срезать лишнее необратимо). */
function childBlockLength(lines: readonly string[], idx: number): number {
	const parentIndent = leadingWsWidth(lines[idx]!);
	let n = 0;
	for (let i = idx + 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") break; // пустая строка завершает блок
		if (leadingWsWidth(line) <= parentIndent) break; // не глубже — не ребёнок
		n++;
	}
	return n;
}

/** Сколько id-less строк с этим описанием в содержимом файла (для сверки
 *  content-key локализации со знанием индекса — fail-closed при расхождении). */
function countIdlessMatches(lines: readonly string[], filePath: string, description: string): number {
	let n = 0;
	for (let i = 0; i < lines.length; i++) {
		const t = parseAt(lines, i, filePath);
		if (t !== null && t.taskId === null && t.description === description) n++;
	}
	return n;
}

export class WritebackService implements IntentDispatcher {
	private readonly genId: () => string;

	/**
	 * Короткоживущая память «key → только что вписанный нами 🆔»: между
	 * структурной правкой (ленивая вставка id) и догоняющим реиндексом
	 * (дебаунс ~150мс) индекс отдаёт задачу ещё БЕЗ taskId, а строка в файле
	 * id уже несёт — content-key локализация её принципиально не видит
	 * (строка с 🆔 принадлежит id-ключу). Запомненный id даёт точную адресацию
	 * следующих правок вместо fail-closed отказа 'stale-index'. Запись
	 * чистится, как только индекс догнал (у задачи появился taskId) или ключ
	 * исчез из индекса (реиндекс переименовал его в "id:<🆔>").
	 */
	private readonly injectedIds = new Map<string, string>();

	constructor(private readonly deps: WritebackDeps) {
		this.genId = deps.genId ?? defaultGenId;
	}

	/**
	 * 🆔 задачи с учётом памяти вписанных в окне дебаунса реиндексации:
	 * индекс может ещё не знать id, который мы только что записали в строку.
	 * Нужен BoardService (фаза порядка после drag) и подобным потребителям.
	 */
	knownTaskId(key: string): string | null {
		const task = this.deps.feed.getIndex().get(key);
		return task?.taskId ?? this.injectedIds.get(key) ?? null;
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
		if (task === undefined) {
			this.injectedIds.delete(intent.key); // реиндекс переименовал ключ — память не нужна
			return { ok: false, reason: "task-not-found" };
		}
		if (task.taskId !== null) this.injectedIds.delete(intent.key); // индекс догнал

		// Строка уже несёт 🆔, вписанный нами в окне дебаунса, — адресуемся по нему
		// вместо content-key (см. injectedIds).
		const remembered = task.taskId === null ? (this.injectedIds.get(intent.key) ?? null) : null;

		let injectId: string | null = null;
		if (
			task.taskId === null &&
			remembered === null &&
			this.deps.autoInjectId &&
			STRUCTURAL_TYPES.has(intent.type)
		) {
			injectId = this.freshId();
			if (injectId === null) return { ok: false, reason: "id-collision" };
		}

		const target: LineTarget =
			remembered !== null
				? { taskId: remembered, description: task.description, lineStart: task.lineStart }
				: task;
		const res = await this.applyToLine(task.filePath, target, intent, injectId);
		if (res.ok) {
			// запомнить id, который строка теперь несёт, — для правок до реиндекса
			if (injectId !== null) this.injectedIds.set(intent.key, injectId);
			else if (intent.type === "set-id" && task.taskId === null)
				this.injectedIds.set(intent.key, intent.taskId);
		}
		return res;
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
		// Fail-closed для content-key при протухшем индексе (ленивый 🆔 в окне
		// дебаунса ~150мс): число id-less строк с этим описанием в файле обязано
		// совпадать со знанием индекса НА МОМЕНТ dispatch — расхождение значит,
		// что «ближайший кандидат» может оказаться чужой задачей-двойником.
		// Тогда не пишем вовсе (ТЗ §3); повтор после реиндекса адресуется по 🆔.
		const expectedIdless =
			target.taskId === null ? this.countIdlessInIndex(path, target.description) : -1;
		let failure: string | null = "file-not-found"; // transform не вызван ⇒ файла нет
		await this.deps.write.processFile(path, (content) => {
			failure = null;
			const lines = content.split("\n"); // CRLF: '\r' остаётся в строке, tokenizer его бережёт
			const idx = locateTaskLine(lines, path, target);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			if (
				target.taskId === null &&
				countIdlessMatches(lines, path, target.description) !== expectedIdless
			) {
				failure = "stale-index";
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
		if (task === undefined) {
			this.injectedIds.delete(intent.key);
			return { ok: false, reason: "task-not-found" };
		}
		if (task.taskId !== null) this.injectedIds.delete(intent.key);

		// 🆔, уже вписанный нами в окне дебаунса, — переносим по нему (см.
		// injectedIds); это же даёт сходимость повтора после сбоя шагов 2/3.
		const knownId = task.taskId ?? this.injectedIds.get(intent.key) ?? null;
		const needInject = knownId === null;
		let movedId: string;
		if (knownId === null) {
			const fresh = this.freshId();
			if (fresh === null) return { ok: false, reason: "id-collision" };
			movedId = fresh;
		} else {
			movedId = knownId;
		}

		// Шаг 1: локализация в источнике; при необходимости — запись 🆔.
		// Content-key сверяется со знанием индекса (см. applyToLine): протухший
		// индекс не должен утащить в перенос чужую строку-двойника.
		const locTarget: LineTarget = {
			taskId: knownId,
			description: task.description,
			// детерминизм для двойников без 🆔: переносим ровно свою из одинаковых
			occurrenceIndex: task.occurrenceIndex,
			lineStart: task.lineStart,
		};
		const expectedIdless =
			knownId === null ? this.countIdlessInIndex(task.filePath, task.description) : -1;
		let captured: string | null = null;
		let failure: string | null = "file-not-found";
		await this.deps.write.processFile(task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, task.filePath, locTarget);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			if (
				knownId === null &&
				countIdlessMatches(lines, task.filePath, task.description) !== expectedIdless
			) {
				failure = "stale-index";
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
		// 🆔 уже в источнике — запоминаем до реиндекса (повтор move-line после
		// сбоя шагов 2/3 адресуется по нему и сходится)
		if (needInject) this.injectedIds.set(intent.key, movedId);
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

	// --- удаление строки (дедуп регулярных ТЗ §3/§6 + «Удалить» из меню) ---

	/**
	 * Удалить строку задачи (вместе с её '\n'): локализация СТРОЖЕ, чем у правок,
	 * — поверх 🆔/content-key кандидат обязан текстуально совпадать с rawLine
	 * задачи (locateExactTaskLine): протухшая после сдвига строк подсказка
	 * lineStart не подсунет под нож изменённую пользователем строку — удаление
	 * необратимо, правки хотя бы видимы. Для двойников без 🆔 берётся ровно
	 * occurrenceIndex-ный носитель (детерминизм: «Удалить» на второй из
	 * одинаковых убирает именно вторую). splice по массиву строк съедает и
	 * разделитель: удаление последней строки без хвостового '\n' забирает
	 * разделитель СЛЕВА — файл не копит пустых строк. Повторный dispatch после
	 * успеха даёт {ok:false,'line-not-found'} — для дедупа это штатный исход.
	 *
	 * withChildren (пункт меню «Удалить»): вместе со строкой убирается её
	 * вложенный блок — непосредственно следующие строки С БО́ЛЬШИМ отступом
	 * (дети списка), до первой строки с отступом ≤ родительского или до пустой
	 * строки. Так «Удалить» уносит визуально принадлежащий задаче под-блок
	 * (заметки/подпункты), а не оставляет сирот. Пустая строка ЗАВЕРШАЕТ блок —
	 * консервативно: лучше оставить сироту (поправимо), чем срезать лишнее
	 * (необратимо). Дедуп (withChildren не задан) удаляет РОВНО одну строку —
	 * машинные копии бездетны, семантика §6 не меняется.
	 */
	private async deleteLine(intent: { key: string; withChildren?: boolean }): Promise<IntentResult> {
		const task = this.deps.feed.getIndex().get(intent.key);
		if (task === undefined) return { ok: false, reason: "task-not-found" };

		const expectedIdless =
			task.taskId === null ? this.countIdlessInIndex(task.filePath, task.description) : -1;
		let failure: string | null = "file-not-found";
		await this.deps.write.processFile(task.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateExactTaskLine(lines, task.filePath, task);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			// та же fail-closed сверка content-key, что и в applyToLine
			if (
				task.taskId === null &&
				countIdlessMatches(lines, task.filePath, task.description) !== expectedIdless
			) {
				failure = "stale-index";
				return null;
			}
			const count = intent.withChildren === true ? 1 + childBlockLength(lines, idx) : 1;
			lines.splice(idx, count);
			return lines.join("\n");
		});
		return failure === null ? { ok: true } : { ok: false, reason: failure };
	}

	/** Сколько id-less задач с этим описанием знает индекс для файла —
	 *  «ожидание» для fail-closed сверки content-key локализации. */
	private countIdlessInIndex(path: string, description: string): number {
		let n = 0;
		for (const t of this.deps.feed.getIndex().fileTasks(path)) {
			if (t.taskId === null && t.description === description) n++;
		}
		return n;
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
