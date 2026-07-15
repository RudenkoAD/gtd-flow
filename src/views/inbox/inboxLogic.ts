/**
 * Локальный фильтр шапки входящих: подстрока без учёта регистра
 * по описанию и тегам. Сортировку даёт QueryEngine — здесь только сужение.
 */
import type { Task } from "../../core/model/Task";

export function filterTasks(tasks: readonly Task[], query: string): readonly Task[] {
	const q = query.trim().toLowerCase();
	if (q === "") return tasks;
	return tasks.filter(
		(t) =>
			t.description.toLowerCase().includes(q) ||
			t.tags.some((tag) => tag.toLowerCase().includes(q)),
	);
}
