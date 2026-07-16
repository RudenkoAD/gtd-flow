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

// ---------------------------------------------------------------------------
// Путь нового файла-проекта (NUX: кнопка «＋ Проект»)
// ---------------------------------------------------------------------------

/**
 * Папка для новых проектов: каталог первого (лексикографически) существующего
 * проекта — новые проекты ложатся рядом с уже заведёнными; при отсутствии
 * проектов — дефолт "Projects". Путь без "/" ⇒ проект в корне (dir === "").
 */
export function projectDir(existingPaths: readonly string[]): string {
	const first = [...existingPaths].sort()[0];
	if (first === undefined) return "Projects";
	const slash = first.lastIndexOf("/");
	return slash === -1 ? "" : first.slice(0, slash);
}

/**
 * Санитация имени проекта в безопасное имя файла: символы, ломающие путь
 * (разделители и зарезервированные в файловых системах), заменяются пробелом,
 * пробелы схлопываются, ведущие точки срезаются (иначе скрытый файл). Пусто
 * после чистки — null (вызывающий не создаёт файл).
 */
export function sanitizeProjectName(name: string): string | null {
	const cleaned = name
		.replace(/[\\/:*?"<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.trim();
	return cleaned === "" ? null : cleaned;
}

/**
 * Путь нового файла-проекта `<projectDir>/<имя>.md` (ТЗ NUX §6/§7). null — имя
 * пустое после санитации: вызывающий показывает Notice и не создаёт проект.
 *
 * exists — проверка занятости пути в ХРАНИЛИЩЕ (vault.getFileByPath), а не только
 * среди известных проектов: createProject иначе дописал бы gtd-project в чужую
 * обычную заметку с совпавшим именем. Занято → суффикс « 2», « 3»…
 */
export function newProjectPath(
	existingPaths: readonly string[],
	name: string,
	exists: (path: string) => boolean = () => false,
): string | null {
	const safe = sanitizeProjectName(name);
	if (safe === null) return null;
	const dir = projectDir(existingPaths);
	const pathOf = (base: string): string => (dir === "" ? `${base}.md` : `${dir}/${base}.md`);
	let path = pathOf(safe);
	for (let n = 2; exists(path); n++) path = pathOf(`${safe} ${n}`);
	return path;
}
