<script lang="ts">
	import type { App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import EventChip from "./EventChip.svelte";
	import type { PlacedEvent } from "./calendarLogic";

	let {
		date,
		today,
		events,
		dnd,
		dispatcher,
		app,
		settings,
		menuPorts = null,
		muted = false,
		compact = false,
		label = null,
		onDropTask,
		onQuickAdd,
	}: {
		date: IsoDate;
		today: IsoDate;
		events: PlacedEvent[];
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** День соседнего месяца в сетке месяца. */
		muted?: boolean;
		/** Месяц — компактные ячейки; неделя/агенда — растянутые. */
		compact?: boolean;
		/** Заголовок вместо номера дня (агенда: «Ср 2026-07-15»). */
		label?: string | null;
		/** Drop карточки любого вида на этот день (ТЗ §8). */
		onDropTask: (taskKey: string, date: IsoDate) => Promise<void>;
		/** Быстрый ввод задачи с датой этого дня. */
		onQuickAdd: (date: IsoDate, text: string) => Promise<void>;
	} = $props();

	let cellEl: HTMLElement | null = $state(null);
	let adding = $state(false);
	let draft = $state("");

	// Ячейка — drop-цель; подсветка под курсором — DND_OVER_CLASS от сервиса.
	// drop-замыкание читает реактивный prop date — цель всегда бьёт в актуальный день.
	$effect(() => {
		if (dnd === null || cellEl === null) return;
		return dnd.registerDropTarget({
			el: cellEl,
			accepts: (p) => p.taskKey !== "",
			drop: (p) => onDropTask(p.taskKey, date),
		});
	});

	/** ЛКМ по пустой области дня — быстрый ввод; клики по chip/контролам — их дело.
	 *  ПКМ намеренно не обрабатываем: `click` стреляет только основной кнопкой,
	 *  contextmenu-обработчика нет — правый клик по пустому месту ничему не мешает. */
	function onCellClick(e: MouseEvent): void {
		if (
			e.target instanceof Element &&
			e.target.closest(".gtd-cal-chip, button, input, a, select, textarea")
		)
			return;
		adding = true;
	}

	function focusInput(el: HTMLInputElement): void {
		el.focus();
	}

	function cancelDraft(): void {
		adding = false;
		draft = "";
	}

	function submitDraft(): void {
		const text = draft;
		cancelDraft();
		if (text.trim() === "") return;
		void onQuickAdd(date, text);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
	class="gtd-cal-cell"
	class:is-muted={muted}
	class:is-today={date === today}
	class:is-compact={compact}
	bind:this={cellEl}
	onclick={onCellClick}
>
	<div class="gtd-cal-daynum" class:is-today={date === today}>
		{label ?? Number(date.slice(8, 10))}
	</div>
	<div class="gtd-cal-events">
		{#each events as ev (ev.task.key)}
			<EventChip {ev} {today} {dnd} {dispatcher} {app} {settings} {menuPorts} />
		{/each}
		{#if adding}
			<input
				class="gtd-cal-quickadd"
				type="text"
				placeholder="Новая задача…"
				aria-label="Новая задача на {date}"
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
</div>

<style>
	.gtd-cal-cell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		padding: 2px 4px 4px;
		border: 1px solid var(--background-modifier-border);
		margin: -1px 0 0 -1px; /* схлопывание соседних рамок в одну линию */
		cursor: cell;
	}
	.gtd-cal-cell.is-compact {
		min-height: 76px;
	}
	.gtd-cal-cell.is-muted {
		background: var(--background-secondary-alt);
	}
	.gtd-cal-cell.is-muted .gtd-cal-daynum {
		color: var(--text-faint);
	}
	.gtd-cal-cell.is-today {
		background: var(--background-modifier-hover);
	}
	.gtd-cal-daynum {
		flex: none;
		align-self: flex-start;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		padding: 0 4px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-cal-daynum.is-today {
		color: var(--text-on-accent);
		background: var(--interactive-accent);
		font-weight: 600;
	}
	.gtd-cal-events {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
	}
	.gtd-cal-quickadd {
		width: 100%;
		font-size: var(--font-ui-smaller, 0.85em);
	}
</style>
