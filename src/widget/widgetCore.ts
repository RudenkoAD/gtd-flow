/**
 * widgetCore — единая точка входа JS-бандла ядра для Android-виджетов GTD Flow.
 *
 * Бандл (esbuild.widget.mjs → widget-core.js, iife GtdWidgetCore) исполняется во
 * ВСТРАИВАЕМОМ движке (QuickJS) БЕЗ node/DOM/npm: ни fs, ни obsidian, ни Date.now()/
 * Intl. Всё время приходит ИЗ ВХОДА (todayIso, nowMinutes) — вычисления детерминированы
 * и воспроизводимы. Реализация — тонкая обвязка над чистым ядром (src/core) и приёмами
 * standalone-сервера (src/mcp): индекс строится тем же IndexerService, «сегодня»
 * агрегирует события (expandEventOccurrences календаря) и задачи (placeEvents по
 * calendarPlacement), «входящие» — тем же QueryEngine inbox-запросом, что MCP
 * list_tasks view:'inbox'. Ошибки изолируются в errors[] — виджет не должен падать.
 *
 * Экспорт (звать из QuickJS как GtdWidgetCore.<name>) — API v2:
 *  • computeWidgetData(input) → JSON-строка данных виджета. input.inboxNamespace
 *    'Все' (ALL_NS) → входящие-АГРЕГАТ со всех пространств, у каждого item namespace.
 *    input.agendaDays?: number (0/нет = не считать; максимум 30) → секция agenda.days
 *    по дням от todayIso включительно (тот же состав/сортировка, что today.items).
 *    Элементы today/agenda обогащены rawLine/itemKind/recurrenceText (для шторки деталей).
 *  • buildCaptureLine(text, location?) → строка быстрого захвата '- [ ] …[ 📍 …]';
 *  • captureTargetPath(dataJson, namespace?) → путь файла входящих пространства;
 *  • buildEditedLine(rawLine, edits) → JSON {ok:true,line} | {ok:false,error}: правка
 *    строки задачи/события (title/date/timeRange/location) для шторки деталей.
 */
import {
	DEFAULT_NS,
	NS_CONVENTION,
	nsCommonTarget,
	type NamespaceDef,
} from "../core/namespace/namespace";
import type { Task } from "../core/model/Task";
import type { CalendarField } from "../core/model/projections";
import { setValueField } from "../core/parser/serializeTaskLine";
import { evaluate, type QueryContext } from "../core/query/QueryEngine";
import { defaultInboxConfig } from "../core/query/querySpec";
import {
	isArchived,
	isCancelled,
	isDetail,
	isDone,
	isEvent,
	isTemplate,
} from "../core/model/gtdState";
import {
	expandEventOccurrences,
	placeEvents,
	placedTime,
	placedTimeEnd,
} from "../views/calendar/calendarLogic";
import { minutesToTime, timeToMinutes } from "../views/calendar/timeGrid";
import { addDaysIso } from "../views/common/dates";
import { quickCaptureLine } from "../views/common/taskActions";
import { buildWidgetIndex, errorMessage } from "./widgetIndex";
import {
	fileNsLabel,
	loadWidgetSettings,
	nsLabel,
	resolveWidgetActive,
	widgetFilter,
} from "./widgetSettings";

// ---------------------------------------------------------------------------
// Публичные типы входа/выхода
// ---------------------------------------------------------------------------

export interface WidgetInput {
	/** Путь относительно vault → содержимое md. Только релевантные файлы (но функция
	 *  корректна и на полном наборе). */
	files: Record<string, string>;
	/** Сырой data.json плагина; null ⇒ дефолты. */
	dataJson: string | null;
	/** Локальная дата телефона 'YYYY-MM-DD'. */
	todayIso: string;
	/** Минуты от полуночи — для маркера «сейчас» (в generatedAt). */
	nowMinutes: number;
	/** Пространство виджета входящих; null/отсутствует ⇒ «Общее»; «Все» ⇒ агрегат. */
	inboxNamespace?: string | null;
	/** Сколько дней агенды считать от todayIso включительно (0/нет = не считать;
	 *  клампится к [0, 30]). Пустые дни в agenda.days включаются с items: []. */
	agendaDays?: number;
}

/** Вид элемента ленты (для шторки деталей): одноразовое событие, вхождение серии
 *  или обычная задача. `kind` (event|task) остаётся для обратной совместимости. */
export type WidgetItemKind = "single-event" | "series-occurrence" | "task";

export interface WidgetTodayItem {
	kind: "event" | "task";
	/** Уточнённый вид: 'single-event' | 'series-occurrence' | 'task'. */
	itemKind: WidgetItemKind;
	title: string;
	startMinutes: number | null;
	endMinutes: number | null;
	allDay: boolean;
	location: string | null;
	file: string;
	line: number;
	namespace: string;
	/** Исходная строка файла — источник правок шторки (buildEditedLine). */
	rawLine: string;
	/** Текст правила 🔁 для вхождения серии; null для одноразового события/задачи. */
	recurrenceText: string | null;
}

export interface WidgetInboxItem {
	title: string;
	file: string;
	line: number;
	id: string | null;
	location: string | null;
	/** Пространство файла-источника (метка) — нужно агрегату «Все». */
	namespace: string;
}

/** Один день агенды: дата и лента того же состава/сортировки, что today.items. */
export interface WidgetAgendaDay {
	date: string;
	items: WidgetTodayItem[];
}

export interface WidgetData {
	today: { date: string; items: WidgetTodayItem[]; generatedAt: string };
	agenda: { days: WidgetAgendaDay[] };
	inbox: { namespace: string; items: WidgetInboxItem[] };
	namespaces: { name: string; root: string }[];
	errors: string[];
}

// ---------------------------------------------------------------------------
// computeWidgetData
// ---------------------------------------------------------------------------

/**
 * Собрать данные виджета и вернуть JSON-строку (структура — WidgetData). Ни один
 * сбой не роняет результат: сообщения копятся в errors[], затронутая секция остаётся
 * пустой. Вся семантика времени — из todayIso/nowMinutes (никакого Date.now()).
 */
export async function computeWidgetData(input: WidgetInput): Promise<string> {
	const errors: string[] = [];

	// защита входа: функцию зовут из внешнего движка, аргументы не гарантированы
	const files =
		input && typeof input.files === "object" && input.files !== null ? input.files : {};
	const todayIso = input && typeof input.todayIso === "string" ? input.todayIso : "";
	const nowMinutes =
		input && typeof input.nowMinutes === "number" && Number.isFinite(input.nowMinutes)
			? input.nowMinutes
			: 0;
	const dataJson = input && typeof input.dataJson === "string" ? input.dataJson : null;

	const { settings, error: settingsError } = loadWidgetSettings(dataJson);
	if (settingsError !== null) errors.push(settingsError);
	const defs = settings.namespaces;

	// --- индекс ---
	let allTasks: Task[] = [];
	let resolveDep: QueryContext["resolveDep"] = () => [];
	try {
		const idx = await buildWidgetIndex(files, todayIso, errors);
		allTasks = idx.allTasks;
		const built = idx.feed;
		resolveDep = (id: string) => built.getIndex().resolveDep(id);
	} catch (e) {
		errors.push(`index build failed: ${errorMessage(e)}`);
	}

	// --- диапазон агенды: todayIso .. todayIso+(agendaDays-1) включительно ---
	const agendaDaysRaw =
		input && typeof input.agendaDays === "number" && Number.isFinite(input.agendaDays)
			? Math.trunc(input.agendaDays)
			: 0;
	const agendaDays = Math.max(0, Math.min(30, agendaDaysRaw));
	const validToday = /^\d{4}-\d{2}-\d{2}$/.test(todayIso);
	// дни диапазона (день 0 — всегда todayIso; агенда добавляет последующие дни)
	const rangeDates: string[] = [todayIso];
	if (validToday) for (let i = 1; i < agendaDays; i++) rangeDates.push(addDaysIso(todayIso, i));
	const lastIso = rangeDates[rangeDates.length - 1]!;

	// --- сегодня + агенда: агрегат ВСЕХ пространств (события ∪ задачи с датами) ---
	const todayItems: WidgetTodayItem[] = [];
	const agendaByDate = new Map<string, WidgetTodayItem[]>();
	try {
		// события: одноразовые 📅 и вхождения серий по всему диапазону (те же
		// expandEventOccurrences, что рендерит календарь; чётность недель серий — по
		// якорю from/base/эпоха). placeEvents считает раскладку задач сразу по всем дням.
		const events = allTasks.filter((t) => t.container === "events");
		const occMap = expandEventOccurrences(events, todayIso, lastIso);

		// задачи: размещение по calendarPlacement (due→scheduled→start, как календарь);
		// шаблоны/детали/события/архив и выполненные исключены (виджет их не показывает)
		const placement: readonly CalendarField[] = settings.calendarPlacement;
		const candidates = allTasks.filter(
			(t) =>
				!isTemplate(t) &&
				!isDetail(t) &&
				!isEvent(t) &&
				!isArchived(t) &&
				!isDone(t) &&
				!isCancelled(t),
		);
		const placedMap = placeEvents(candidates, placement);

		// лента одного дня: события ∪ задачи, обогащённые (rawLine/itemKind/recurrenceText)
		const buildDay = (dateIso: string): WidgetTodayItem[] => {
			const items: WidgetTodayItem[] = [];
			for (const o of occMap.get(dateIso) ?? []) {
				const startMinutes = o.time !== null ? timeToMinutes(o.time) : null;
				const endMinutes = o.timeEnd !== null ? timeToMinutes(o.timeEnd) : null;
				items.push({
					kind: "event",
					itemKind: o.kind === "series" ? "series-occurrence" : "single-event",
					title: o.title,
					startMinutes,
					endMinutes,
					allDay: startMinutes === null,
					location: o.location,
					file: o.task.filePath,
					line: o.task.lineStart + 1,
					namespace: fileNsLabel(o.task.filePath, o.task.nsOverride, defs),
					rawLine: o.task.rawLine,
					recurrenceText: o.kind === "series" ? o.task.recurrence : null,
				});
			}
			for (const pe of placedMap.get(dateIso) ?? []) {
				const t = pe.task;
				const time = placedTime(t, pe.field);
				const timeEnd = placedTimeEnd(t, pe.field);
				const startMinutes = time !== null ? timeToMinutes(time) : null;
				const endMinutes = timeEnd !== null ? timeToMinutes(timeEnd) : null;
				items.push({
					kind: "task",
					itemKind: "task",
					title: t.description,
					startMinutes,
					endMinutes,
					allDay: startMinutes === null,
					location: t.location,
					file: t.filePath,
					line: t.lineStart + 1,
					namespace: fileNsLabel(t.filePath, t.nsOverride, defs),
					rawLine: t.rawLine,
					recurrenceText: null,
				});
			}
			sortTodayItems(items);
			return items;
		};

		const todayBuilt = buildDay(todayIso);
		todayItems.push(...todayBuilt);
		// today и agenda.days[0] — одна и та же лента (день 0 переиспользуется)
		for (const d of rangeDates) agendaByDate.set(d, d === todayIso ? todayBuilt : buildDay(d));
	} catch (e) {
		errors.push(`today failed: ${errorMessage(e)}`);
	}

	// agenda секция: только при agendaDays > 0 (пустые дни включаются с items: [])
	const agendaDaysList: WidgetAgendaDay[] =
		agendaDays > 0
			? rangeDates.map((d) => ({ date: d, items: agendaByDate.get(d) ?? [] }))
			: [];

	// --- входящие: inbox-скоуп выбранного пространства (тот же путь, что MCP inbox) ---
	const inboxActive = resolveWidgetActive(input?.inboxNamespace ?? null, settings, errors, true);
	const inboxItems: WidgetInboxItem[] = [];
	try {
		const ctx: QueryContext = {
			tasks: allTasks,
			today: todayIso,
			resolveDep,
			settingsBits: defaultInboxConfig(settings.inboxIncludePlain),
			namespace: widgetFilter(inboxActive, settings),
		};
		for (const t of evaluate({ kind: "inbox" }, ctx)) {
			inboxItems.push({
				title: t.description,
				file: t.filePath,
				line: t.lineStart + 1,
				id: t.taskId,
				location: t.location,
				namespace: fileNsLabel(t.filePath, t.nsOverride, defs),
			});
		}
	} catch (e) {
		errors.push(`inbox failed: ${errorMessage(e)}`);
	}

	const data: WidgetData = {
		today: {
			date: todayIso,
			items: todayItems,
			generatedAt: `${todayIso}T${minutesToTime(nowMinutes)}`,
		},
		agenda: { days: agendaDaysList },
		inbox: { namespace: nsLabel(inboxActive), items: inboxItems },
		namespaces: defs.map((d: NamespaceDef) => ({ name: d.name, root: d.root })),
		errors,
	};
	return JSON.stringify(data);
}

/**
 * Порядок ленты «сегодня»: сначала события «весь день» (all-day), затем со временем
 * по startMinutes возрастанию. Детерминированный тай-брейк: событие раньше задачи,
 * затем по названию, файлу и строке (стабильно между запусками одного снапшота).
 */
function sortTodayItems(items: WidgetTodayItem[]): void {
	items.sort((a, b) => {
		if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
		if (!a.allDay) {
			const sa = a.startMinutes ?? 0;
			const sb = b.startMinutes ?? 0;
			if (sa !== sb) return sa - sb;
		}
		if (a.kind !== b.kind) return a.kind === "event" ? -1 : 1;
		if (a.title !== b.title) return a.title < b.title ? -1 : 1;
		if (a.file !== b.file) return a.file < b.file ? -1 : 1;
		return a.line - b.line;
	});
}

// ---------------------------------------------------------------------------
// buildCaptureLine — строка быстрого захвата
// ---------------------------------------------------------------------------

/**
 * Строка захвата `- [ ] <текст>[ 📍 <место>]` для быстрого ввода из виджета.
 * Текст санируется тем же quickCaptureLine, что и захват плагина (схлопывание
 * пробелов, срез уже набранного префикса `- [x] `); эмодзи в тексте сохраняются
 * дословно (рядовой ввод их не содержит). Пустой текст — ОШИБКА (throw): виджету
 * нечего писать. Непустое место дописывается полем 📍 через setValueField ядра;
 * недопустимое место (эмодзи поля в значении) не роняет захват — строка
 * возвращается без 📍 (та же терпимость, что у quickAddLine календаря).
 */
export function buildCaptureLine(text: string, location?: string | null): string {
	const line = quickCaptureLine(typeof text === "string" ? text : "");
	if (line === null) throw new Error("empty capture text");
	const loc = typeof location === "string" ? location.trim() : "";
	if (loc === "") return line;
	try {
		return setValueField(line, "location", loc);
	} catch {
		return line; // эмодзи поля в месте — задача без 📍, а не отказ захвата
	}
}

// ---------------------------------------------------------------------------
// captureTargetPath — файл входящих пространства
// ---------------------------------------------------------------------------

/**
 * Путь файла входящих для записи быстрого захвата в пространстве `namespace`
 * (семантика nsCommonTarget / captureTargetInNamespace-фолбэка): именованное
 * пространство ⇒ `<root>/Входящие.md`, «Общее»/null ⇒ `<commonRoot>/Входящие.md`
 * (пустой commonRoot ⇒ голое «Входящие.md» в корне). Агрегат «Все» — не цель
 * записи, откатывается к «Общему». Существующие gtd-inbox файлы здесь не
 * учитываются (у функции нет содержимого vault) — это конвенционный путь-цель,
 * который сторона Android помечает gtd-inbox при создании (ensureCaptureFileNs).
 */
export function captureTargetPath(dataJson: string | null, namespace?: string | null): string {
	const { settings } = loadWidgetSettings(typeof dataJson === "string" ? dataJson : null);
	const errors: string[] = [];
	const active = resolveWidgetActive(namespace ?? null, settings, errors, false);
	return nsCommonTarget(active, settings.namespaces, NS_CONVENTION.inbox, settings.commonRoot);
}

// buildEditedLine — синхронная правка строки для шторки деталей (см. widgetEditLine).
// Ре-экспорт из entry делает его глобалом GtdWidgetCore.buildEditedLine в бандле.
export { buildEditedLine, type LineEdits } from "./widgetEditLine";

// re-export для удобства потребителей бандла/тестов (тип sentinel «Общее»)
export { DEFAULT_NS };
