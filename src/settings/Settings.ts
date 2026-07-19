/** Модель настроек (ТЗ §9). Персистится через loadData/saveData. */

import { DEFAULT_NS, normalizeNsPath, type NamespaceDef } from "../core/namespace/namespace";

export type PromoteTo = "origin" | "inbox";
export type CatchUpPolicy = "latest" | "all" | "none";
export type CalendarField = "due" | "scheduled" | "start";
/** Тип записи инлайн-ввода календаря (переключатель «Задача | Событие»). Канон
 *  союза живёт здесь — настройка lastQuickAddKind его же и хранит. */
export type QuickAddKind = "task" | "event";

export interface DeferPreset {
	label: string;
	/** Смещение в днях от сегодня. */
	offsetDays: number;
}

export interface GtdFlowSettings {
	/** Корневая папка «Общего» — «дом» для файлов, создаваемых в пространстве «Общее»
	 *  (по конвенции NS_CONVENTION от этой папки, ровно как именованное пространство
	 *  создаёт от своего корня): захват «Общего» → `<commonRoot>/Входящие.md` и т.д.
	 *  ВАЖНО: это папка ДЛЯ СОЗДАНИЯ, а не признак принадлежности — любой файл ВНЕ
	 *  корней пространств относится к «Общему» независимо от того, где он лежит.
	 *  Заменил выпиленную настройку inboxSources (фидбек-раунд 2 итерации 2). */
	commonRoot: string;
	/** Включать ли во «Входящие» активные задачи из ОБЫЧНЫХ заметок (container
	 *  "plain"). false (по умолчанию) — входящие ограничены файлами GTD Flow:
	 *  захват (gtd-inbox) и готовые задачи проектов. true — старое поведение,
	 *  во входящие попадают активные неразобранные задачи из любого файла
	 *  хранилища. Календарь/отложенные/доски настройка не затрагивает. */
	inboxIncludePlain: boolean;
	/** Как определяется hasProject вне gtd-project файлов. */
	projectStrategy: "tag" | "folder";
	projectTagPrefix: string;
	/** Приоритет поля для размещения задачи в календаре. */
	calendarPlacement: CalendarField[];
	deferPresets: DeferPreset[];
	firstDayOfWeek: number; // 0=вс … 6=сб
	/** Кастомные символы статуса → GTD-состояние (переопределения). */
	statusMap: Record<string, string>;
	/** Доска по умолчанию для вида Kanban; пусто — первая найденная. */
	defaultBoardPath: string;
	autoInjectId: boolean;
	debounceMs: { fileReindex: number; queryRecompute: number };
	virtualizeThreshold: number;
	promoteTo: PromoteTo;
	/** Последний день, обработанный проходом «всплытия во входящие» (PromoteService);
	 *  null — проходов ещё не было (первый лишь усыновляет текущую дату). Не в UI. */
	promoteLastRun: string | null;
	recurring: {
		spawnTarget: string;
		catchUp: CatchUpPolicy;
		catchUpCap: number;
	};
	cardsFolder: string;
	cardLinkInLine: boolean;
	/** Файл-хранилище повторяющихся событий календаря (frontmatter gtd-events: true). */
	eventsFile: string;
	/** Файл-приёмник «Архивировать» (пункт меню доски для готовых/отменённых). */
	archiveFile: string;
	/** Файл статусов дней для покраски календаря (frontmatter gtd-day-status: true);
	 *  используется при первом создании, обнаружение — по флагу. */
	dayStatusFile: string;
	/** Пройден ли онбординг: приветственный диалог показывается один раз на чистом
	 *  хранилище (см. src/onboarding). Существующему пользователю выставляется молча. */
	onboarded: boolean;
	/** Пользовательские пространства (гибрид «пространство = папка»): имя → корневая
	 *  папка. Пустой список (по умолчанию) ⇒ пространств не настроено, поведение и UI
	 *  прежние (обратная совместимость без единой настройки). Массив заменяется целиком
	 *  при слиянии (см. mergeSettings). Резолвинг/членство — src/core/namespace. */
	namespaces: NamespaceDef[];
	/** Активное пространство — ОДНО на всё приложение, персистится. Sentinel DEFAULT_NS
	 *  («Общее») по умолчанию: всё вне пользовательских корней и без frontmatter-override.
	 *  При загрузке нормализуется (см. normalizeActiveNamespace): удалённое из namespaces
	 *  пространство откатывается к DEFAULT_NS. */
	activeNamespace: string;
	/** Липкое положение переключателя «Задача | Событие» инлайн-ввода календаря:
	 *  последний выбор пользователя переживает перезапуск. В UI настроек НЕ показывается —
	 *  меняется только кликом по переключателю в сетке. Дефолт — «Задача». */
	lastQuickAddKind: QuickAddKind;
}

export const DEFAULT_SETTINGS: GtdFlowSettings = {
	commonRoot: "GTD",
	inboxIncludePlain: false,
	projectStrategy: "tag",
	projectTagPrefix: "#project/",
	calendarPlacement: ["due", "scheduled", "start"],
	deferPresets: [
		{ label: "Завтра", offsetDays: 1 },
		{ label: "+3 дня", offsetDays: 3 },
		{ label: "Через неделю", offsetDays: 7 },
	],
	firstDayOfWeek: 1,
	statusMap: {},
	defaultBoardPath: "",
	autoInjectId: true,
	debounceMs: { fileReindex: 150, queryRecompute: 50 },
	virtualizeThreshold: 100,
	// Дефолт "inbox" (фидбек пользователя): когда 🛫 наступает сама, задача
	// приходит именно во «Входящие» своего пространства, а не остаётся на месте.
	promoteTo: "inbox",
	promoteLastRun: null,
	recurring: {
		spawnTarget: "GTD/Inbox.md",
		catchUp: "latest",
		catchUpCap: 30,
	},
	cardsFolder: "GTD/Cards",
	cardLinkInLine: true,
	eventsFile: "GTD/Events.md",
	archiveFile: "GTD/Archive.md",
	dayStatusFile: "GTD/DayStatus.md",
	onboarded: false,
	namespaces: [],
	activeNamespace: DEFAULT_NS,
	lastQuickAddKind: "task",
};

/**
 * «Дефолт следует за commonRoot»: если путь-настройка остался фабричным дефолтом,
 * а пользователь сменил commonRoot, пересобрать путь как `<commonRoot>/<имя-файла>`
 * (имя берём из фабричного дефолта). Пользовательский путь (≠ дефолту) не трогаем —
 * он задан осознанно. Пустой commonRoot ⇒ голое имя файла (в корне хранилища).
 *
 * Применяется к dayStatusFile (см. main.ts): при commonRoot="GTD" (дефолт) выдаёт
 * тот же "GTD/DayStatus.md" — no-op обратной совместимости; при commonRoot="Жизнь" и
 * нетронутом поле — "Жизнь/DayStatus.md". spawnTarget этому правилу НЕ следует (по ТЗ).
 */
export function defaultUnderCommonRoot(
	current: string,
	factoryDefault: string,
	commonRoot: string,
): string {
	if (current !== factoryDefault) return current;
	const base = factoryDefault.split("/").pop() ?? factoryDefault;
	const root = normalizeNsPath(commonRoot);
	return root === "" ? base : `${root}/${base}`;
}
