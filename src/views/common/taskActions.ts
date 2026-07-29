/**
 * Чистые помощники действий паритета без drag (ТЗ §8, слой 3): санитация
 * быстрого ввода, поиск задачи под курсором, «Сделать шаблоном…».
 * Ноль импортов obsidian — тестируется в голом node; запись идёт через
 * структурные порты, совместимые с VaultAdapter, и IntentDispatcher.
 */
import type { IsoDate, Task } from "../../core/model/Task";
import { parseNlDate } from "../../core/parser/nlDate";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import { setField } from "../../core/parser/serializeTaskLine";
import type { IntentDispatcher, IntentResult } from "../../services/WritebackService";
import { dayOfWeekSun0 } from "./dates";

// ---------------------------------------------------------------------------
// Быстрый ввод
// ---------------------------------------------------------------------------

/**
 * Строка захвата `- [ ] <текст>` для «Быстрый ввод во входящие».
 * Санитация: схлопнуть пробелы/переводы строк (многострочный ввод развалил бы
 * файл), срезать уже набранный пользователем префикс задачи (`- [x] ` и т.п.) —
 * иначе получился бы двойной чекбокс. Пусто после чистки — null (не пишем).
 */
export function quickCaptureLine(text: string): string | null {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed === "") return null;
	const body = collapsed.replace(/^[-*+]\s+\[.\]\s*/, "").trim();
	if (body === "") return null;
	return `- [ ] ${body}`;
}

// ---------------------------------------------------------------------------
// NLP-даты в быстром вводе («завтра в 15 позвонить маме» → 📅 <завтра> 15:00)
// ---------------------------------------------------------------------------

/** Разложить 'HH:mm' | 'HH:mm-HH:mm' на пару начало/конец для setField. */
function splitNlTime(time: string | null): { time: string | null; timeEnd: string | null } {
	if (time === null) return { time: null, timeEnd: null };
	const dash = time.indexOf("-");
	if (dash === -1) return { time, timeEnd: null };
	return { time: time.slice(0, dash), timeEnd: time.slice(dash + 1) };
}

/** Дописать 📅 <дата>[ время] в строку захвата (ядро setField). Битая пара
 *  времени не роняет захват — тогда пишем только дату. */
function applyNlCapture(line: string, date: IsoDate, time: string | null): string {
	const { time: t, timeEnd } = splitNlTime(time);
	try {
		return setField(line, "due", date, t, timeEnd);
	} catch {
		try {
			return setField(line, "due", date);
		} catch {
			return line;
		}
	}
}

/**
 * Быстрый ввод с распознаванием русских дат: прогнать parseNlDate(text, today) и,
 * если распознано датное выражение, вернуть `- [ ] <title>` с полем 📅 (+время).
 * today === null отключает NLP (полное соответствие старому quickCaptureLine —
 * для календарной сетки, где дата/время уже из слота). Пустой title → null.
 * Escape-путь: датное слово в кавычках («"завтра"») → кавычки снимаются, дата НЕ
 * ставится (parseNlDate вернёт date: null).
 */
export function quickCaptureLineNl(text: string, today: IsoDate | null): string | null {
	if (today === null) return quickCaptureLine(text);
	const res = parseNlDate(text, today);
	const base = quickCaptureLine(res !== null ? res.title : text);
	if (base === null) return null;
	if (res === null || res.date === null) return base;
	return applyNlCapture(base, res.date, res.time);
}

const NL_WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;
const NL_MONTHS_SHORT = [
	"янв",
	"фев",
	"мар",
	"апр",
	"май",
	"июн",
	"июл",
	"авг",
	"сен",
	"окт",
	"ноя",
	"дек",
] as const;

/**
 * Живая подсказка распознанной даты для поля быстрого ввода: «📅 чт 15 авг · 15:00»
 * (интервал через en-dash — консистентно с agendaTimeLabel). null — если дата не
 * распознана (или сработал только escape): подсказку не показываем.
 */
export function nlCaptureHint(text: string, today: IsoDate): string | null {
	const res = parseNlDate(text, today);
	if (res === null || res.date === null) return null;
	const wd = NL_WEEKDAYS_SHORT[dayOfWeekSun0(res.date)] ?? "?";
	const day = Number(res.date.slice(8, 10));
	const mon = NL_MONTHS_SHORT[Number(res.date.slice(5, 7)) - 1] ?? "?";
	let label = `📅 ${wd} ${day} ${mon}`;
	if (res.time !== null) {
		const dash = res.time.indexOf("-");
		const timeLabel =
			dash === -1 ? res.time : `${res.time.slice(0, dash)}–${res.time.slice(dash + 1)}`;
		label += ` · ${timeLabel}`;
	}
	return label;
}

// ---------------------------------------------------------------------------
// Задача под курсором (команды редактора — главный паритет для мобильных)
// ---------------------------------------------------------------------------

/**
 * Задача индекса, соответствующая строке редактора: та же дисциплина, что
 * locateTaskLine в WritebackService, но в обратную сторону (строка → задача):
 * по 🆔, иначе по описанию среди задач БЕЗ 🆔; из нескольких кандидатов —
 * ближайшая к номеру строки. Строка не задача / нет совпадения — null
 * (индекс мог ещё не догнать правку — вызывающий показывает Notice).
 */
export function findTaskAtLine(
	tasks: readonly Task[],
	rawLine: string,
	filePath: string,
	lineNo: number,
): Task | null {
	const parsed = parseTaskLine(rawLine, {
		filePath,
		lineStart: lineNo,
		parentLine: null,
		heading: null,
		container: "plain",
		projectActive: true,
	});
	if (parsed === null) return null;
	let best: Task | null = null;
	let bestDist = Infinity;
	for (const t of tasks) {
		const hit =
			parsed.taskId !== null
				? t.taskId === parsed.taskId
				: t.taskId === null && t.description === parsed.description;
		if (!hit) continue;
		const dist = Math.abs(t.lineStart - lineNo);
		if (dist < bestDist) {
			best = t;
			bestDist = dist;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// «Сделать шаблоном…» — move-line в первый gtd-recurring файл (или создание)
// ---------------------------------------------------------------------------

/** Пути всех gtd-recurring файлов из живого индекса (уникальные, сортированные). */
export function recurringFilePaths(tasks: Iterable<Task>): string[] {
	const paths = new Set<string>();
	for (const t of tasks) {
		if (t.container === "recurring") paths.add(t.filePath);
	}
	return [...paths].sort();
}

export interface TemplateTarget {
	path: string;
	/** Файла-шаблонов ещё нет — создать с frontmatter gtd-recurring. */
	create: boolean;
}

/**
 * Куда переносить шаблон: первый (по сортировке) существующий gtd-recurring
 * файл, иначе `<папка GTD>/Recurring.md` — папку берём у spawnTarget настроек
 * (это и есть «домашняя» папка GTD пользователя).
 */
export function recurringTemplateTarget(
	recurringFiles: readonly string[],
	spawnTarget: string,
): TemplateTarget {
	const existing = recurringFiles[0];
	if (existing !== undefined) return { path: existing, create: false };
	const dir = spawnTarget.split("/").slice(0, -1).join("/");
	return { path: dir === "" ? "Recurring.md" : `${dir}/Recurring.md`, create: true };
}

/** Структурный порт «создать файл + править frontmatter»; совместим с VaultAdapter.
 *  Общий для «Сделать шаблоном…» (gtd-recurring) и «Архивировать» (gtd-archive). */
export interface FrontmatterVaultPort {
	ensureFile(path: string): Promise<void>;
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<unknown>;
}

export interface MoveToTemplatesDeps {
	taskKey: string;
	recurringFiles: readonly string[];
	spawnTarget: string;
	vault: FrontmatterVaultPort;
	dispatcher: IntentDispatcher;
}

/**
 * Перенос строки в файл регулярных: при отсутствии файла — создание +
 * frontmatter `gtd-recurring: true` (СТРОГО до move-line: иначе строка успела
 * бы прожить в файле как обычная задача и протечь во входящие), затем
 * move-line штатным intent'ом (append в цель → delete из источника, ТЗ §3).
 * Правило 🔁 у перенесённой строки пусто — вид «Регулярные» покажет бейдж.
 */
export async function moveTaskToTemplates(deps: MoveToTemplatesDeps): Promise<IntentResult> {
	const target = recurringTemplateTarget(deps.recurringFiles, deps.spawnTarget);
	if (target.create) {
		try {
			await deps.vault.ensureFile(target.path);
			await deps.vault.processFrontmatter(target.path, (fm) => {
				fm["gtd-recurring"] = true;
			});
		} catch {
			return { ok: false, reason: "template-file-create-failed" };
		}
	}
	return deps.dispatcher.dispatch({ type: "move-line", key: deps.taskKey, toFile: target.path });
}

// ---------------------------------------------------------------------------
// «Архивировать» — гарантия файла архива с флагом gtd-archive: true
// ---------------------------------------------------------------------------

/**
 * Гарантировать файл архива с флагом `gtd-archive: true` (образец moveTaskToTemplates):
 * ensureFile + простановка флага. Флаг ставится ВСЕГДА (идемпотентно) — поэтому новый
 * файл, существующий без флага и существующий с флагом сходятся к одному состоянию;
 * это важно, чтобы старый Archive.md без флага дописал его при первой же архивации.
 *
 * Вызывать СТРОГО до move-line: иначе перенесённая строка успела бы прожить в файле,
 * ещё не помеченном контейнером архива, и (пока флага нет) протечь во входящие/календарь.
 * false — ensureFile/processFrontmatter упали; строку в этом случае НЕ переносим.
 */
export async function ensureArchiveFile(
	vault: FrontmatterVaultPort,
	path: string,
): Promise<boolean> {
	try {
		await vault.ensureFile(path);
		await vault.processFrontmatter(path, (fm) => {
			fm["gtd-archive"] = true;
		});
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Быстрый ввод — гарантия файла входящих с флагом gtd-inbox: true
// ---------------------------------------------------------------------------

/**
 * Гарантировать файл входящих с флагом `gtd-inbox: true` (образец ensureArchiveFile):
 * ensureFile + идемпотентная простановка флага. Созданный при первом захвате
 * configured inbox file становится помеченным контейнером входящих. Runtime-членство
 * всё равно сопоставляет путь с settings.inboxFile, поэтому сохранённые legacy-маркеры
 * не создают дополнительный inbox. Идемпотентность сводит новый файл, существующий
 * без флага и существующий с флагом к одному состоянию.
 *
 * Вызывать СТРОГО до записи строки-задачи: иначе строка успела бы прожить в файле,
 * ещё не помеченном контейнером входящих, и (пока флага нет) вести себя как обычная
 * задача. false — ensureFile/processFrontmatter упали; строку в этом случае НЕ пишем.
 */
export async function ensureCaptureFile(
	vault: FrontmatterVaultPort,
	path: string,
): Promise<boolean> {
	try {
		await vault.ensureFile(path);
		await vault.processFrontmatter(path, (fm) => {
			fm["gtd-inbox"] = true;
		});
		return true;
	} catch {
		return false;
	}
}
