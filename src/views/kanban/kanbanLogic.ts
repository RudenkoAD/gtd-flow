/**
 * Чистая логика вида Kanban (без DOM и obsidian): выбор доски, вью-модель
 * колонок, формирование строки задачи для колонки и путь новой доски. Всё,
 * что можно проверить в node, — здесь; Kanban.svelte остаётся тонкой обвязкой.
 */
import type { BoardColumnModel, DiscoveredBoard } from "../../services/BoardService";
import type { Task } from "../../core/model/Task";
import { appendLine } from "../calendar/calendarLogic";
import { quickCaptureLine } from "../common/taskActions";

/**
 * Какую доску показывать:
 * 1) текущая, если она ещё существует (смена выбора не сбрасывается индексом);
 * 2) предпочтение (settings.defaultBoardPath / сохранённое viewState);
 * 3) первая из обнаруженных; 4) досок нет — null.
 */
export function pickBoardPath(
	boards: readonly DiscoveredBoard[],
	preferred: string | null | undefined,
	current: string | null,
): string | null {
	const has = (p: string | null | undefined): p is string =>
		p !== null && p !== undefined && boards.some((b) => b.path === p);
	if (has(current)) return current;
	if (has(preferred)) return preferred;
	return boards.length > 0 ? boards[0]!.path : null;
}

/** Вью-модель колонки: счётчик и match поверх модели BoardService. */
export interface ColumnVM {
	id: string;
	name: string;
	/** Тег-матч колонки ('#kanban/<board>/<col>') — им метится новая задача. */
	match: string;
	count: number;
	tasks: Task[];
}

export function buildColumnVMs(columns: readonly BoardColumnModel[]): ColumnVM[] {
	return columns.map((c) => ({
		id: c.id,
		name: c.name,
		match: c.match,
		count: c.tasks.length,
		tasks: c.tasks,
	}));
}

// ---------------------------------------------------------------------------
// Создание задачи прямо в колонке (＋ внизу колонки)
// ---------------------------------------------------------------------------

/**
 * Строка задачи для колонки: та же санитация быстрого ввода, что во Входящих
 * (quickCaptureLine → `- [ ] <текст>`), плюс тег-матч колонки в конце. Строка
 * пишется В ФАЙЛ ДОСКИ, поэтому по filePath уже принадлежит доске
 * (belongsToBoard), а тег кладёт её в нужную колонку (resolveColumn); сам тег
 * скрыт в отображении карточки (stripColumnTags). Пустой ввод → null (не пишем).
 * Пустой match (fail-safe: у колонок доски он всегда валиден) → строка без тега.
 */
export function columnTaskLine(text: string, columnMatch: string): string | null {
	const base = quickCaptureLine(text);
	if (base === null) return null;
	const tag = columnMatch.trim();
	return tag === "" ? base : `${base} ${tag}`;
}

/** Структурный порт записи строки задачи в файл доски; совместим с VaultAdapter. */
export interface BoardWritePort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
}

/**
 * Быстрый ввод задачи в колонку: санитация + тег колонки (columnTaskLine),
 * затем append строки в конец файла доски. Пустой/невалидный ввод → null:
 * вызывающий ничего не пишет и остаётся в поле (серийный ввод). Возврат —
 * трансформ для VaultAdapter.processFile (зеркало inboxCaptureTransform).
 */
export function columnCaptureTransform(
	text: string,
	columnMatch: string,
): ((content: string) => string) | null {
	const line = columnTaskLine(text, columnMatch);
	if (line === null) return null;
	return (content) => appendLine(content, line);
}

// ---------------------------------------------------------------------------
// Путь файла новой доски (createBoard)
// ---------------------------------------------------------------------------

/**
 * Папка «дома» GTD из настроек: каталог первого источника входящих
 * (inboxSources[0], по умолчанию "GTD/Inbox.md" → "GTD"). Пустая строка —
 * корень хранилища. Туда же, где Events.md/Archive.md, кладём и доски.
 */
export function boardDirFromInbox(inboxSources: readonly string[]): string {
	const src = inboxSources[0] ?? "GTD/Inbox.md";
	const i = src.lastIndexOf("/");
	return i === -1 ? "" : src.slice(0, i);
}

/**
 * Имя файла доски из названия: символы, недопустимые в имени файла Obsidian
 * (`\ / : * ? " < > | # ^ [ ]`), → пробел; пробелы схлопнуть, крайние обрезать.
 * Пустой результат (эмодзи/спецсимволы целиком) → "Доска".
 */
export function boardFileName(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
	return cleaned === "" ? "Доска" : cleaned;
}

/**
 * Свободный путь `<dir>/<имя>.md` для новой доски: имя из названия
 * (boardFileName), при занятости пути (exists) — суффикс « 2», « 3»…
 * Уникализация не даёт createBoard дописать флаг в чужой существующий файл
 * или молча выбрать уже созданную доску вместо новой.
 */
export function uniqueBoardPath(
	dir: string,
	name: string,
	exists: (path: string) => boolean,
): string {
	const base = boardFileName(name);
	const prefix = dir === "" ? "" : `${dir.replace(/\/+$/, "")}/`;
	let candidate = `${prefix}${base}.md`;
	for (let n = 2; exists(candidate); n++) candidate = `${prefix}${base} ${n}.md`;
	return candidate;
}

/** JSON-сериализуемое состояние вида для workspace-раскладки (ТЗ §4). */
export interface KanbanPersistedState {
	boardPath?: string;
}

/**
 * Человекочитаемое уведомление при отказе moveCard. Раунд 3: перенос
 * развязан со статусом — карточка любого статуса едет в любую колонку,
 * поэтому специальных отказов больше нет, причина показывается как есть.
 */
export function moveRefusalNotice(reason: string | undefined): string {
	return `GTD Flow: ${reason ?? "не удалось перенести карточку"}`;
}
