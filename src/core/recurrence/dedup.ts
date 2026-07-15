/**
 * Классификация дублей копий регулярных задач (ТЗ §6, §8 «дедуп двух устройств»).
 * После схождения синка несколько носителей одного 🆔 коллидируют; правило:
 * авто-удалять можно ТОЛЬКО доказуемо машинные («нетронутые») строки.
 *
 * pristine = rawLine совпадает с каноническим рендером спавна (по trimEnd)
 *            И statusChar === ' ' (никто не отмечал/не правил).
 *
 * Исходы:
 * - единственная изменённая копия побеждает, нетронутые удаляются;
 * - все нетронутые → детерминированный победитель по (filePath, lineStart) —
 *   оба устройства сходятся к одному без координации;
 * - ≥2 изменённых → конфликт: НИКОГДА не удаляем работу пользователя,
 *   не удаляется ничего (даже нетронутые) — бейдж для ручного разбора.
 */
import type { Task } from "../model/Task";

export interface DuplicateCarrier {
	task: Task;
	/** Каноническая строка спавна этого носителя (пересчитанная планировщиком). */
	canonicalLine: string;
}

export type DedupResult = { keep: Task; remove: Task[] } | { conflict: Task[] };

export function classifyDuplicates(carriers: DuplicateCarrier[]): DedupResult {
	if (carriers.length === 0) return { conflict: [] };

	const pristine: Task[] = [];
	const modified: Task[] = [];
	for (const c of carriers) {
		const untouched =
			c.task.statusChar === " " && c.task.rawLine.trimEnd() === c.canonicalLine.trimEnd();
		(untouched ? pristine : modified).push(c.task);
	}

	if (modified.length >= 2) return { conflict: modified };

	const single = modified[0];
	if (single !== undefined) return { keep: single, remove: pristine };

	// все нетронуты — детерминированный победитель
	const sorted = [...pristine].sort((a, b) =>
		a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.lineStart - b.lineStart,
	);
	const keep = sorted[0];
	if (keep === undefined) return { conflict: [] }; // недостижимо: carriers непуст
	return { keep, remove: sorted.slice(1) };
}
