<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { get, type Readable } from "svelte/store";
	import type { IsoDate, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import {
		CALENDAR_FONT_SCALE,
		type GtdFlowSettings,
		type QuickAddKind,
	} from "../../settings/Settings";
	import { calendarRangeStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { addDaysIso } from "../common/dates";
	import { confirm } from "../common/ConfirmModal";
	import { reportAsync } from "../common/runAction";
	import { ensureCaptureFile } from "../common/taskActions";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort, OccurrenceDrag } from "../dnd/types";
	import DayCell from "./DayCell.svelte";
	import EventChip from "./EventChip.svelte";
	import TimeGrid from "./TimeGrid.svelte";
	import CalendarToolbar from "./CalendarToolbar.svelte";
	import {
		AGENDA_PAGE_DAYS,
		DAYS3_PAGE_DAYS,
		agendaDays,
		agendaLabel,
		appendLine,
		dropDateField,
		expandEventOccurrences,
		monthGrid,
		monthTitle,
		nextAgenda,
		nextMonth,
		nextWeek,
		openTasks,
		placeEvents,
		placedTime,
		placedTimeEnd,
		prevAgenda,
		prevMonth,
		prevWeek,
		quickAddLine,
		weekRange,
		weekdayNames,
		WEEK_DAYS,
		type CalendarMode,
		type CalendarPersistedState,
		type CalendarWritePort,
	} from "./calendarLogic";
	import {
		createEventSeries,
		createSingleEvent,
		transferEventOccurrence,
		withSeriesAnchor,
	} from "./eventSeries";
	import { EventSeriesModal } from "./EventSeriesModal";
	import { dropTimeEnd, minutesOfDay, preservedTimeEnd } from "./timeGrid";
	import { createPaintController, type PaintPreview } from "./dayStatusPaint";
	import {
		EMPTY_DAY_STATUS_MODEL,
		statusForDate,
		type DayStatusModel,
	} from "../../core/daystatus/dayStatus";
	import type { DayStatusPort } from "../../services/DayStatusService";

	let {
		taskStore,
		dispatcher,
		settings,
		settingsRevision,
		app,
		dnd,
		vault,
		menuPorts = null,
		dayStatus = null,
		persisted,
		persist,
		quickAddKind: initialQuickAddKind = "task",
		persistQuickAddKind = null,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		settingsRevision: Readable<number>;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Quick capture writes to the configured unified inbox. */
		vault: CalendarWritePort;
		/** Порт статусов дней (покраска календаря) или null. */
		dayStatus?: DayStatusPort | null;
		/** Состояние из workspace-раскладки; приходит ПОСЛЕ монтирования. */
		persisted: Readable<CalendarPersistedState>;
		persist: (s: CalendarPersistedState) => void;
		/** Липкое положение переключателя «Задача | Событие» из настроек плагина
		 *  (снимок на монтировании; дефолт «Задача» для новых пользователей). */
		quickAddKind?: QuickAddKind;
		/** Сохранить новый выбор переключателя в настройки (persist через плагин). */
		persistQuickAddKind?: ((kind: QuickAddKind) => void) | null;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	// Линия текущего времени (§сегодня): локальные минуты от полуночи, пересчёт раз
	// в минуту. ОДИН интервал на весь вид — общий для тайм-сетки (горизонталь в
	// колонке сегодня) и агенды (маркер ● HH:mm ———). Смену суток ловит today-стор
	// (ObsidianClock): колонка/секция «сегодня» переезжает сама, nowMin к 00:00
	// сбрасывается этим же минутным тиком.
	let nowMin = $state(minutesOfDay(new Date()));
	$effect(() => {
		const id = window.setInterval(() => (nowMin = minutesOfDay(new Date())), 60_000);
		return () => window.clearInterval(id);
	});

	let mode = $state<CalendarMode>("month");
	// svelte-ignore state_referenced_locally
	let anchor = $state<IsoDate>(get(taskStore.today));

	// Липкий тип инлайн-ввода: единый источник для ОБЕИХ сеток вида (месяц/тайм-сетка);
	// снимок настройки на монтировании, дальше живёт локально и при каждой смене
	// пишется в настройки плагина (переживает перезапуск).
	// svelte-ignore state_referenced_locally
	let quickAddKind = $state<QuickAddKind>(initialQuickAddKind);
	function setQuickAddKind(kind: QuickAddKind): void {
		quickAddKind = kind;
		persistQuickAddKind?.(kind);
	}

	// восстановление из viewState (setState приходит после onOpen — поэтому store)
	$effect(() =>
		persisted.subscribe((s) => {
			if (s.mode !== undefined) mode = s.mode;
			if (s.anchor !== undefined) anchor = s.anchor;
		}),
	);

	// Масштаб шрифта календаря (пресет настроек) → CSS-переменная на корне
	// .gtd-cal; иерархия размеров внутри вида сохраняется (каждый font-size
	// умножается на общий множитель через calc()). settings мутируется на
	// месте — пересчёт форсируется через settingsRevision, как у прочих
	// производных ниже.
	const calendarFontScale = $derived.by(() => {
		void $settingsRevision;
		return CALENDAR_FONT_SCALE[settings.calendarFontSize] ?? 1;
	});

	const grid = $derived.by(() => {
		void $settingsRevision;
		return monthGrid(anchor, settings.firstDayOfWeek);
	});
	const range = $derived.by(() => {
		void $settingsRevision;
		if (mode === "month") return grid.daysInView;
		if (mode === "week") return weekRange(anchor, settings.firstDayOfWeek);
		if (mode === "3days") return { from: anchor, to: addDaysIso(anchor, DAYS3_PAGE_DAYS - 1) };
		if (mode === "day") return { from: anchor, to: anchor };
		return { from: anchor, to: addDaysIso(anchor, AGENDA_PAGE_DAYS - 1) };
	});

	// Store пересоздаётся при смене диапазона: (from, to) входят в QuerySpec,
	// живой store на диапазон — подписка внутри $effect с отпиской при пересоздании.
	let rangeTasks = $state<Task[]>([]);
	$effect(() => {
		void $settingsRevision;
		const store = calendarRangeStore(
			taskStore,
			range.from,
			range.to,
			settings.calendarPlacement,
			settings.debounceMs.queryRecompute,
			settingsRevision,
		);
		return store.subscribe((v) => {
			rangeTasks = v;
		});
	});

	// Просроченные: глобальные события с датой < today; пересоздание на смене дня.
	let overdueRaw = $state<Task[]>([]);
	$effect(() => {
		void $settingsRevision;
		const store = calendarRangeStore(
			taskStore,
			"0001-01-01",
			addDaysIso($today, -1),
			settings.calendarPlacement,
			settings.debounceMs.queryRecompute,
			settingsRevision,
		);
		return store.subscribe((v) => {
			overdueRaw = v;
		});
	});

	// Event series are discovered globally and rendered as virtual occurrences.
	let eventSeries = $state<Task[]>([]);
	$effect(() => {
		const recompute = (): void => {
			eventSeries = [...taskStore.index().all()].filter(
				(task) => task.container === "events",
			);
		};
		return taskStore.epoch.subscribe(recompute);
	});
	const eventsByDay = $derived(expandEventOccurrences(eventSeries, range.from, range.to));

	// --- статусы дней (покраска календаря) ---
	let dsModel = $state<DayStatusModel>(EMPTY_DAY_STATUS_MODEL);
	$effect(() => dayStatus?.model.subscribe((m) => (dsModel = m)));
	/** Статус (имя+цвет) даты или null — читает реактивную модель. */
	const dsFor = (date: IsoDate): { name: string; color: string } | null =>
		dayStatus === null ? null : statusForDate(dsModel, date);
	/** Активное превью диапазона покраски (подсветка во время протяжки). */
	let dsPreview = $state<PaintPreview | null>(null);
	const dsInPreview = (date: IsoDate): boolean =>
		dsPreview !== null && date >= dsPreview.from && date <= dsPreview.to;
	const paint = createPaintController({
		app: () => app,
		port: () => dayStatus,
		setPreview: (p) => (dsPreview = p),
	});

	const byDay = $derived.by(() => {
		void $settingsRevision;
		return placeEvents(rangeTasks, settings.calendarPlacement);
	});
	const overdue = $derived(openTasks(overdueRaw));
	// placeEvents сохраняет порядок вставки, вход отсортирован по дате — entries по возрастанию
	const overdueEntries = $derived.by(() => {
		void $settingsRevision;
		return Array.from(placeEvents(overdue, settings.calendarPlacement).entries());
	});

	const title = $derived(
		mode === "month"
			? monthTitle(anchor)
			: mode === "day"
				? agendaLabel(anchor)
				: `${range.from} — ${range.to}`,
	);

	/** Число колонок почасовой сетки: день — 1, «3 дня» — 3, «Неделя» — 7. */
	const timeGridDays = $derived(
		mode === "day" ? 1 : mode === "week" ? WEEK_DAYS : DAYS3_PAGE_DAYS,
	);

	function persistNow(): void {
		persist({ mode, anchor });
	}

	function setMode(m: CalendarMode): void {
		mode = m;
		persistNow();
	}

	function goToday(): void {
		anchor = $today;
		persistNow();
	}

	/** Шаг листания: день — ±1, «3 дня» — ±3 (страницей, без перекрытия). */
	function goPrev(): void {
		anchor =
			mode === "month"
				? prevMonth(anchor)
				: mode === "week"
					? prevWeek(anchor)
					: mode === "agenda"
						? prevAgenda(anchor)
						: addDaysIso(anchor, mode === "day" ? -1 : -DAYS3_PAGE_DAYS);
		persistNow();
	}

	function goNext(): void {
		anchor =
			mode === "month"
				? nextMonth(anchor)
				: mode === "week"
					? nextWeek(anchor)
					: mode === "agenda"
						? nextAgenda(anchor)
						: addDaysIso(anchor, mode === "day" ? 1 : DAYS3_PAGE_DAYS);
		persistNow();
	}

	/** Drop на день/слот (ТЗ §8): двигаем поле, по которому задача видна в
	 *  календаре, иначе первое из settings.calendarPlacement.
	 *  time: undefined — drop на день (существующее время поля сохраняется,
	 *  контракт SetDate/setField: undefined = не трогать, перенос «14:30-задачи»
	 *  на другой день оставляет 14:30, интервал «14:30-16:00» — целиком);
	 *  строка — слот time-grid (точное время); null — полоса «Весь день»
	 *  time-grid (время снимается, конец интервала setField снимает сам). */
	async function dropTask(taskKey: string, date: IsoDate, time?: string | null): Promise<void> {
		const task = taskStore.index().get(taskKey);
		if (task === undefined) {
			new Notice("GTD Flow: задача не найдена");
			return;
		}
		const field = dropDateField(task, settings.calendarPlacement);
		// Конец интервала при drop на слот тайм-сетки (dropTimeEnd):
		//  • блок с длительностью тянет конец за собой (новый старт + прежняя
		//    длительность) — явно, а не undefined: setField при undefined сохранил
		//    бы СТАРЫЙ конец, который после переноса может оказаться не позже
		//    нового начала (throw);
		//  • карточка БЕЗ времени поля-размещения (входящие/доска/полоса «Весь
		//    день») получает дефолтные 30 минут: time = слот, timeEnd = слот+30;
		//  • перенос уже-таймированного блока БЕЗ конца — конец не появляется.
		const timeEnd =
			typeof time === "string"
				? dropTimeEnd(placedTime(task, field), placedTimeEnd(task, field), time)
				: undefined;
		// «🛫 и 📅 взаимоисключающие»: планирование реально отложенной задачи
		// (🛫 в будущем) возвращает её из отложенных — с подтверждением и одной
		// атомарной записью. Инертный 🛫 в прошлом конфликтом не считается.
		let clearStart = false;
		if (field === "due" && task.start !== null && task.start > $today) {
			const ok = await confirm(
				app,
				"Вернуть из отложенных?",
				`Задача отложена до ${task.start}. Запланированная задача не может ` +
					`оставаться отложенной: запланировать на ${date} и вернуть из отложенных?`,
				"Запланировать и вернуть",
			);
			if (!ok) return;
			clearStart = true;
		}
		const res = await dispatcher.dispatch({
			type: "set-date",
			key: taskKey,
			field,
			date,
			time,
			timeEnd,
			clearStart,
		});
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
		else if (clearStart) new Notice(`Запланирована на ${date}, возвращена из отложенных`);
	}

	/** Quick capture always writes to the configured unified inbox. */
	async function quickAdd(
		date: IsoDate,
		text: string,
		time: string | null = null,
		timeEnd: string | null = null,
		location: string | null = null,
	): Promise<void> {
		const line = quickAddLine(text, date, time, timeEnd, location);
		if (line === null) return;
		const target = settings.inboxFile;
		if (!(await ensureCaptureFile(vault, target))) {
			new Notice(`GTD Flow: не удалось подготовить файл входящих ${target}`);
			return;
		}
		const ok = await vault.processFile(target, (content) => appendLine(content, line));
		if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}`);
	}

	/** Inline events are created in the configured global events file. */
	async function quickAddEvent(
		date: IsoDate,
		text: string,
		time: string | null = null,
		timeEnd: string | null = null,
		location: string | null = null,
	): Promise<void> {
		if (text.trim() === "") return;
		const eventsFile = settings.eventsFile;
		const res = await createSingleEvent({
			vault,
			eventsFile,
			name: text,
			date,
			time,
			timeEnd,
			location,
		});
		if (res.ok) new Notice("GTD Flow: событие создано");
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	/** Drop блока-вхождения события на слот тайм-сетки: перенос на дату колонки +
	 *  время слота с сохранением длительности вхождения. ОДНА атомарная запись в
	 *  файле событий (см. transferEventOccurrence): серия гасит вхождение через 🚫
	 *  и порождает одноразовую строку, одноразовое — правит собственную 📅. */
	async function moveOccurrence(
		taskKey: string,
		occ: OccurrenceDrag,
		date: IsoDate,
		time: string,
	): Promise<void> {
		const task = taskStore.index().get(taskKey);
		if (task === undefined) {
			new Notice("GTD Flow: событие не найдено");
			return;
		}
		// конец = новый старт + прежняя длительность (null, если её не было)
		const timeEnd = preservedTimeEnd(occ.time, occ.timeEnd, time) ?? null;
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: occ.kind,
			fromDate: occ.date,
			toDate: date,
			time,
			timeEnd,
		});
		if (res.ok) new Notice(`Перенесено: ${occ.date} → ${date}`);
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	/** ПКМ по пустому месту → «Повторяющееся событие…»: модал → createEventSeries.
	 *  time — из слота тайм-сетки (prefill), null для DayCell (месяц/неделя/агенда). */
	function createEvent(date: IsoDate, time: string | null): void {
		const eventsFile = settings.eventsFile;
		new EventSeriesModal(
			app,
			{ name: "", rule: "", time: time ?? "", location: "" },
			`Новое событие · ${date}`,
			(name, ruleText, location) => {
				// weekly n>1 с byDay без from → дописать 'from <дата ПКМ>': закрепляет
				// чётность недель новой серии (иначе фаза опиралась бы на эпоха-фолбэк)
				reportAsync("не удалось создать событие", async () => {
					const res = await createEventSeries({
						vault,
						eventsFile,
						name,
						ruleText: withSeriesAnchor(ruleText, date),
						location,
					});
					if (res.ok) new Notice("GTD Flow: событие создано");
					else new Notice(`GTD Flow: ${res.reason}`);
				});
			},
		).open();
	}
</script>

<div class="gtd-cal" style="--gtd-cal-font-scale: {calendarFontScale}">
	<CalendarToolbar
		{title}
		{mode}
		overdueCount={overdue.length}
		onPrev={goPrev}
		onToday={goToday}
		onNext={goNext}
		onMode={setMode}
	/>

	{#if mode === "agenda"}
		<div class="gtd-cal-agenda">
			{#if overdueEntries.length > 0}
				<section class="gtd-cal-agenda-overdue">
					<div class="gtd-cal-agenda-head is-overdue">Просроченные</div>
					<div class="gtd-cal-agenda-overdue-list">
						{#each overdueEntries as [date, list] (date)}
							{#each list as ev (ev.task.key)}
								<EventChip
									{ev}
									today={$today}
									{dnd}
									{dispatcher}
									{app}
									{settings}
									{menuPorts}
									showDate={date}
								/>
							{/each}
						{/each}
					</div>
				</section>
			{/if}
			{#each agendaDays(range.from, AGENDA_PAGE_DAYS) as date (date)}
				<DayCell
					{date}
					today={$today}
					label={agendaLabel(date)}
					events={byDay.get(date) ?? []}
					eventOccurrences={eventsByDay.get(date) ?? []}
					nowMinutes={nowMin}
					{dnd}
					{dispatcher}
					{app}
					{settings}
					{vault}
					{menuPorts}
					statusColor={dsFor(date)?.color ?? null}
					statusName={dsFor(date)?.name ?? null}
					onDropTask={dropTask}
					onQuickAdd={(date, text, location) =>
						quickAdd(date, text, null, null, location)}
					onQuickAddEvent={(date, text, location) =>
						quickAddEvent(date, text, null, null, location)}
					onCreateEvent={createEvent}
					{quickAddKind}
					onQuickAddKindChange={setQuickAddKind}
				/>
			{/each}
		</div>
	{:else if mode === "day" || mode === "3days" || mode === "week"}
		<TimeGrid
			days={agendaDays(range.from, timeGridDays)}
			today={$today}
			nowMinutes={nowMin}
			{byDay}
			{eventsByDay}
			{dnd}
			{dispatcher}
			{app}
			{settings}
			{vault}
			{menuPorts}
			dayStatusColor={dsFor}
			dayStatusPainting={dsInPreview}
			paintHandlers={dayStatus === null ? null : paint}
			onDropTask={dropTask}
			onQuickAdd={quickAdd}
			onQuickAddEvent={quickAddEvent}
			onCreateEvent={createEvent}
			onMoveOccurrence={moveOccurrence}
			{quickAddKind}
			onQuickAddKindChange={setQuickAddKind}
		/>
	{:else}
		<div class="gtd-cal-weekdays">
			{#each weekdayNames(settings.firstDayOfWeek) as name (name)}
				<div class="gtd-cal-weekday">{name}</div>
			{/each}
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gtd-cal-grid"
			onpointerdown={paint.pointerdown}
			onpointermove={paint.pointermove}
			onpointerup={paint.pointerup}
			onpointercancel={paint.pointercancel}
		>
			{#each grid.weeks as week (week[0])}
				{#each week as date (date)}
					<DayCell
						{date}
						today={$today}
						muted={date.slice(0, 7) !== anchor.slice(0, 7)}
						compact={true}
						events={byDay.get(date) ?? []}
						eventOccurrences={eventsByDay.get(date) ?? []}
						{dnd}
						{dispatcher}
						{app}
						{settings}
						{vault}
						{menuPorts}
						statusColor={dsFor(date)?.color ?? null}
						statusName={dsFor(date)?.name ?? null}
						painting={dsInPreview(date)}
						onDropTask={dropTask}
						onQuickAdd={(date, text, location) =>
							quickAdd(date, text, null, null, location)}
						onQuickAddEvent={(date, text, location) =>
							quickAddEvent(date, text, null, null, location)}
						onCreateEvent={createEvent}
						{quickAddKind}
						onQuickAddKindChange={setQuickAddKind}
					/>
				{/each}
			{/each}
		</div>
	{/if}
</div>

<style>
	.gtd-cal {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-cal-weekdays {
		flex: none;
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		padding: 4px 10px 0;
	}
	.gtd-cal-weekday {
		text-align: center;
		color: var(--text-muted);
		font-size: calc(var(--font-ui-smaller, 0.85em) * var(--gtd-cal-font-scale, 1));
	}
	.gtd-cal-grid {
		flex: 1 1 auto;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		grid-auto-rows: minmax(0, 1fr);
		overflow-y: auto;
		padding: 3px 10px 10px 11px; /* +1px слева под схлопнутые рамки ячеек */
	}
	.gtd-cal-agenda {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 3px 10px 10px 11px;
	}
	.gtd-cal-agenda-overdue {
		margin-bottom: 8px;
		border: 1px solid var(--text-warning, var(--background-modifier-border));
		border-radius: var(--radius-m, 8px);
		padding: 4px 6px;
	}
	.gtd-cal-agenda-head {
		font-weight: 600;
		font-size: calc(var(--font-ui-smaller, 0.85em) * var(--gtd-cal-font-scale, 1));
		color: var(--text-muted);
		padding: 2px 0;
	}
	.gtd-cal-agenda-head.is-overdue {
		color: var(--text-warning, var(--text-muted));
	}
	.gtd-cal-agenda-overdue-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
</style>
