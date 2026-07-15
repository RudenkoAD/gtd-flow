/**
 * Каноническая in-memory модель задачи (ТЗ §2).
 * Карточка kanban, событие календаря, входящая и узел графа — проекции этого объекта.
 *
 * core/ не импортирует `obsidian` — см. scripts/check-core-purity.mjs.
 */

/** Календарная дата без времени и таймзоны, формат YYYY-MM-DD.
 *  Лексикографическое сравнение строк == хронологическому. */
export type IsoDate = string;

export type Priority = "highest" | "high" | "medium" | "low" | "lowest" | "none";

/** Полная цепочка вывода состояния, по убыванию приоритета (ТЗ §1). */
export type GtdState =
	| "TEMPLATE" // задача в файле gtd-recurring: true — шаблон регулярного ящика
	| "DETAIL" // задача в файле-карточке gtd-card-of — приватный чеклист карточки
	| "EVENT" // задача в файле gtd-events: true — шаблон повторяющегося события (виден только в календаре)
	| "ARCHIVED" // задача в файле gtd-archive: true — полностью инертна, вне всех запросов и видов
	| "DONE"
	| "CANCELLED"
	| "TICKLER" // 🛫 start > today
	| "WAITING" // #waiting или невыполненные ⛔ вне проекта
	| "BLOCKED" // член проекта с невыполненными ⛔
	| "DOING"
	| "ACTIVE";

/**
 * Тип файла-контейнера, меняющего интерпретацию задач (frontmatter-флаги).
 * Приоритет распознавания флагов (snapshotHelpers.fileContextFromFrontmatter):
 * recurring > events > card > project > board > archive > inbox > plain.
 * - "archive" — gtd-archive: true, полная инертность (состояние ARCHIVED, вне запросов);
 * - "inbox"   — gtd-inbox: true, маркер файла захвата (в деривации состояний ведёт
 *               себя как "plain"; служит целью записи быстрого ввода, см. captureTargets).
 */
export type ContainerKind =
	| "plain"
	| "board"
	| "project"
	| "recurring"
	| "card"
	| "events"
	| "archive"
	| "inbox";

export type ProjectStatus = "active" | "on-hold" | "done" | "archived";

/** Контекст файла, вычисляемый из frontmatter на этапе индексации. */
export interface FileContext {
	path: string;
	container: ContainerKind;
	/** Только для container === "project"; отсутствие в frontmatter ⇒ "active". */
	projectStatus?: ProjectStatus;
}

export interface Task {
	// --- идентичность и расположение ---
	/** Стабильный ключ индекса: "id:<🆔>" либо content-key (путь + хэш описания + порядковый номер). */
	key: string;
	/** Значение 🆔, если есть. Предпочтительный якорь для write-back и ⛔. */
	taskId: string | null;
	filePath: string;
	/** Номер строки на момент парса. ТОЛЬКО подсказка — не идентичность. */
	lineStart: number;
	lineEnd: number;
	/** Номер строки родительского пункта списка; null для корневых. */
	parentLine: number | null;
	/** Ближайший заголовок выше по файлу. */
	heading: string | null;

	// --- текст ---
	/** Текст строки без эмодзи-полей и без тегов колонок досок. */
	description: string;
	/** Дословная исходная строка — источник для write-back без потерь. */
	rawLine: string;

	// --- статус ---
	/** Символ внутри [ ]. */
	statusChar: string;

	// --- даты (эмодзи-поля) ---
	due: IsoDate | null; // 📅
	scheduled: IsoDate | null; // ⏳
	start: IsoDate | null; // 🛫  — defer-until для тикля
	created: IsoDate | null; // ➕
	done: IsoDate | null; // ✅
	cancelled: IsoDate | null; // ❌

	// --- время (опциональный хвост "HH:mm" после даты; ТОЛЬКО у 📅/⏳/🛫) ---
	// Формат на диске: "📅 2026-07-25 14:30". Валидное время = /^([01]\d|2[0-3]):[0-5]\d$/;
	// невалидное НЕ ломает дату: дата парсится, время null, хвост остаётся текстом.
	// У ✅/❌/➕/🔜 времени нет — хвост после даты там обычный текст описания.
	dueTime: string | null;
	scheduledTime: string | null;
	startTime: string | null;

	// --- конец интервала (опциональный хвост "-HH:mm" сразу за временем начала) ---
	// Формат на диске: "📅 2026-07-25 14:30-16:00" — дефис БЕЗ пробелов.
	// Валиден только при валидном времени начала и СТРОГО позже него;
	// невалидный/не больший конец уходит тексту, дату и время начала не ломает.
	dueTimeEnd: string | null;
	scheduledTimeEnd: string | null;
	startTimeEnd: string | null;

	// --- регулярные ---
	/** 🔁 — текст правила, хранится дословно. */
	recurrence: string | null;
	/** 🔜 — курсор следующего вхождения (только у шаблонов). */
	nextSpawn: IsoDate | null;
	/** 🧬 — id шаблона, из которого порождена копия. */
	spawnedFrom: string | null;
	/** 🚫 — даты-исключения вхождений повторяющегося события (серии): вхождение
	 *  на такой дате в календаре не рендерится (перенос/отмена одного занятия).
	 *  Только валидные ISO-даты; невалидные из payload игнорируются (живут в rawLine). */
	excludedDates: IsoDate[];

	// --- прочее ---
	priority: Priority; // 🔺⏫🔼🔽⏬
	/** ⛔ — список 🆔, от которых зависит задача. */
	dependsOn: string[];
	/** #теги строки (включая #kanban/<board>/<col> и #waiting). */
	tags: string[];

	// --- контекст файла (заполняется индексатором) ---
	container: ContainerKind;
	/** Проект задачи активен (для container === "project"; иначе true). */
	projectActive: boolean;
}

/** Дата-офсет вида "-3d"/"+14d" в шаблонах регулярного ящика (ТЗ §6). */
export interface DateOffset {
	sign: 1 | -1;
	days: number;
}
