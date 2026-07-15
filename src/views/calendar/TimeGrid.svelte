<script lang="ts">
	import type { App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort, OccurrenceDrag } from "../dnd/types";
	import DayCell from "./DayCell.svelte";
	import TimeGridCol from "./TimeGridCol.svelte";
	import {
		agendaLabel,
		placedTime,
		placedTimeEnd,
		type CalendarWritePort,
		type EventOccurrence,
		type PlacedEvent,
	} from "./calendarLogic";
	import { DEFAULT_SCROLL_MIN, layoutDay } from "./timeGrid";

	let {
		days,
		today,
		byDay,
		eventsByDay = new Map(),
		dnd,
		dispatcher,
		app,
		settings,
		vault = null,
		menuPorts = null,
		onDropTask,
		onQuickAdd,
		onCreateEvent = null,
		onMoveOccurrence = null,
	}: {
		/** Колонки сетки: 1 (день) или 3 (три дня), подряд. */
		days: IsoDate[];
		today: IsoDate;
		byDay: Map<IsoDate, PlacedEvent[]>;
		/** Виртуальные вхождения серий-событий по дням (§события). */
		eventsByDay?: Map<IsoDate, EventOccurrence[]>;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		/** Порт файла событий — правка серии из меню вхождения. */
		vault?: CalendarWritePort | null;
		menuPorts?: TaskMenuPorts | null;
		/** time: строка — слот сетки, null — полоса «Весь день» (снять время). */
		onDropTask: (taskKey: string, date: IsoDate, time: string | null) => Promise<void>;
		onQuickAdd: (date: IsoDate, text: string, time: string | null) => Promise<void>;
		/** ПКМ по пустому слоту/полосе — создать событие. */
		onCreateEvent?: ((date: IsoDate, time: string | null) => void) | null;
		/** Перенос блока-вхождения события на дату колонки + время слота. */
		onMoveOccurrence?:
			| ((taskKey: string, occ: OccurrenceDrag, date: IsoDate, time: string) => Promise<void>)
			| null;
	} = $props();

	/** Высота часа. Единственный источник — отсюда уходит в CSS через --gtd-tg-hour. */
	const HOUR_PX = 48;

	// Раскладка по дням: сплит время/весь-день + дорожки пересечений (layoutDay
	// работает по ключам — здесь join обратно на PlacedEvent).
	const dayLayouts = $derived(
		days.map((date) => {
			const events = byDay.get(date) ?? [];
			const byKey = new Map(events.map((e) => [e.task.key, e]));
			const layout = layoutDay(
				events.map((e) => ({
					key: e.task.key,
					time: placedTime(e.task, e.field),
					timeEnd: placedTimeEnd(e.task, e.field),
				})),
			);
			return {
				date,
				allDay: layout.allDay.map((k) => byKey.get(k)!),
				blocks: layout.timed.map((b) => ({ block: b, ev: byKey.get(b.key)! })),
			};
		}),
	);

	// Раскладка виртуальных вхождений событий: тот же сплит время/весь-день.
	// Ключ вхождения — task.key (одна серия — одно вхождение на дату).
	const eventDayLayouts = $derived(
		days.map((date) => {
			const occs = eventsByDay.get(date) ?? [];
			const byKey = new Map(occs.map((o) => [o.task.key, o]));
			const layout = layoutDay(
				occs.map((o) => ({ key: o.task.key, time: o.time, timeEnd: o.timeEnd })),
			);
			return {
				date,
				allDay: layout.allDay.map((k) => byKey.get(k)!),
				blocks: layout.timed.map((b) => ({ block: b, occ: byKey.get(b.key)! })),
			};
		}),
	);
	/** allDay-вхождения событий по дню — в полосу «Весь день» (DayCell top). */
	const eventAllDayByDate = $derived(
		new Map(eventDayLayouts.map((d) => [d.date, d.allDay])),
	);

	let scrollEl: HTMLElement | null = $state(null);
	// Автоскролл к 08:00 один раз при открытии; смена день↔3 дня компонент
	// не пересоздаёт (одна ветка {#if}) — позиция скролла сохраняется.
	let scrolled = false;
	$effect(() => {
		if (scrollEl === null || scrolled) return;
		scrolled = true;
		scrollEl.scrollTop = (DEFAULT_SCROLL_MIN / 60) * HOUR_PX;
	});

	const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
</script>

<div class="gtd-tg" style="--gtd-tg-hour: {HOUR_PX}px; --gtd-tg-cols: {days.length}">
	<!-- Заголовок-дата + полоса «Весь день»: реюз DayCell — те же чипы,
	     drop без времени (time: null) и quick-add без времени. -->
	<div class="gtd-tg-top">
		<div class="gtd-tg-gutter" aria-hidden="true"></div>
		{#each dayLayouts as d (d.date)}
			<DayCell
				date={d.date}
				{today}
				label={agendaLabel(d.date)}
				events={d.allDay}
				eventOccurrences={eventAllDayByDate.get(d.date) ?? []}
				{dnd}
				{dispatcher}
				{app}
				{settings}
				{vault}
				{menuPorts}
				onDropTask={(taskKey, date) => onDropTask(taskKey, date, null)}
				onQuickAdd={(date, text) => onQuickAdd(date, text, null)}
				onCreateEvent={onCreateEvent === null
					? null
					: (date) => onCreateEvent(date, null)}
			/>
		{/each}
	</div>
	<div class="gtd-tg-scroll" bind:this={scrollEl}>
		<div class="gtd-tg-canvas">
			<div class="gtd-tg-axis">
				{#each HOURS as h (h)}
					<div class="gtd-tg-hourlabel">{h}</div>
				{/each}
			</div>
			{#each dayLayouts as d, i (d.date)}
				<TimeGridCol
					date={d.date}
					{today}
					blocks={d.blocks}
					eventBlocks={eventDayLayouts[i]?.blocks ?? []}
					{dnd}
					{dispatcher}
					{app}
					{settings}
					{vault}
					{menuPorts}
					{onDropTask}
					{onQuickAdd}
					{onCreateEvent}
					{onMoveOccurrence}
				/>
			{/each}
		</div>
	</div>
</div>

<style>
	.gtd-tg {
		--gtd-tg-gutter: 46px;
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	/* Общий шаблон колонок у шапки и холста; scrollbar-gutter: stable на обоих —
	   вертикальный скроллбар холста не разъезжает колонки с шапкой. */
	.gtd-tg-top,
	.gtd-tg-canvas {
		display: grid;
		grid-template-columns: var(--gtd-tg-gutter) repeat(var(--gtd-tg-cols, 1), minmax(0, 1fr));
	}
	.gtd-tg-top {
		flex: none;
		padding: 3px 10px 0 10px;
		overflow-y: auto;
		scrollbar-gutter: stable;
	}
	/* Полоса «Весь день»: капнутая высота, внутренний список чипов скроллится сам */
	.gtd-tg-top :global(.gtd-cal-cell) {
		min-height: 44px;
		max-height: 112px;
	}
	.gtd-tg-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		scrollbar-gutter: stable;
		padding: 0 10px 10px 10px;
	}
	.gtd-tg-canvas {
		height: calc(var(--gtd-tg-hour) * 24);
	}
	.gtd-tg-hourlabel {
		height: var(--gtd-tg-hour);
		padding: 1px 6px 0 0;
		text-align: right;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		font-variant-numeric: tabular-nums;
		border-top: 1px solid transparent; /* компенсация 1px линий часов колонок */
	}
</style>
