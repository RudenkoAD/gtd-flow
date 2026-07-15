/**
 * Членство задачи в колонке доски (ТЗ §3): match-спеки '#tag' и 'status:*'.
 */
import type { Task } from "../model/Task";
import type { BoardDef, MatchSpec } from "./boardFile";
import { parseMatchSpec } from "./boardFile";

function matchesSpec(task: Task, spec: MatchSpec): boolean {
	if (spec.kind === "tag") {
		return task.tags.some((raw) => {
			// теги могут прийти с '#' или без; вложенный тег (#a/b) — член колонки '#a'
			const t = raw.startsWith("#") ? raw.slice(1) : raw;
			return t === spec.tag || t.startsWith(spec.tag + "/");
		});
	}
	const c = task.statusChar;
	switch (spec.status) {
		case "done":
			return c === "x" || c === "X";
		case "doing":
			return c === "/";
		case "todo":
			// любые прочие символы = todo; '-' (cancelled) не попадает никуда
			return c !== "x" && c !== "X" && c !== "/" && c !== "-";
	}
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
