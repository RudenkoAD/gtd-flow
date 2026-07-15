/**
 * Членство задачи в колонке доски (ТЗ §3): match-спек — только '#tag'
 * (раунд 3: колонки развязаны со статусом, status-матчей больше нет).
 */
import type { Task } from "../model/Task";
import type { BoardDef, MatchSpec } from "./boardFile";
import { parseMatchSpec } from "./boardFile";

function matchesSpec(task: Task, spec: MatchSpec): boolean {
	return task.tags.some((raw) => {
		// теги могут прийти с '#' или без; вложенный тег (#a/b) — член колонки '#a'
		const t = raw.startsWith("#") ? raw.slice(1) : raw;
		return t === spec.tag || t.startsWith(spec.tag + "/");
	});
}

/**
 * Колонка задачи на доске или null, если ни одна не подходит.
 * Задача может подходить нескольким колонкам — ПЕРВАЯ по порядку
 * board.columns побеждает (детерминизм вместо дублирования карточки).
 */
export function resolveColumn(task: Task, board: BoardDef): string | null {
	for (const col of board.columns) {
		const spec = parseMatchSpec(col.match);
		if (spec === null) continue; // битый match отфильтрован парсером, но fail-safe
		if (matchesSpec(task, spec)) return col.id;
	}
	return null;
}

/**
 * Принадлежность задачи доске (охват доски). Задача попадает на доску, только
 * если выполнено хотя бы одно из:
 *   (a) строка задачи в самом файле доски (task.filePath === boardPath);
 *   (b) на задаче есть тег колонки ЭТОЙ доски '#kanban/<def.id>/…';
 *   (c) у доски задан scope 'path:…' и путь задачи под этим префиксом.
 * Иначе чужая задача (в т.ч. выполненная из другого файла или помеченная
 * тегом другой доски) на доску не протекает — иначе выполненные со всего
 * хранилища собирались бы на первой попавшейся доске.
 */
export function belongsToBoard(task: Task, boardPath: string, board: BoardDef): boolean {
	if (task.filePath === boardPath) return true;
	const colPrefix = `kanban/${board.id}/`;
	const hasColumnTag = task.tags.some((raw) => {
		// теги могут прийти с '#' или без — нормализуем, как в matchesSpec
		const t = raw.startsWith("#") ? raw.slice(1) : raw;
		return t.startsWith(colPrefix);
	});
	if (hasColumnTag) return true;
	if (board.scope !== undefined && board.scope.startsWith("path:")) {
		return task.filePath.startsWith(board.scope.slice("path:".length));
	}
	return false;
}
