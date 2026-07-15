/**
 * Чистые помощники действий паритета без drag (ТЗ §8, слой 3): санитация
 * быстрого ввода, поиск задачи под курсором, «Сделать шаблоном…».
 * Ноль импортов obsidian — тестируется в голом node; запись идёт через
 * структурные порты, совместимые с VaultAdapter, и IntentDispatcher.
 */
import type { Task } from "../../core/model/Task";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import type { IntentDispatcher, IntentResult } from "../../services/WritebackService";

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

/** Структурный порт создания файла шаблонов; совместим с VaultAdapter. */
export interface TemplateVaultPort {
	ensureFile(path: string): Promise<void>;
	processFrontmatter(
		path: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<unknown>;
}

export interface MoveToTemplatesDeps {
	taskKey: string;
	recurringFiles: readonly string[];
	spawnTarget: string;
	vault: TemplateVaultPort;
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
