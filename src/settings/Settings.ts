/** Модель настроек (ТЗ §9). Персистится через loadData/saveData. */

import type { PromotionRetry } from "../core/tickler/promote";

export type PromoteTo = "origin" | "inbox";
export type CatchUpPolicy = "latest" | "all" | "none";
export type CalendarField = "due" | "scheduled" | "start";
export type AiPrivacyPolicy = "unconfigured" | "account-policy" | "require-zdr";
export type AiCredentialStorage = "unconfigured" | "memory-only";
export type DurationLongStyle = "whole-days";
/** Тип записи инлайн-ввода календаря (переключатель «Задача | Событие»). Канон
 *  союза живёт здесь — настройка lastQuickAddKind его же и хранит. */
export type QuickAddKind = "task" | "event";

/**
 * Версия формата data.json.  Она отделена от версии плагина: формат настроек
 * меняется только когда требуется миграция сохранённых пользовательских данных.
 */
export const SETTINGS_FORMAT_VERSION = 4;

export interface DeferPreset {
	label: string;
	/** Смещение в днях от сегодня. */
	offsetDays: number;
}

/**
 * Подписка на внешний iCal-календарь (§внешние календари). Материализуется в
 * файл-зеркало рядом с единым GTD-хранилищем. Персистится в data.json.
 * lastSyncAt/lastError — статус последней синхронизации (обновляет SyncService).
 */
export interface ExternalCalendarSub {
	/** Стабильный внутренний id (ключ статуса/удаления); не меняется при правках. */
	id: string;
	/** Отображаемое имя (frontmatter, заголовок, имя файла-зеркала). */
	name: string;
	/** Секретный/публичный адрес .ics-ленты. Хранится локально в data.json. */
	url: string;
	/** Epoch-мс последней УСПЕШНОЙ синхронизации; null — ещё не синхронизировалась. */
	lastSyncAt: number | null;
	/** Текст последней ошибки (сеть/разбор) или null — последняя попытка успешна. */
	lastError: string | null;
}

export interface GtdFlowSettings {
	/** Версия сериализованного формата data.json (не версия плагина). */
	settingsVersion: number;
	/** Single Markdown inbox. Capture, promotion, and recurrence write here. */
	inboxFile: string;
	/**
	 * AI remains inert until the user explicitly enables it. Account-policy
	 * routing and memory-only credentials are the decided MVP defaults; secrets
	 * are never represented here.
	 */
	ai: {
		enabled: boolean;
		privacyPolicy: AiPrivacyPolicy;
		credentialStorage: AiCredentialStorage;
		/** Version of the synced `.gtd-flow` record layout seen by this device. */
		storageVersion: number;
	};
	/** Durations from 24 hours upward are valid only as whole days and display as such. */
	durationLongStyle: DurationLongStyle;
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
	/** Незавершённые многофайловые promotion-операции. Запись создаётся ДО снятия
	 * 🛫, поэтому следующий проход может продолжить работу после краша/отказа. */
	promoteRetries: PromotionRetry[];
	recurring: {
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
	/** Липкое положение переключателя «Задача | Событие» инлайн-ввода календаря:
	 *  последний выбор пользователя переживает перезапуск. В UI настроек НЕ показывается —
	 *  меняется только кликом по переключателю в сетке. Дефолт — «Задача». */
	lastQuickAddKind: QuickAddKind;
	/** Подписки на внешние iCal-календари (§внешние календари). Массив заменяется
	 *  целиком при слиянии (см. mergeSettings). Пусто — фича неактивна. */
	externalCalendars: ExternalCalendarSub[];
	/** Интервал поллинга внешних календарей в минутах (min 1, дефолт 5). */
	externalSyncIntervalMin: number;
}

/**
 * Новая независимая модель настроек.  Не используем копирование
 * DEFAULT_SETTINGS: SettingsTab намеренно меняет вложенные массивы на месте,
 * поэтому ссылка на экспортированный литерал не должна когда-либо попасть в
 * живые настройки плагина.
 */
export function createDefaultSettings(): GtdFlowSettings {
	return {
		settingsVersion: SETTINGS_FORMAT_VERSION,
		inboxFile: "GTD/Inbox.md",
		ai: {
			enabled: false,
			privacyPolicy: "account-policy",
			credentialStorage: "memory-only",
			storageVersion: 0,
		},
		durationLongStyle: "whole-days",
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
		// Дефолт "inbox": когда наступает 🛫, задача переносится в единый
		// настроенный файл входящих, а не остаётся в исходной заметке.
		promoteTo: "inbox",
		promoteLastRun: null,
		promoteRetries: [],
		recurring: {
			catchUp: "latest",
			catchUpCap: 30,
		},
		cardsFolder: "GTD/Cards",
		cardLinkInLine: true,
		eventsFile: "GTD/Events.md",
		archiveFile: "GTD/Archive.md",
		dayStatusFile: "GTD/DayStatus.md",
		onboarded: false,
		lastQuickAddKind: "task",
		externalCalendars: [],
		externalSyncIntervalMin: 5,
	};
}

/**
 * Публичная константа сохранена для обратной совместимости потребителей и
 * тестов.  Глубокая заморозка превращает случайную попытку изменить фабричный
 * шаблон в явную ошибку; для реальной работы всегда вызывается
 * createDefaultSettings()/mergeSettings().
 */
export const DEFAULT_SETTINGS: GtdFlowSettings = deepFreeze(createDefaultSettings());

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}
