<script lang="ts">
	import type { App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import EventChip from "./EventChip.svelte";
	import type { PlacedEvent } from "./calendarLogic";
	import { EVENT_DURATION_MIN, MINUTES_PER_DAY, type TimedBlock } from "./timeGrid";

	let {
		ev,
		block,
		today,
		dnd,
		dispatcher,
		app,
		settings,
		menuPorts = null,
	}: {
		ev: PlacedEvent;
		/** Геометрия из layoutDay: точная позиция по времени + дорожка. */
		block: TimedBlock;
		today: IsoDate;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		menuPorts?: TaskMenuPorts | null;
	} = $props();

	/** Собственный элемент — призрак drag'а и якорь времени (dragAnchor чипа). */
	let el = $state<HTMLElement | null>(null);

	const HEIGHT_PCT = (EVENT_DURATION_MIN / MINUTES_PER_DAY) * 100;
	const leftPct = $derived((block.laneIndex / block.laneCount) * 100);
	const widthPct = $derived(100 / block.laneCount);
</script>

<div
	class="gtd-tg-block"
	bind:this={el}
	style="top:{block.topPct}%; height:{HEIGHT_PCT}%; left:{leftPct}%; width:{widthPct}%"
>
	<EventChip {ev} {today} {dnd} {dispatcher} {app} {settings} {menuPorts} dragAnchor={el} />
</div>

<style>
	.gtd-tg-block {
		position: absolute;
		box-sizing: border-box;
		padding: 0 2px 1px 0;
		min-height: 18px; /* чип различим, даже если сетку когда-нибудь ужмут */
		z-index: 2; /* над линиями часов */
	}
	/* Чип внутри блока растягивается на весь интервал; рамка отделяет
	   соседние дорожки при пересечениях. Переменные тем — светлая/тёмная бесплатно. */
	.gtd-tg-block :global(.gtd-cal-chip) {
		height: 100%;
		align-items: flex-start;
		overflow: hidden;
		border: 1px solid var(--background-modifier-border);
		box-shadow: var(--shadow-s, none);
	}
</style>
