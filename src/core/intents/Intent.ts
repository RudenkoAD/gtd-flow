/**
 * Intents (ТЗ §3): виды не пишут в файлы — они порождают Intent,
 * WritebackService применяет его атомарно через vault.process().
 * Строка ищется по 🆔, затем по content-key; не нашли — отмена + уведомление.
 */
import type { IsoDate, Priority, ProjectStatus } from "../model/Task";

/** Дата-поля, доступные SetDate. 🔜 меняется только через AdvanceCursor. */
export type SettableDateField = "due" | "scheduled" | "start" | "created" | "done" | "cancelled";

export interface NodePosition {
	x: number;
	y: number;
}

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

export interface SetDate {
	type: "set-date";
	key: string;
	field: SettableDateField;
	/** null — удалить поле (вместе со временем). */
	date: IsoDate | null;
	/** Политика «🛫 и 📅 взаимоисключающие»: снять 🛫 той же атомарной
	 *  записью (учитывается только при field === "due"; UI ставит после
	 *  подтверждения пользователем). */
	clearStart?: boolean;
	/** Время «HH:mm» — только для due/scheduled/start (семантика setField):
	 *  undefined — сохранить существующее время поля, null — снять, строка — установить. */
	time?: string | null;
	/** Конец интервала «HH:mm» — та же семантика, что у time (undefined сохранить,
	 *  null снять, строка установить); валиден только при времени начала и строго
	 *  позже него, снятие time снимает и timeEnd (см. setField). */
	timeEnd?: string | null;
}

/** Полная замена текста описания (инлайн-редактирование карточки). */
export interface SetText {
	type: "set-text";
	key: string;
	text: string;
}

export interface SetStatus {
	type: "set-status";
	key: string;
	statusChar: string;
	/** Дата для ✅/❌ при переходе в done/cancelled; опущена — поле даты не трогаем. */
	date?: IsoDate;
}

export interface SetPriority {
	type: "set-priority";
	key: string;
	/** "none" — убрать эмодзи приоритета. */
	priority: Priority;
}

export interface MoveColumn {
	type: "move-column";
	key: string;
	/** Тег исходной колонки (#kanban/<board>/<col>) — снять; null, если снимать нечего. */
	fromTag: string | null;
	/** Доп. теги колонок к снятию: архив снимает все '#kanban/'-теги задачи разом,
	 *  чтобы карточка ушла со ВСЕХ досок. */
	fromTags?: string[];
	/** Тег целевой колонки — добавить; null (архив: только снятие тегов). */
	toTag: string | null;
	/** Позиция в ручном порядке целевой колонки (frontmatter доски — вторая запись). */
	index?: number;
}

/** Ручной порядок колонки — frontmatter доски, не строки задач. */
export interface Reorder {
	type: "reorder";
	boardPath: string;
	column: string;
	orderedKeys: string[];
}

/** Пишет 🛫 — задача уходит в «Отложенные» (§5). */
export interface Defer {
	type: "defer";
	key: string;
	until: IsoDate;
	/** Политика «🛫 и 📅 взаимоисключающие»: снять 📅 (и его время) той же
	 *  атомарной записью (UI ставит после подтверждения пользователем). */
	clearDue?: boolean;
}

/** Ленивая вставка 🆔 при первой структурной правке (autoInjectId). */
export interface SetId {
	type: "set-id";
	key: string;
	taskId: string;
}

// ---------------------------------------------------------------------------
// Регулярные (§8)
// ---------------------------------------------------------------------------

/** Батч-append копий; внутри process — повторная проверка 🆔 в тексте файла. */
export interface SpawnInstances {
	type: "spawn-instances";
	file: string;
	lines: string[];
}

/** Сдвиг курсора 🔜 на строке шаблона. Порядок записи: сначала копия, потом курсор. */
export interface AdvanceCursor {
	type: "advance-cursor";
	templateId: string;
	date: IsoDate;
}

/** Удаление строки задачи: дедуп «нетронутых» машинных строк-копий (§6) и
 *  пункт меню «Удалить» (задача создана по ошибке). */
export interface DeleteLine {
	type: "delete-line";
	key: string;
	/** Убрать вместе со строкой её вложенный блок (следующие строки с бо́льшим
	 *  отступом). Ставит «Удалить» из меню; дедуп его не задаёт — машинные копии
	 *  бездетны, удаляется ровно одна строка (см. WritebackService.deleteLine). */
	withChildren?: boolean;
}

// ---------------------------------------------------------------------------
// Проекты (§9) — однофайловые атомарные транзакции (строки + layout в одном файле)
// ---------------------------------------------------------------------------

/** Строка задачи + позиция в frontmatter layout одной записью; 🆔 вставляется сразу. */
export interface AddNode {
	type: "add-node";
	projectPath: string;
	/** Готовая строка задачи (с 🆔 = taskId). */
	line: string;
	taskId: string;
	position: NodePosition;
}

/** Ребро source→target ⇒ append sourceId в ⛔ строки targetId.
 *  Проверка циклов — ДО записи, DFS по индексу (в сервисе). */
export interface ConnectEdge {
	type: "connect-edge";
	projectPath: string;
	sourceId: string;
	targetId: string;
}

export interface DisconnectEdge {
	type: "disconnect-edge";
	projectPath: string;
	sourceId: string;
	targetId: string;
}

/** Удаление строки + вычистка id из всех ⛔ + из layout. */
export interface DeleteNode {
	type: "delete-node";
	projectPath: string;
	taskId: string;
}

/** Батч позиций за жест (дебаунс ~300мс); только frontmatter layout. */
export interface MoveNode {
	type: "move-node";
	projectPath: string;
	positions: Record<string, NodePosition>;
}

export interface SetProjectStatus {
	type: "set-project-status";
	projectPath: string;
	status: ProjectStatus;
}

// ---------------------------------------------------------------------------
// Перенос между файлами (drag входящие → проект/регулярные)
// ---------------------------------------------------------------------------

/** append в цель, потом delete из источника; дубль 🆔 при сбое посередине
 *  виден линтом — потеря строки исключена порядком записи. */
export interface MoveLine {
	type: "move-line";
	key: string;
	toFile: string;
}

export type Intent =
	| SetDate
	| SetText
	| SetStatus
	| SetPriority
	| MoveColumn
	| Reorder
	| Defer
	| SetId
	| SpawnInstances
	| AdvanceCursor
	| DeleteLine
	| AddNode
	| ConnectEdge
	| DisconnectEdge
	| DeleteNode
	| MoveNode
	| SetProjectStatus
	| MoveLine;
