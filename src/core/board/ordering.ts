/**
 * Ручной порядок карточек в колонке (ТЗ §3): frontmatter доски хранит
 * order: colId → список 🆔; ренормализация — при загрузке и каждом drag.
 */
import type { Priority, Task } from "../model/Task";

const PRIORITY_RANK: Record<Priority, number> = {
	highest: 0,
	high: 1,
	medium: 2,
	low: 3,
	lowest: 4,
	none: 5,
};

/** Порядок добавки для карточек вне order: приоритет ↓, потом ➕ created ↑ (без даты — в конец), потом key. */
function compareAppended(a: Task, b: Task): number {
	const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
	if (pr !== 0) return pr;
	if (a.created !== b.created) {
		if (a.created === null) return 1;
		if (b.created === null) return -1;
		return a.created < b.created ? -1 : 1;
	}
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Упорядочить задачи колонки по списку 🆔:
 * - id из order без носителя в колонке — молча пропускается;
 * - задачи колонки, не перечисленные в order (и задачи без 🆔), добавляются
 *   в конец, отсортированные по приоритету/created;
 * - дубли 🆔 терпимы: каждое вхождение id в order потребляет следующего носителя.
 */
export function applyOrder(colTasks: readonly Task[], order: readonly string[]): Task[] {
	const carriers = new Map<string, Task[]>();
	for (const t of colTasks) {
		if (t.taskId === null) continue;
		const q = carriers.get(t.taskId);
		if (q) q.push(t);
		else carriers.set(t.taskId, [t]);
	}
	const placed = new Set<Task>();
	const result: Task[] = [];
	for (const id of order) {
		const t = carriers.get(id)?.shift();
		if (t !== undefined) {
			result.push(t);
			placed.add(t);
		}
	}
	const rest = colTasks.filter((t) => !placed.has(t));
	rest.sort(compareAppended);
	return [...result, ...rest];
}

/**
 * Новый order-map после перестановки/переноса в колонке colId.
 * Ренормализация: id из orderedIds вычищаются из ВСЕХ прочих колонок
 * (карточка живёт ровно в одном списке), дубли внутри orderedIds схлопываются.
 * Вход не мутируется — возвращается новый объект.
 */
export function patchOrder(
	order: Readonly<Record<string, readonly string[]>>,
	colId: string,
	orderedIds: readonly string[],
): Record<string, string[]> {
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const id of orderedIds) {
		if (!seen.has(id)) {
			seen.add(id);
			deduped.push(id);
		}
	}
	const next: Record<string, string[]> = {};
	for (const [col, ids] of Object.entries(order)) {
		if (col === colId) continue;
		next[col] = ids.filter((id) => !seen.has(id));
	}
	next[colId] = deduped;
	return next;
}
