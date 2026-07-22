/**
 * Общее контекстное меню события календаря (§события): единый источник ПУНКТОВ и
 * ДЕЙСТВИЙ для чипов (месяц/агенда/«Весь день») и блоков почасовой сетки — оба
 * рендерятся компонентом EventOccurrenceChip. Раньше меню строилось инлайн в
 * компоненте; вынесено сюда, чтобы:
 *  • не дублировать построение при новых точках вызова;
 *  • сделать модель пунктов чистой и тестируемой в node (buildEventMenuModel).
 *
 * Разделение как у задач (taskMenuModel/taskMenu): buildEventMenuModel — чистая
 * модель без obsidian/DOM; showEventMenu — маппинг на obsidian Menu и исполнение
 * (модалы, порт файла событий, dispatcher).
 */
import { Menu, Notice, type App } from "obsidian";
import type { IntentDispatcher } from "../../services/WritebackService";
import { confirm } from "../common/ConfirmModal";
import { DatePromptModal } from "../common/DatePromptModal";
import { TextPromptModal } from "../common/TextPromptModal";
import { formatTimeRange, type EventOccurrence } from "./calendarLogic";
import {
	copyEventSeries,
	createSingleEvent,
	editEventSeries,
	excludeEventOccurrence,
	setEventLocation,
	splitEventRule,
	transferEventOccurrence,
	type EventVaultPort,
} from "./eventSeries";
import { EventSeriesModal } from "./EventSeriesModal";
import { SingleEventModal } from "./SingleEventModal";
import { preservedTimeEnd } from "./timeGrid";

// ---------------------------------------------------------------------------
// Чистая модель пунктов
// ---------------------------------------------------------------------------

/** Стабильный идентификатор пункта — ключ маппинга модели на действие. */
export type EventMenuItemId =
	| "edit-series"
	| "location"
	| "transfer"
	| "copy-occurrence"
	| "copy-series"
	| "copy-single"
	| "delete-occurrence"
	| "delete-series"
	| "delete-single"
	| "open-file";

export interface EventMenuItemModel {
	id: EventMenuItemId;
	title: string;
	icon: string;
}

/**
 * Модель пунктов меню события по ВИДУ строки (серия/одноразовое) и наличию 📍.
 * Ноль obsidian/DOM — тестируется в node.
 *  • серия: изменить серию / место / перенести вхождение / копировать вхождение /
 *    копировать серию / удалить это вхождение / удалить серию;
 *  • одноразовое: место / перенести событие / копировать / удалить.
 *
 * Подпись места: «Добавить место…» без 📍, «Изменить место…» при наличии.
 * Подпись переноса различает kind: у серии «Перенести вхождение…» (гаснет одно
 * занятие серии), у одноразового «Перенести событие…» (правится сама строка 📅/
 * время, без механики исключений 🚫).
 */
export function buildEventMenuModel(
	kind: "series" | "single",
	hasLocation: boolean,
	external = false,
): EventMenuItemModel[] {
	// Внешний календарь (зеркало, gtd-external) — READ-ONLY: правка/удаление/перенос
	// затёрлись бы синхронизацией, поэтому НЕ предлагаем их. Только «Копировать…»
	// (создаёт НАШЕ одноразовое событие в обычном файле) и «Открыть файл».
	if (external) {
		return [
			{ id: kind === "series" ? "copy-occurrence" : "copy-single", title: "Копировать…", icon: "copy" },
			{ id: "open-file", title: "Открыть файл", icon: "file" },
		];
	}
	const locationTitle = hasLocation ? "Изменить место…" : "Добавить место…";
	if (kind === "series") {
		return [
			{ id: "edit-series", title: "Изменить серию…", icon: "pencil" },
			{ id: "location", title: locationTitle, icon: "map-pin" },
			{ id: "transfer", title: "Перенести вхождение…", icon: "calendar-clock" },
			{ id: "copy-occurrence", title: "Копировать вхождение…", icon: "copy" },
			{ id: "copy-series", title: "Копировать серию…", icon: "copy" },
			{ id: "delete-occurrence", title: "Удалить это вхождение", icon: "calendar-x" },
			{ id: "delete-series", title: "Удалить серию", icon: "trash" },
		];
	}
	return [
		{ id: "location", title: locationTitle, icon: "map-pin" },
		{ id: "transfer", title: "Перенести событие…", icon: "calendar-clock" },
		{ id: "copy-single", title: "Копировать…", icon: "copy" },
		{ id: "delete-single", title: "Удалить событие", icon: "trash" },
	];
}

// ---------------------------------------------------------------------------
// Исполнение действий (модалы + порт файла событий)
// ---------------------------------------------------------------------------

/** Всё, что нужно действию меню: вхождение + порты. */
export interface EventMenuDeps {
	occ: EventOccurrence;
	app: App;
	dispatcher: IntentDispatcher;
	vault: EventVaultPort;
	/** Строка события — из файла-зеркала внешнего календаря (read-only). Меняет
	 *  меню на «Копировать…»/«Открыть файл». По умолчанию false (обычное событие). */
	external?: boolean;
	/** Целевой файл для «Копировать…» у ВНЕШНЕГО события: копия создаётся как НАШЕ
	 *  одноразовое событие в обычном файле событий (не в зеркале). Для обычных
	 *  событий не задаётся — копия ложится в тот же файл, что источник. */
	copyTargetFile?: string;
}

/** Есть ли непустое 📍 у вхождения — влияет на подпись пункта места. */
function hasLocation(occ: EventOccurrence): boolean {
	return occ.location !== null && occ.location.trim() !== "";
}

/** «Изменить серию»: модал серии, преднаполненный названием/правилом/временем/местом. */
function openEdit(deps: EventMenuDeps): void {
	const { occ, app, vault } = deps;
	const { rule, time } = splitEventRule(occ.task.recurrence ?? "");
	new EventSeriesModal(
		app,
		{ name: occ.title, rule, time, location: occ.location ?? "" },
		"Изменить серию",
		(name, ruleText, location) => {
			void editEventSeries({ vault, task: occ.task, name, ruleText, location }).then((res) => {
				if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			});
		},
	).open();
}

/** «Добавить/Изменить место…» — промпт с текущим 📍 (пусто — снять поле). Правит
 *  строку серии ИЛИ одноразового одной записью (setEventLocation). */
function openLocation(deps: EventMenuDeps): void {
	const { occ, app, vault } = deps;
	new TextPromptModal(
		app,
		"Место события",
		(value) => {
			void setEventLocation({
				vault,
				task: occ.task,
				location: value === "" ? null : value,
			}).then((res) => {
				if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			});
		},
		occ.location ?? "",
		"Адрес или место (пусто — убрать)",
	).open();
}

/** Перенести на выбранные дату+время (та же атомарная запись, что и drag).
 *  Серия — гасит вхождение (🚫) и порождает одноразовую строку; одноразовое —
 *  правит собственную 📅/время. Длительность сохраняется (preservedTimeEnd). */
async function applyTransfer(
	deps: EventMenuDeps,
	toDate: string,
	time: string | null,
): Promise<void> {
	const { occ, vault } = deps;
	const timeEnd = time === null ? null : (preservedTimeEnd(occ.time, occ.timeEnd, time) ?? null);
	const res = await transferEventOccurrence({
		vault,
		task: occ.task,
		kind: occ.kind,
		fromDate: occ.date,
		toDate,
		time,
		timeEnd,
	});
	if (res.ok) new Notice(`Перенесено: ${occ.date} → ${toDate}`);
	else new Notice(`GTD Flow: ${res.reason}`);
}

function openTransfer(deps: EventMenuDeps): void {
	const { occ, app } = deps;
	// подпись различает серию и одноразовое: у одноразового переносится сама строка
	// (уместнее «Перенести событие…»), у серии — отдельное вхождение
	const title = occ.kind === "single" ? "Перенести событие…" : "Перенести вхождение…";
	new DatePromptModal(
		app,
		title,
		(date, time) => void applyTransfer(deps, date, time),
		occ.date,
		true,
		occ.time,
	).open();
}

/**
 * Копировать в НОВОЕ одноразовое событие: модал одноразового, преднаполненный
 * полями этого вхождения. Результат — независимое одноразовое событие в ТОМ ЖЕ
 * файле, что источник (серия не трогается: 🧬-связи нет). modalTitle различает
 * пункты «Копировать…»/«Копировать вхождение…».
 */
function openCopyAsSingle(deps: EventMenuDeps, modalTitle: string): void {
	const { occ, app, vault } = deps;
	// У ВНЕШНЕГО события копия уходит в ОБЫЧНЫЙ файл событий (copyTargetFile), а не
	// в зеркало (оно read-only). У обычного события — в тот же файл, что источник.
	const eventsFile = deps.copyTargetFile ?? occ.task.filePath;
	new SingleEventModal(
		app,
		{
			name: occ.title,
			date: occ.date,
			time: formatTimeRange(occ.time, occ.timeEnd),
			location: occ.location ?? "",
		},
		modalTitle,
		(name, date, time, timeEnd, location) => {
			void createSingleEvent({
				vault,
				eventsFile,
				name,
				date,
				time,
				timeEnd,
				location,
			}).then((res) => {
				if (res.ok) new Notice("GTD Flow: событие создано");
				else new Notice(`GTD Flow: ${res.reason}`);
			});
		},
	).open();
}

/** «Открыть файл» (внешнее событие): открыть файл-зеркало в новой вкладке. */
function openEventFile(deps: EventMenuDeps): void {
	const file = deps.app.vault.getFileByPath(deps.occ.task.filePath);
	if (file === null) {
		new Notice("GTD Flow: файл события не найден");
		return;
	}
	void deps.app.workspace.getLeaf(true).openFile(file);
}

/** Копировать серию: модал серии → НОВАЯ серия со свежим 🆔 в том же файле. */
function openCopySeries(deps: EventMenuDeps): void {
	const { occ, app, vault } = deps;
	const { rule, time } = splitEventRule(occ.task.recurrence ?? "");
	new EventSeriesModal(
		app,
		{ name: occ.title, rule, time, location: occ.location ?? "" },
		"Копировать серию",
		(name, ruleText, location) => {
			void copyEventSeries({ vault, eventsFile: occ.task.filePath, name, ruleText, location }).then(
				(res) => {
					if (res.ok) new Notice("GTD Flow: серия создана");
					else new Notice(`GTD Flow: ${res.reason}`);
				},
			);
		},
	).open();
}

/** Удалить серию: delete-line строки серии (с confirm). */
async function deleteSeries(deps: EventMenuDeps): Promise<void> {
	const { occ, app, dispatcher } = deps;
	const ok = await confirm(
		app,
		"Удалить серию?",
		`Удалить повторяющееся событие «${occ.title}»? Все его будущие вхождения ` +
			`исчезнут из календаря.`,
		"Удалить серию",
	);
	if (!ok) return;
	const res = await dispatcher.dispatch({ type: "delete-line", key: occ.task.key });
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
}

/** Удалить это вхождение серии: 🚫 <дата> (обратимо) — без confirm. */
async function deleteOccurrence(deps: EventMenuDeps): Promise<void> {
	const { occ, vault } = deps;
	const res = await excludeEventOccurrence({ vault, task: occ.task, date: occ.date });
	if (res.ok) new Notice(`Вхождение ${occ.date} удалено`);
	else new Notice(`GTD Flow: ${res.reason}`);
}

/** Удалить одноразовое событие: delete-line строки (с confirm как у серии). */
async function deleteSingle(deps: EventMenuDeps): Promise<void> {
	const { occ, app, dispatcher } = deps;
	const ok = await confirm(
		app,
		"Удалить событие?",
		`Удалить событие «${occ.title}» (${occ.date})?`,
		"Удалить событие",
	);
	if (!ok) return;
	const res = await dispatcher.dispatch({ type: "delete-line", key: occ.task.key });
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
}

/** Маппинг id пункта на действие (единая точка исполнения меню). */
function runEventMenuAction(id: EventMenuItemId, deps: EventMenuDeps): void {
	switch (id) {
		case "edit-series":
			return openEdit(deps);
		case "location":
			return openLocation(deps);
		case "transfer":
			return openTransfer(deps);
		case "copy-occurrence":
			return openCopyAsSingle(deps, "Копировать вхождение как событие");
		case "copy-series":
			return openCopySeries(deps);
		case "copy-single":
			return openCopyAsSingle(deps, "Копировать событие");
		case "delete-occurrence":
			return void deleteOccurrence(deps);
		case "delete-series":
			return void deleteSeries(deps);
		case "delete-single":
			return void deleteSingle(deps);
		case "open-file":
			return openEventFile(deps);
	}
}

/**
 * Собрать и показать контекстное меню события у курсора. Один источник для
 * чипов и блоков почасовой сетки (оба — EventOccurrenceChip). Вызыватель уже
 * сделал preventDefault/stopPropagation события.
 */
export function showEventMenu(evt: MouseEvent, deps: EventMenuDeps): void {
	const model = buildEventMenuModel(deps.occ.kind, hasLocation(deps.occ), deps.external === true);
	const menu = new Menu();
	for (const item of model) {
		menu.addItem((mi) =>
			mi
				.setTitle(item.title)
				.setIcon(item.icon)
				.onClick(() => runEventMenuAction(item.id, deps)),
		);
	}
	menu.showAtMouseEvent(evt);
}
