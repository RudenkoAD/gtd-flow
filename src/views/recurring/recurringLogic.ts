/**
 * Чистая логика вида «Регулярные» (без DOM и obsidian): вью-модель шаблона,
 * группировка по файлу/заголовку и история копий. Всё проверяемое в node —
 * здесь; Recurring.svelte остаётся тонкой обвязкой.
 */
import type { IsoDate, Task } from "../../core/model/Task";
import { isParseError, parseRule, type ParseError, type Rule } from "../../core/recurrence/grammar";
import { nextOccurrence } from "../../core/recurrence/nextOccurrence";

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
