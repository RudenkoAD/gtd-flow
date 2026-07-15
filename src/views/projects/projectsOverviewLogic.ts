/**
 * Чистая логика вида «Проекты» (обзор): сводка проектов в строки-карточки
 * с прогрессом. Без DOM и obsidian — проверяемое живёт здесь, ProjectsOverview.svelte
 * остаётся тонкой обвязкой.
 */
import { isCancelled, isDone } from "../../core/model/gtdState";
import type { ProjectStatus, Task } from "../../core/model/Task";
import type { ProjectSummary } from "../../services/ProjectService";

export interface ProjectRow {
	path: string;
	name: string;
	status: ProjectStatus;
	/** Выполненные члены (done ИЛИ cancelled — см. ниже). */
	done: number;
	/** Всего членов файла-проекта. */
	total: number;
	/** Прогресс done/total в процентах, целое 0..100 (0 при пустом проекте). */
	pct: number;
	/** Все члены выполнены/отменены (из ProjectSummary — единый источник с видом проекта). */
	complete: boolean;
	/** Есть blocked, но никто не готов/в работе (из ProjectSummary). */
	stalled: boolean;
}

/** Порядок статусов в сортировке: active первыми, затем on-hold, done, archived. */
const STATUS_ORDER: Record<ProjectStatus, number> = {
	active: 0,
	"on-hold": 1,
	done: 2,
	archived: 3,
};

/**
 * Сводки → строки обзора. Прогресс = done/total по членам файла, где «выполнено» =
 * DONE ИЛИ CANCELLED: отменённое считаем закрытым, как projectComplete в
 * ProjectService (complete ⇔ каждый член isDone||isCancelled) и depSatisfied в §1.
 * Флаги complete/stalled берём из ProjectSummary, не пересчитываем — единый
 * источник истины с видом проекта.
 * Сортировка: по статусу (active→on-hold→done→archived), внутри статуса — по имени.
 */
export function buildProjectRows(
	summaries: readonly ProjectSummary[],
	tasksOf: (path: string) => readonly Task[],
): ProjectRow[] {
	const rows: ProjectRow[] = summaries.map((s) => {
		const tasks = tasksOf(s.path);
		const total = tasks.length;
		const done = tasks.filter((t) => isDone(t) || isCancelled(t)).length;
		const pct = total === 0 ? 0 : Math.round((done / total) * 100);
		return {
			path: s.path,
			name: s.name,
			status: s.status,
			done,
			total,
			pct,
			complete: s.complete,
			stalled: s.stalled,
		};
	});
	rows.sort((a, b) => {
		const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
		if (so !== 0) return so;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
	return rows;
}
