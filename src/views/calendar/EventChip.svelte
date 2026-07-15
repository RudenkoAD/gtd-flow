<script lang="ts">
	import { Menu, Notice, type App } from "obsidian";
	import type { Intent } from "../../core/intents/Intent";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import { PRIORITY_ICONS, PRIORITY_LABELS } from "../common/cardFormat";
	import { openTaskInFile } from "../common/openTask";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import type { PlacedEvent } from "./calendarLogic";

	let {
		ev,
		today,
		dnd,
		dispatcher,
		app,
		showDate = null,
	}: {
		ev: PlacedEvent;
		today: IsoDate;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		/** Показать дату в самом chip'е (секция просроченных в агенде). */
		showDate?: IsoDate | null;
	} = $props();

	const isDone = $derived(ev.task.statusChar === "x" || ev.task.statusChar === "X");

	async function run(intent: Intent): Promise<void> {
		const res = await dispatcher.dispatch(intent);
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	function toggleStatus(): void {
		void run(
			isDone
				? { type: "set-status", key: ev.task.key, statusChar: " " }
				: { type: "set-status", key: ev.task.key, statusChar: "x", date: today },
		);
	}

	function onPointerDown(e: PointerEvent): void {
		if (dnd === null || e.button !== 0) return;
		// клик по точке-статусу — не начало drag
		if (e.target instanceof Element && e.target.closest("input, button, a, select, textarea")) return;
		dnd.startDrag(
			{ taskKey: ev.task.key, sourceViewType: VIEW_TYPES.calendar },
			e,
			e.currentTarget as HTMLElement,
		);
	}

	function openMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(isDone ? "Открыть заново" : "Выполнено")
				.setIcon(isDone ? "rotate-ccw" : "check")
				.onClick(() => toggleStatus()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Открыть в файле")
				.setIcon("file-text")
				.onClick(() => void openTaskInFile(app, ev.task)),
		);
		menu.showAtMouseEvent(e);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
	class="gtd-cal-chip"
	class:is-done={isDone}
	class:is-draggable={dnd !== null}
	title={ev.task.description}
	onpointerdown={onPointerDown}
	onclick={openMenu}
>
	<button
		class="gtd-cal-dot"
		class:is-done={isDone}
		aria-label={isDone ? "Открыть заново" : "Выполнено"}
		onclick={(e) => {
			e.stopPropagation();
			toggleStatus();
		}}
	></button>
	{#if showDate !== null}
		<span class="gtd-cal-chip-date">{showDate}</span>
	{/if}
	{#if ev.task.priority !== "none"}
		<span class="gtd-cal-chip-prio" title={PRIORITY_LABELS[ev.task.priority]}
			>{PRIORITY_ICONS[ev.task.priority]}</span
		>
	{/if}
	<span class="gtd-cal-chip-text">{ev.task.description}</span>
</div>

<style>
	.gtd-cal-chip {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 1px 4px;
		border-radius: var(--radius-s, 4px);
		background: var(--background-secondary);
		font-size: var(--font-ui-smaller, 0.85em);
		cursor: pointer;
	}
	.gtd-cal-chip:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-cal-chip.is-draggable {
		/* без touch-action: none тач отдаст жест нативному скроллу до long-press */
		touch-action: none;
	}
	.gtd-cal-chip.is-done .gtd-cal-chip-text {
		color: var(--text-muted);
		text-decoration: line-through;
	}
	.gtd-cal-dot {
		flex: none;
		width: 10px;
		height: 10px;
		padding: 0;
		border: 1.5px solid var(--text-muted);
		border-radius: 50%;
		background: transparent;
		box-shadow: none;
		cursor: pointer;
	}
	.gtd-cal-dot:hover {
		border-color: var(--interactive-accent);
	}
	.gtd-cal-dot.is-done {
		border-color: var(--interactive-accent);
		background: var(--interactive-accent);
	}
	.gtd-cal-chip-date {
		flex: none;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.gtd-cal-chip-prio {
		flex: none;
	}
	.gtd-cal-chip-text {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
