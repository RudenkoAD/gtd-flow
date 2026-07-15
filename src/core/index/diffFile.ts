/**
 * Диф задач одного файла по ключам (ТЗ §2) — питает инкрементальное
 * обновление индекса и адресные уведомления подписчиков.
 */
import type { Task } from "../model/Task";

export interface TaskChange {
	before: Task;
	after: Task;
}

export interface FileDiff {
	added: Task[];
	removed: Task[];
	changed: TaskChange[];
}

/**
 * Сравнение старого и нового парса файла по task.key.
 * «Изменение» = тот же key, но другой rawLine: сдвиг строки без правки
 * текста изменением НЕ считается (номера строк — только подсказка, ТЗ §2).
 */
export function diffFile(oldTasks: readonly Task[], newTasks: readonly Task[]): FileDiff {
	const oldByKey = new Map<string, Task>();
	for (const t of oldTasks) oldByKey.set(t.key, t);

	const added: Task[] = [];
	const changed: TaskChange[] = [];
	const newKeys = new Set<string>();
	for (const t of newTasks) {
		newKeys.add(t.key);
		const prev = oldByKey.get(t.key);
		if (prev === undefined) added.push(t);
		else if (prev.rawLine !== t.rawLine) changed.push({ before: prev, after: t });
	}
	const removed = oldTasks.filter((t) => !newKeys.has(t.key));
	return { added, removed, changed };
}
