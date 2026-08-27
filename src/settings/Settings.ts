/** Модель настроек (ТЗ §9). Персистится через loadData/saveData. */

import type { PromotionRetry } from "../core/tickler/promote";
import type { ExternalSyncErrorCode } from "../sync/externalSyncStatus";

export type PromoteTo = "origin" | "inbox";
export type CatchUpPolicy = "latest" | "all" | "none";
export type CalendarField = "due" | "scheduled" | "start";
export type AiPrivacyPolicy = "unconfigured" | "account-policy" | "require-zdr";
export type AiCredentialStorage = "unconfigured" | "memory-only";
export type DurationLongStyle = "whole-days";
/** Тип записи инлайн-ввода календаря (переключатель «Задача | Событие»). Канон
 *  союза живёт здесь — настройка lastQuickAddKind его же и хранит. */
export type QuickAddKind = "task" | "event";

/** Размер шрифта календаря: пресеты масштаба относительно UI-шрифта Obsidian
 *  (--font-ui-smaller). «standard» — прежний вид без изменений. */
export type CalendarFontSize = "small" | "standard" | "large" | "x-large";

/** Масштаб для каждого пресета: применяется CSS-переменной
 *  --gtd-cal-font-scale на корне календаря — иерархия размеров внутри вида
 *  сохраняется (все font-size умножаются на общий множитель). */
export const CALENDAR_FONT_SCALE: Record<CalendarFontSize, number> = {
	small: 0.85,
	standard: 1,
	large: 1.15,
	"x-large": 1.3,
};

/**
 * Версия формата data.json.  Она отделена от версии плагина: формат настроек
 * меняется только когда требуется миграция сохранённых пользовательских данных.
 *
 * v5 (CalDAV): дискриминированный союз источников внешних календарей
 * (ics/caldav/invalid), реестр caldavAccounts, санитизированный errorCode в
 * статусе подписки. ИНВАРИАНТ этапа: полный набор персистентных полей v5
 * зафиксирован одним коммитом — последующие этапы добавляют только поведение,
 * но не поля (иначе уже проштампованные v5-хранилища не получат их миграцию).
 */
export const SETTINGS_FORMAT_VERSION = 5;

export interface DeferPreset {
	label: string;
	/** Смещение в днях от сегодня. */
	offsetDays: number;
}

/** Режим приватности CalDAV-коллекции (§4.3 CalDAV-заказа). "unconfigured" —
 *  draft-состояние после discovery: пользователь ещё не сделал явный выбор,
 *  и подписку НЕЛЬЗЯ включить или синхронизировать (гейт на sync-слое). */
export type ExternalPrivacyMode = "unconfigured" | "details" | "busy";

/** Общие поля активных подписок (ics и caldav). */
interface ExternalCalendarSubCommon {
	/** Стабильный внутренний id (ключ статуса/удаления); не меняется при правках. */
	id: string;
	/** Отображаемое имя (frontmatter, заголовок, имя файла-зеркала). */
	name: string;
	/** Epoch-мс последней УСПЕШНОЙ синхронизации; null — ещё не синхронизировалась. */
	lastSyncAt: number | null;
	/**
	 * Устаревшее поле сырого текста ошибки (до v5). v5-писатели держат его
	 * null; поле сохранено, чтобы откат на 0.14.1 продолжал загружать
	 * ICS-подписки без сброса массива (rollback-совместимость).
	 */
	lastError: string | null;
	/** Санитизированный код последней ошибки (v5+); null — последняя попытка
	 *  успешна или попыток ещё не было. Никогда не содержит сырой текст. */
	errorCode: ExternalSyncErrorCode | null;
}

/**
 * Подписка на внешний iCal-календарь (§внешние календари). Материализуется в
 * файл-зеркало рядом с единым GTD-хранилищем. Персистится в data.json.
 * `kind` отсутствует в legacy-файлах — отсутствие читается как "ics"
 * (сознательно отложенная миграция секретного URL в SecretStorage: §8 заказа).
 */
export interface IcsCalendarSub extends ExternalCalendarSubCommon {
	kind?: "ics";
	/** Секретный/публичный адрес .ics-ленты. Хранится локально в data.json. */
	url: string;
}

/**
 * Read-only CalDAV-подписка: одна выбранная коллекция одного аккаунта.
 * Никаких href/username/token здесь — только opaque-ключи; всё
 * identity-содержащее живёт в SecretStorage (§5.1 CalDAV-заказа).
 */
export interface CalDavCalendarSub extends ExternalCalendarSubCommon {
	kind: "caldav";
	/** Ссылка на CalDavAccount.id (реестр caldavAccounts). */
	accountId: string;
	/** Opaque стабильный ключ коллекции (НЕ href и НЕ display name). */
	collectionKey: string;
	privacy: ExternalPrivacyMode;
	/** Явное включение синхронизации; false и privacy "unconfigured" — не синкать. */
	enabled: boolean;
	/** Optional GTD-scope: канонический 🧭 в строках зеркала; null — глобально. */
	scopeId: string | null;
	/**
	 * Durable-маркер fail-closed сжатия приватности (details → busy, §4.3):
	 * true — детальное зеркало ещё не зачищено; подписка остаётся за fence и
	 * не синкается, пока зачистка не завершится. Никогда не откатывает privacy.
	 */
	pendingRedaction: boolean;
}

/**
 * Инертная запись вместо повреждённой/неизвестной подписки: не синкается, не
 * активируется молча и не удаляется молча (§8 заказа — fail-closed без потери
 * записи). Исходный payload сброшен намеренно: он не прошёл схему и не должен
 * жить в data.json. Зеркало с этим id защищено от orphan-очистки.
 */
export interface InvalidCalendarSub {
	kind: "invalid";
	id: string;
	/** Класс причины (имя поля/код), никогда — отклонённое значение. */
	reason: string;
}

export type ExternalCalendarSub = IcsCalendarSub | CalDavCalendarSub | InvalidCalendarSub;
/** Подписки, которые участвуют в синхронизации/зеркалировании. */
export type ActiveCalendarSub = IcsCalendarSub | CalDavCalendarSub;

/**
 * Аккаунт CalDAV-сервера (§4.1 CalDAV-заказа). Ровно один credential в
 * SecretStorage на аккаунт; несколько подписок-коллекций могут ссылаться на
 * один accountId. Здесь НЕТ username/token/href — только https-origin и
 * opaque-ссылка на секрет.
 */
export interface CalDavAccount {
	/** Opaque id (^[a-z0-9]+(-[a-z0-9]+)*$ — контракт SecretStorage-ключей). */
	id: string;
	/** ТОЛЬКО https-origin без пути/query (например "https://caldav.example"). */
	serverOrigin: string;
	/** Имя записи в Obsidian SecretStorage (тот же формат, что id). */
	secretRef: string;
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
	/** Размер шрифта вида «Календарь» (пресет масштаба; дефолт — standard). */
	calendarFontSize: CalendarFontSize;
	/** Подписки на внешние календари (§внешние календари). Слияние — по
	 *  записям: битая запись деградирует в InvalidCalendarSub, соседние
	 *  подписки сохраняются (см. mergeSettings). Пусто — фича неактивна. */
	externalCalendars: ExternalCalendarSub[];
	/** Реестр CalDAV-аккаунтов (без секретов и identity; см. CalDavAccount). */
	caldavAccounts: CalDavAccount[];
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
		calendarFontSize: "standard",
		externalCalendars: [],
		caldavAccounts: [],
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
