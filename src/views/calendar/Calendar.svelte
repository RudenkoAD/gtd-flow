<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { get, type Readable } from "svelte/store";
	import type { IsoDate, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { calendarRangeStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { addDaysIso } from "../common/dates";
	import { confirm } from "../common/ConfirmModal";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import DayCell from "./DayCell.svelte";
	import EventChip from "./EventChip.svelte";
	import TimeGrid from "./TimeGrid.svelte";
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
		type CalendarMode,
		type CalendarPersistedState,
		type CalendarWritePort,
	} from "./calendarLogic";
	import { createEventSeries } from "./eventSeries";
	import { EventSeriesModal } from "./EventSeriesModal";
	import { preservedTimeEnd } from "./timeGrid";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
		dnd,
		vault,
		menuPorts = null,
		persisted,
		persist,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Быстрый ввод пишет в inboxSources[0] (структурный порт VaultAdapter). */
		vault: CalendarWritePort;
		/** Состояние из workspace-раскладки; приходит ПОСЛЕ монтирования. */
		persisted: Readable<CalendarPersistedState>;
		persist: (s: CalendarPersistedState) => void;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	let mode = $state<CalendarMode>("month");
	// svelte-ignore state_referenced_locally
	let anchor = $state<IsoDate>(get(taskStore.today));

	// восстановление из viewState (setState приходит после onOpen — поэтому store)
	$effect(() =>
		persisted.subscribe((s) => {
			if (s.mode !== undefined) mode = s.mode;
			if (s.anchor !== undefined) anchor = s.anchor;
		}),
	);

	const grid = $derived(monthGrid(anchor, settings.firstDayOfWeek));
	const range = $derived.by(() => {
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
		const store = calendarRangeStore(
			taskStore,
			range.from,
			range.to,
			settings.calendarPlacement,
			settings.debounceMs.queryRecompute,
		);
		return store.subscribe((v) => {
			rangeTasks = v;
		});
	});

	// Просроченные: события всего vault с датой < today; пересоздание на смене дня.
	let overdueRaw = $state<Task[]>([]);
	$effect(() => {
		const store = calendarRangeStore(
			taskStore,
			"0001-01-01",
			addDaysIso($today, -1),
			settings.calendarPlacement,
			settings.debounceMs.queryRecompute,
		);
		return store.subscribe((v) => {
			overdueRaw = v;
		});
	});

	// Серии-события (container events) — из индекса, реактивно по epoch.
	// В calendar-range QueryEngine их не отдаёт: рендерим ОТДЕЛЬНО как виртуальные
	// вхождения (expandEventOccurrences), пере-сборка при смене видимого диапазона.
	let eventSeries = $state<Task[]>([]);
	$effect(() =>
		taskStore.epoch.subscribe(() => {
			const out: Task[] = [];
			for (const t of taskStore.index().all()) if (t.container === "events") out.push(t);
			eventSeries = out;
		}),
	);
	const eventsByDay = $derived(expandEventOccurrences(eventSeries, range.from, range.to));

	const byDay = $derived(placeEvents(rangeTasks, settings.calendarPlacement));
	const overdue = $derived(openTasks(overdueRaw));
	// placeEvents сохраняет порядок вставки, вход отсортирован по дате — entries по возрастанию
	const overdueEntries = $derived(
		Array.from(placeEvents(overdue, settings.calendarPlacement).entries()),
	);

	const title = $derived(
		mode === "month"
			? monthTitle(anchor)
			: mode === "day"
				? agendaLabel(anchor)
				: `${range.from} — ${range.to}`,
	);

	const MODE_ORDER: readonly { id: CalendarMode; label: string }[] = [
		{ id: "month", label: "Месяц" },
		{ id: "week", label: "Неделя" },
		{ id: "agenda", label: "Агенда" },
		{ id: "3days", label: "3 дня" },
		{ id: "day", label: "День" },
	];

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
		// Блок с длительностью, брошенный на слот, тянет конец за собой: новый
		// старт + прежняя длительность. Явно, а не undefined: setField при
		// undefined сохранил бы СТАРЫЙ конец, который после переноса может
		// оказаться не позже нового начала (throw). У задач без конца —
		// undefined: timeEnd не трогаем, слот ставит только время (§ фидбека).
		const timeEnd =
			typeof time === "string"
				? preservedTimeEnd(placedTime(task, field), placedTimeEnd(task, field), time)
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

	/** Быстрый ввод: `- [ ] <текст> 📅 <дата>[ HH:mm]` в первый источник входящих. */
	async function quickAdd(date: IsoDate, text: string, time: string | null = null): Promise<void> {
		const line = quickAddLine(text, date, time);
		if (line === null) return;
		const target = settings.inboxSources[0];
		if (target === undefined) {
			new Notice("GTD Flow: не задан файл входящих (inboxSources)");
			return;
		}
		await vault.ensureFile(target);
		const ok = await vault.processFile(target, (content) => appendLine(content, line));
		if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}`);
	}

	/** ПКМ по пустому месту → «Повторяющееся событие…»: модал → createEventSeries.
	 *  time — из слота тайм-сетки (prefill), null для DayCell (месяц/неделя/агенда). */
	function createEvent(date: IsoDate, time: string | null): void {
		new EventSeriesModal(
			app,
			{ name: "", rule: "", time: time ?? "" },
			`Новое событие · ${date}`,
			(name, ruleText) => {
				void createEventSeries({
					vault,
					eventsFile: settings.eventsFile,
					name,
					ruleText,
				}).then((res) => {
					if (res.ok) new Notice("GTD Flow: событие создано");
					else new Notice(`GTD Flow: ${res.reason}`);
				});
			},
		).open();
	}
</script>

<div class="gtd-cal">
	<div class="gtd-cal-header">
		<div class="gtd-cal-nav">
			<button aria-label="Назад" onclick={goPrev}>‹</button>
			<button onclick={goToday}>Сегодня</button>
			<button aria-label="Вперёд" onclick={goNext}>›</button>
		</div>
		<span class="gtd-cal-title">{title}</span>
		{#if overdue.length > 0}
			<button
				class="gtd-cal-overdue"
				title="Просроченных задач: {overdue.length} — показать в агенде"
				onclick={() => setMode("agenda")}
			>
				⚠ {overdue.length}
			</button>
		{/if}
		<div class="gtd-cal-modes">
			{#each MODE_ORDER as m (m.id)}
				<button class:is-active={mode === m.id} onclick={() => setMode(m.id)}>{m.label}</button>
			{/each}
		</div>
	</div>

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
					{dnd}
					{dispatcher}
					{app}
					{settings}
					{vault}
					{menuPorts}
					onDropTask={dropTask}
					onQuickAdd={quickAdd}
					onCreateEvent={createEvent}
				/>
			{/each}
		</div>
	{:else if mode === "day" || mode === "3days"}
		<TimeGrid
			days={agendaDays(range.from, mode === "day" ? 1 : DAYS3_PAGE_DAYS)}
			today={$today}
			{byDay}
			{eventsByDay}
			{dnd}
			{dispatcher}
			{app}
			{settings}
			{vault}
			{menuPorts}
			onDropTask={dropTask}
			onQuickAdd={quickAdd}
			onCreateEvent={createEvent}
		/>
	{:else}
		<div class="gtd-cal-weekdays">
			{#each weekdayNames(settings.firstDayOfWeek) as name (name)}
				<div class="gtd-cal-weekday">{name}</div>
			{/each}
		</div>
		{#if mode === "month"}
			<div class="gtd-cal-grid">
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
							onDropTask={dropTask}
							onQuickAdd={quickAdd}
							onCreateEvent={createEvent}
						/>
					{/each}
				{/each}
			</div>
		{:else}
			<div class="gtd-cal-grid is-week">
				{#each agendaDays(range.from, 7) as date (date)}
					<DayCell
						{date}
						today={$today}
						events={byDay.get(date) ?? []}
						eventOccurrences={eventsByDay.get(date) ?? []}
						{dnd}
						{dispatcher}
						{app}
						{settings}
						{vault}
						{menuPorts}
						onDropTask={dropTask}
						onQuickAdd={quickAdd}
						onCreateEvent={createEvent}
					/>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.gtd-cal {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-cal-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-cal-nav {
		display: flex;
		gap: 2px;
	}
	.gtd-cal-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.gtd-cal-overdue {
		flex: none;
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-warning, var(--text-muted));
		cursor: pointer;
		padding: 1px 6px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-cal-overdue:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-cal-modes {
		flex: none;
		display: flex;
		gap: 2px;
	}
	.gtd-cal-modes button.is-active {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
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
		font-size: var(--font-ui-smaller, 0.85em);
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
		font-size: var(--font-ui-smaller, 0.85em);
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
