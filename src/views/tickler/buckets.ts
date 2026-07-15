/**
 * Разбиение отложенных на бакеты (ТЗ §4/§5): «Завтра», «Эта неделя», «Позже».
 * Вход уже отфильтрован ticklerStore (start > today) и отсортирован по start —
 * порядок внутри бакетов сохраняется. Границы:
 *   Завтра     — start == today+1 (робастно: любой start <= today+1);
 *   Эта неделя — start до конца недели, содержащей today (firstDayOfWeek из настроек);
 *   Позже      — остальное.
 * Если завтра уже в следующей неделе, оно всё равно «Завтра» — бакет уже недели.
 */
import type { IsoDate, Task } from "../../core/model/Task";
import { addDaysIso, endOfWeek } from "../common/dates";

export type BucketId = "tomorrow" | "thisWeek" | "later";

export interface TicklerBuckets {
	tomorrow: Task[];
	thisWeek: Task[];
	later: Task[];
}

/** Порядок и заголовки секций вида. */
export const BUCKET_ORDER: readonly { id: BucketId; title: string }[] = [
	{ id: "tomorrow", title: "Завтра" },
	{ id: "thisWeek", title: "Эта неделя" },
	{ id: "later", title: "Позже" },
];

export function bucketize(
	tasks: readonly Task[],
	today: IsoDate,
	firstDayOfWeek: number,
): TicklerBuckets {
	const tomorrow = addDaysIso(today, 1);
	const weekEnd = endOfWeek(today, firstDayOfWeek);
	const out: TicklerBuckets = { tomorrow: [], thisWeek: [], later: [] };
	for (const t of tasks) {
		if (t.start === null) {
			// для тикля невозможно (start > today по формуле §1) — но не роняем вид
			out.later.push(t);
		} else if (t.start <= tomorrow) {
			out.tomorrow.push(t);
		} else if (t.start <= weekEnd) {
			out.thisWeek.push(t);
		} else {
			out.later.push(t);
		}
	}
	return out;
}
