/**
 * Чистая логика вида «Регулярные» (без DOM и obsidian): вью-модель шаблона,
 * группировка по файлу/заголовку, история копий и создание нового шаблона
 * с нуля. Всё проверяемое в node — здесь; Recurring.svelte остаётся тонкой
 * обвязкой.
 */
import type { IsoDate, Task } from "../../core/model/Task";
import { isParseError, parseRule, type ParseError, type Rule } from "../../core/recurrence/grammar";
import { nextOccurrence } from "../../core/recurrence/nextOccurrence";
import { recurringTemplateTarget } from "../common/taskActions";

export type TemplateBadge = "paused" | "error" | "expired";

export interface TemplateVM {
	/** Ключ задачи-шаблона в индексе — им же адресуются действия RecurrencePort. */
	key: string;
	description: string;
	/** Дословный текст 🔁; "" — правила нет (заготовка после drag, этап 8). */
	ruleText: string;
	ruleParsed: Rule | ParseError;
	/** Курсор 🔜 — «следующее вхождение» глазами движка. */
	nextSpawn: IsoDate | null;
	/** Любой статус, кроме ' ' (обычно '-'), — шаблон выключен. */
	paused: boolean;
	/** until в прошлом: правило исчерпано, спавнов больше не будет. */
	expired: boolean;
	badges: TemplateBadge[];
	/** Исходная задача — для «Открыть в файле», группировки и истории (🆔). */
	task: Task;
}

export function buildTemplateVM(task: Task, today: IsoDate): TemplateVM {
	const ruleText = task.recurrence ?? "";
	// отсутствие 🔁 показываем тем же каналом, что и синтаксическую ошибку:
	// шаблон без правила так же неспособен спавнить
	const ruleParsed: Rule | ParseError =
		task.recurrence === null ? { error: "template has no 🔁 rule" } : parseRule(task.recurrence);
	const paused = task.statusChar !== " ";
	// expired только при until: без until nextOccurrence не иссякает
	const expired =
		!isParseError(ruleParsed) &&
		ruleParsed.until !== undefined &&
		nextOccurrence(ruleParsed, today) === null;

	const badges: TemplateBadge[] = [];
	if (paused) badges.push("paused");
	if (isParseError(ruleParsed)) badges.push("error");
	if (expired) badges.push("expired");

	return {
		key: task.key,
		description: task.description,
		ruleText,
		ruleParsed,
		nextSpawn: task.nextSpawn,
		paused,
		expired,
		badges,
		task,
	};
}

/**
 * Тело подтверждения удаления шаблона: удаляется только строка-шаблон, а уже
 * созданные копии (носители 🧬) остаются самостоятельными задачами — их история
 * не рвётся. Модельная часть пункта «Удалить шаблон…» (сам вид не монтируем).
 */
export function deleteTemplateBody(description: string): string {
	return `Удалить шаблон «${description}»? Уже созданные копии останутся.`;
}

export interface TemplateGroup {
	filePath: string;
	heading: string | null;
	templates: TemplateVM[];
}

/**
 * Группировка по (файл, заголовок). Вход уже отсортирован по расположению
 * (all-templates сортирует cmpLocation) — группируем СМЕЖНЫЕ, сохраняя
 * порядок файла; повтор заголовка ниже по файлу — честная отдельная группа.
 */
export function groupByFileAndHeading(templates: readonly TemplateVM[]): TemplateGroup[] {
	const out: TemplateGroup[] = [];
	let current: TemplateGroup | null = null;
	for (const vm of templates) {
		const { filePath, heading } = vm.task;
		if (current === null || current.filePath !== filePath || current.heading !== heading) {
			current = { filePath, heading, templates: [] };
			out.push(current);
		}
		current.templates.push(vm);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Создание нового шаблона с нуля (NUX: кнопка «＋ Шаблон»)
// ---------------------------------------------------------------------------

/**
 * Строка нового шаблона: `- [ ] <название> 🔁 <правило>` (та же форма, что
 * buildEventLine для серий событий). Схлопывает пробелы в названии. Пустое
 * название — null (не пишем).
 */
export function buildTemplateLine(name: string, ruleText: string): string | null {
	const n = name.replace(/\s+/g, " ").trim();
	if (n === "") return null;
	return `- [ ] ${n} 🔁 ${ruleText.trim()}`;
}

/** Структурный порт файла шаблонов; совместим с VaultAdapter (ensure+process+fm). */
export interface TemplateVaultPort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<unknown>;
}

export type TemplateWriteResult = { ok: true; path: string } | { ok: false; reason: string };

/** append строки в конец файла (форма '\n' — как WritebackService.moveLine / eventSeries). */
function appendLine(content: string, line: string): string {
	return content.trimEnd() !== ""
		? content + (content.endsWith("\n") ? "" : "\n") + line + "\n"
		: line + "\n";
}

/**
 * Создать шаблон регулярной задачи с нуля: цель — первый существующий
 * gtd-recurring файл, иначе `<папка GTD>/Recurring.md` (recurringTemplateTarget).
 * Файл гарантируется с флагом `gtd-recurring: true` СТРОГО до append (иначе
 * строка успела бы прожить как обычная задача и протечь во входящие — тот же
 * инвариант, что createEventSeries). Правило валидируется parseRule до записи.
 * Возврат — путь файла, куда добавлена строка (для Notice/навигации).
 */
export async function createTemplate(deps: {
	vault: TemplateVaultPort;
	/** Пути существующих gtd-recurring файлов (recurringFilePaths из индекса). */
	recurringFiles: readonly string[];
	/** settings.recurring.spawnTarget — из него берём «домашнюю» папку GTD. */
	spawnTarget: string;
	name: string;
	ruleText: string;
}): Promise<TemplateWriteResult> {
	if (isParseError(parseRule(deps.ruleText))) return { ok: false, reason: "invalid-rule" };
	const line = buildTemplateLine(deps.name, deps.ruleText);
	if (line === null) return { ok: false, reason: "empty-name" };
	const target = recurringTemplateTarget(deps.recurringFiles, deps.spawnTarget);
	try {
		await deps.vault.ensureFile(target.path);
		await deps.vault.processFrontmatter(target.path, (fm) => {
			fm["gtd-recurring"] = true;
		});
	} catch {
		return { ok: false, reason: "template-file-create-failed" };
	}
	const ok = await deps.vault.processFile(target.path, (content) => appendLine(content, line));
	return ok ? { ok: true, path: target.path } : { ok: false, reason: "write-failed" };
}

/**
 * История копий шаблона: носители 🧬 === templateId, свежие сверху (➕ desc);
 * без ➕ — в конец; при равных датах — стабильно по расположению.
 */
export function historyOf(tasks: Iterable<Task>, templateId: string): Task[] {
	const out: Task[] = [];
	for (const t of tasks) {
		if (t.spawnedFrom === templateId) out.push(t);
	}
	out.sort((a, b) => {
		if (a.created !== b.created) {
			if (a.created === null) return 1;
			if (b.created === null) return -1;
			return a.created < b.created ? 1 : -1;
		}
		return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.lineStart - b.lineStart;
	});
	return out;
}
