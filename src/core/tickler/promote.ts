/**
 * Отложенный ящик (ТЗ §5): чистое разбиение задач на active / deferred / done.
 * «Всплытие» — ноль записей: today перешагнул start ⇒ задача сама попадает в active
 * при следующем пересчёте. Функция чистая и идемпотентная: повторное разбиение
 * объединения корзин даёт тот же результат.
 */
import type { IsoDate, Task } from "../model/Task";
import { deriveGtdState, type ResolveDep } from "../model/gtdState";

export interface TicklerPartition {
	/** Живые задачи (ACTIVE/DOING/WAITING/BLOCKED — всё, что не закрыто и не отложено). */
	active: Task[];
	/** В тикле: 🛫 start > today (state TICKLER). */
	deferred: Task[];
	/** Закрытые: DONE и CANCELLED. */
	done: Task[];
}

/**
 * TEMPLATE и DETAIL не попадают ни в одну корзину — по §1 они невидимы
 * для глобальных проекций (только виды «Регулярные» и карточка).
 * Порядок внутри корзин = порядок входа (сортировка — забота QueryEngine).
 */
export function partition(
	tasks: Iterable<Task>,
	today: IsoDate,
	resolveDep: ResolveDep,
): TicklerPartition {
	const active: Task[] = [];
	const deferred: Task[] = [];
	const done: Task[] = [];
	for (const t of tasks) {
		const state = deriveGtdState(t, today, resolveDep);
		if (state === "TEMPLATE" || state === "DETAIL") continue;
		if (state === "DONE" || state === "CANCELLED") done.push(t);
		else if (state === "TICKLER") deferred.push(t);
		else active.push(t);
	}
	return { active, deferred, done };
}
