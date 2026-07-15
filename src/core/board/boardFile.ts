/**
 * Модель kanban-доски из frontmatter файла с `gtd-board: true` (ТЗ §3, §4).
 *
 * Frontmatter приходит УЖЕ распарсенным YAML-объектом — парсинг YAML-текста
 * это работа адаптера, core только валидирует форму и нормализует.
 */

export type GroupBy = "tag" | "status";

export interface BoardColumn {
	id: string;
	name: string;
	/** Только '#tag'-матч (раунд 3: колонки развязаны со статусом). */
	match: string;
}

/**
 * Колонка, пропущенная при разборе доски (раунд 3): status-матчи упразднены,
 * такая колонка не валит доску, но и не показывается — discovery поверхностит
 * её как предупреждение, чтобы пользователь пересоздал колонку тегом.
 */
export interface SkippedColumn {
	id: string;
	name: string;
	reason: string;
}

export interface BoardDef {
	id: string;
	name: string;
	groupBy: GroupBy;
	columns: BoardColumn[];
	/** Колонки, отброшенные при разборе (напр. упразднённые status-матчи). */
	skippedColumns: SkippedColumn[];
	/** Ограничение охвата (тег/папка) — интерпретируется query-слоем. */
	scope?: string;
	/** Ручной порядок карточек: colId → список 🆔. */
	order: Record<string, string[]>;
}

export interface BoardError {
	kind: "board-error";
	messages: string[];
}

export function isBoardError(v: BoardDef | BoardError): v is BoardError {
	return (v as BoardError).kind === "board-error";
}

/** Разобранный match-спек колонки — только тег (без ведущего '#'). */
export type MatchSpec = { kind: "tag"; tag: string };

export function parseMatchSpec(match: string): MatchSpec | null {
	if (match.startsWith("#")) {
		const tag = match.slice(1);
		return tag.length > 0 ? { kind: "tag", tag } : null;
	}
	return null;
}

/** Упразднённый status-матч ('status:*'): такую колонку пропускаем, не валя доску. */
function isStatusMatch(match: string): boolean {
	return match.startsWith("status:");
}

function readString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Валидация и нормализация frontmatter доски.
 * Структурные ошибки собираются все разом → BoardError с сообщениями.
 * Мягкая нормализация: name колонки по умолчанию = её id; записи `order`
 * для неизвестных колонок молча выбрасываются (ренормализация при загрузке).
 */
export function parseBoardFrontmatter(fm: Record<string, unknown>): BoardDef | BoardError {
	const messages: string[] = [];

	const id = readString(fm["id"]);
	if (id === null) messages.push("board: missing or empty string field 'id'");
	// name отсутствует → берём id (доске всегда есть что показать в заголовке)
	const name = readString(fm["name"]) ?? id;

	const rawGroupBy = fm["group-by"] ?? fm["groupBy"];
	let groupBy: GroupBy = "tag";
	if (rawGroupBy !== undefined && rawGroupBy !== null) {
		if (rawGroupBy === "tag" || rawGroupBy === "status") groupBy = rawGroupBy;
		else messages.push(`board: 'group-by' must be 'tag' or 'status', got ${JSON.stringify(rawGroupBy)}`);
	}

	const rawScope = fm["scope"];
	let scope: string | undefined;
	if (rawScope !== undefined && rawScope !== null) {
		const s = readString(rawScope);
		if (s === null) messages.push("board: 'scope' must be a non-empty string");
		else scope = s;
	}

	const columns: BoardColumn[] = [];
	const skippedColumns: SkippedColumn[] = [];
	const rawColumns = fm["columns"];
	if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
		messages.push("board: 'columns' must be a non-empty array");
	} else {
		const seenIds = new Set<string>();
		for (let i = 0; i < rawColumns.length; i++) {
			const rawCol: unknown = rawColumns[i];
			if (!isRecord(rawCol)) {
				messages.push(`board: columns[${i}] must be an object {id, name?, match}`);
				continue;
			}
			const colId = readString(rawCol["id"]);
			const match = readString(rawCol["match"]);
			const displayName = readString(rawCol["name"]) ?? colId ?? `columns[${i}]`;
			// Раунд 3: status-матч больше не поддерживается — колонка не валит доску,
			// а тихо отбрасывается (discovery покажет предупреждение). Пропускаем ДО
			// проверок id/дублей/валидности, чтобы упразднённая колонка не порождала
			// шумных ошибок и не занимала id.
			if (match !== null && isStatusMatch(match)) {
				skippedColumns.push({
					id: colId ?? `columns[${i}]`,
					name: displayName,
					reason: `колонка '${displayName}': status-матчи упразднены — пересоздайте как обычную колонку`,
				});
				continue;
			}
			if (colId === null) messages.push(`board: columns[${i}] missing string 'id'`);
			else if (seenIds.has(colId)) messages.push(`board: duplicate column id '${colId}'`);
			else seenIds.add(colId);
			if (match === null) {
				messages.push(`board: columns[${i}] missing string 'match'`);
			} else if (parseMatchSpec(match) === null) {
				messages.push(
					`board: columns[${i}] invalid match ${JSON.stringify(match)} — expected '#tag'`,
				);
			}
			if (colId !== null && match !== null && parseMatchSpec(match) !== null) {
				columns.push({ id: colId, name: readString(rawCol["name"]) ?? colId, match });
			}
		}
	}

	const order: Record<string, string[]> = {};
	const rawOrder = fm["order"];
	if (rawOrder !== undefined && rawOrder !== null) {
		if (!isRecord(rawOrder)) {
			messages.push("board: 'order' must be a map colId → list of task ids");
		} else {
			const knownCols = new Set(columns.map((c) => c.id));
			for (const [colId, ids] of Object.entries(rawOrder)) {
				if (!knownCols.has(colId)) continue; // ренормализация: колонка удалена — порядок мёртв
				if (!Array.isArray(ids)) {
					messages.push(`board: order['${colId}'] must be an array of task ids`);
					continue;
				}
				const clean: string[] = [];
				for (const v of ids) {
					if (typeof v === "string") clean.push(v);
					else messages.push(`board: order['${colId}'] contains a non-string entry`);
				}
				order[colId] = clean;
			}
		}
	}

	if (messages.length > 0) return { kind: "board-error", messages };
	// id/name здесь гарантированно не null: их отсутствие даёт message выше
	return {
		id: id as string,
		name: name as string,
		groupBy,
		columns,
		skippedColumns,
		...(scope !== undefined ? { scope } : {}),
		order,
	};
}
