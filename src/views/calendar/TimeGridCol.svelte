<script lang="ts">
	import type { App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import TimeGridBlock from "./TimeGridBlock.svelte";
	import type { PlacedEvent } from "./calendarLogic";
	import {
		MINUTES_PER_DAY,
		minutesFromOffsetY,
		minutesToTime,
		snapMinutes,
		type TimedBlock,
	} from "./timeGrid";

	let {
		date,
		today,
		blocks,
		dnd,
		dispatcher,
		app,
		settings,
		menuPorts = null,
		onDropTask,
		onQuickAdd,
	}: {
		date: IsoDate;
		today: IsoDate;
		/** Блоки со временем этого дня (раскладку делает родитель через layoutDay). */
		blocks: { block: TimedBlock; ev: PlacedEvent }[];
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		menuPorts?: TaskMenuPorts | null;
		/** Drop на слот: дата колонки + время по позиции (снап 15 мин). */
		onDropTask: (taskKey: string, date: IsoDate, time: string | null) => Promise<void>;
		/** Quick-add из клика по пустому слоту — с датой и временем слота. */
		onQuickAdd: (date: IsoDate, text: string, time: string | null) => Promise<void>;
	} = $props();

	let colEl: HTMLElement | null = $state(null);
	/** Минуты слота открытого quick-add; null — не редактируем. */
	let addingMin = $state<number | null>(null);
	let draft = $state("");

	// Колонка — drop-цель на все 24ч: время из вертикальной позиции отпускания.
	// grabOffsetY (блоки time-grid) восстанавливает верх блока — чисто
	// горизонтальный перенос в соседний день сохраняет время с точностью снапа.
	$effect(() => {
		if (dnd === null || colEl === null) return;
		const el = colEl;
		return dnd.registerDropTarget({
			el,
			accepts: (p) => p.taskKey !== "",
			drop: (p, ctx) => {
				const rect = el.getBoundingClientRect();
				const anchorY = ctx.clientY - (p.grabOffsetY ?? 0);
				const min = snapMinutes(minutesFromOffsetY(anchorY - rect.top, rect.height));
				return onDropTask(p.taskKey, date, minutesToTime(min));
			},
		});
	});

	/** ЛКМ по пустому слоту — quick-add с временем слота; клики по блокам/контролам —
	 *  их дело. ПКМ по пустому намеренно не обрабатываем (нет contextmenu-обработчика). */
	function onColClick(e: MouseEvent): void {
		if (
			e.target instanceof Element &&
			e.target.closest(".gtd-tg-block, .gtd-cal-chip, button, input, a, select, textarea")
		)
			return;
		if (colEl === null) return;
		const rect = colEl.getBoundingClientRect();
		addingMin = snapMinutes(minutesFromOffsetY(e.clientY - rect.top, rect.height));
		draft = "";
	}

	function focusInput(el: HTMLInputElement): void {
		el.focus();
	}

	function cancelDraft(): void {
		addingMin = null;
		draft = "";
	}

	function submitDraft(): void {
		const min = addingMin;
		const text = draft;
		cancelDraft();
		if (min === null || text.trim() === "") return;
		void onQuickAdd(date, text, minutesToTime(min));
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
	class="gtd-tg-col"
	class:is-today={date === today}
	bind:this={colEl}
	onclick={onColClick}
>
	{#each blocks as b (b.ev.task.key)}
		<TimeGridBlock
			ev={b.ev}
			block={b.block}
			{today}
			{dnd}
			{dispatcher}
			{app}
			{settings}
			{menuPorts}
		/>
	{/each}
	{#if addingMin !== null}
		<input
			class="gtd-tg-quickadd"
			style="top:{(addingMin / MINUTES_PER_DAY) * 100}%"
			type="text"
			placeholder="Новая задача…"
			aria-label="Новая задача на {date} {minutesToTime(addingMin)}"
			bind:value={draft}
			use:focusInput
			onkeydown={(e) => {
				if (e.key === "Enter") submitDraft();
				else if (e.key === "Escape") cancelDraft();
			}}
			onblur={cancelDraft}
		/>
	{/if}
</div>

<style>
	.gtd-tg-col {
		position: relative;
		min-width: 0;
		border-left: 1px solid var(--background-modifier-border);
		/* линии часов: 1px границы через каждый час (--gtd-tg-hour с корня сетки) */
		background-image: repeating-linear-gradient(
			to bottom,
			var(--background-modifier-border) 0,
			var(--background-modifier-border) 1px,
			transparent 1px,
			transparent var(--gtd-tg-hour, 48px)
		);
		cursor: cell;
	}
	.gtd-tg-col:last-child {
		border-right: 1px solid var(--background-modifier-border);
	}
	.gtd-tg-col.is-today {
		background-color: var(--background-modifier-hover);
	}
	.gtd-tg-quickadd {
		position: absolute;
		left: 0;
		width: calc(100% - 4px);
		z-index: 3; /* над блоками — редактируем именно его */
		font-size: var(--font-ui-smaller, 0.85em);
	}
</style>
