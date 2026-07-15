<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { get, type Readable } from "svelte/store";
	import type { IsoDate, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { calendarRangeStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { addDaysIso } from "../common/dates";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import DayCell from "./DayCell.svelte";
	import EventChip from "./EventChip.svelte";
	import {
		AGENDA_PAGE_DAYS,
		agendaDays,
		agendaLabel,
		appendLine,
		dropDateField,
		monthGrid,
		monthTitle,
		nextAgenda,
		nextMonth,
		nextWeek,
		openTasks,
		placeEvents,
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

	const byDay = $derived(placeEvents(rangeTasks, settings.calendarPlacement));
	const overdue = $derived(openTasks(overdueRaw));
	// placeEvents сохраняет порядок вставки, вход отсортирован по дате — entries по возрастанию
	const overdueEntries = $derived(
		Array.from(placeEvents(overdue, settings.calendarPlacement).entries()),
	);

	const title = $derived(
		mode === "month" ? monthTitle(anchor) : `${range.from} — ${range.to}`,
	);

	const MODE_ORDER: readonly { id: CalendarMode; label: string }[] = [
		{ id: "month", label: "Месяц" },
		{ id: "week", label: "Неделя" },
		{ id: "agenda", label: "Агенда" },
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

	function goPrev(): void {
		anchor =
			mode === "month" ? prevMonth(anchor) : mode === "week" ? prevWeek(anchor) : prevAgenda(anchor);
		persistNow();
	}

	function goNext(): void {
		anchor =
			mode === "month" ? nextMonth(anchor) : mode === "week" ? nextWeek(anchor) : nextAgenda(anchor);
		persistNow();
	}

	/** Drop на день (ТЗ §8): двигаем поле, по которому задача видна в календаре,
	 *  иначе первое из settings.calendarPlacement. */
	async function dropTask(taskKey: string, date: IsoDate): Promise<void> {
		const task = taskStore.index().get(taskKey);
		if (task === undefined) {
			new Notice("GTD Flow: задача не найдена");
			return;
		}
		const res = await dispatcher.dispatch({
			type: "set-date",
			key: taskKey,
			field: dropDateField(task, settings.calendarPlacement),
			date,
			// time намеренно НЕ передаём (undefined) — существующее время поля
			// сохраняется (контракт SetDate/setField: undefined = не трогать время,
			// null = снять). Перенос «14:30-задачи» на другой день оставляет 14:30.
		});
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	/** Быстрый ввод: `- [ ] <текст> 📅 <дата>` в первый источник входящих. */
	async function quickAdd(date: IsoDate, text: string): Promise<void> {
		const line = quickAddLine(text, date);
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
					{dnd}
					{dispatcher}
					{app}
					{settings}
					{menuPorts}
					onDropTask={dropTask}
					onQuickAdd={quickAdd}
				/>
			{/each}
		</div>
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
							{dnd}
							{dispatcher}
							{app}
							{settings}
							{menuPorts}
							onDropTask={dropTask}
							onQuickAdd={quickAdd}
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
						{dnd}
						{dispatcher}
						{app}
						{settings}
						{menuPorts}
						onDropTask={dropTask}
						onQuickAdd={quickAdd}
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
