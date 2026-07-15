<script lang="ts">
	import { Menu, Notice, type App } from "obsidian";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import { confirm } from "../common/ConfirmModal";
	import type { EventOccurrence } from "./calendarLogic";
	import { editEventSeries, splitEventRule, type EventVaultPort } from "./eventSeries";
	import { EventSeriesModal } from "./EventSeriesModal";
	import type { TimedBlock } from "./timeGrid";

	let {
		occ,
		app,
		dispatcher,
		vault,
		block = null,
	}: {
		occ: EventOccurrence;
		app: App;
		dispatcher: IntentDispatcher;
		vault: EventVaultPort;
		/** Геометрия для тайм-сетки; null — обычный chip (месяц/неделя/агенда/«Весь день»). */
		block?: TimedBlock | null;
	} = $props();

	const leftPct = $derived(block === null ? 0 : (block.laneIndex / block.laneCount) * 100);
	const widthPct = $derived(block === null ? 100 : 100 / block.laneCount);
	/** «19:00–20:30» в блоке при собственном конце; иначе бейдж времени в тексте. */
	const rangeLabel = $derived(
		block !== null && block.hasEnd && occ.timeEnd !== null ? `${occ.time}–${occ.timeEnd}` : null,
	);
	/** Короткий блок (≤30 мин): шапка времени прячется — место названию
	 *  (та же логика, что у блоков задач; время остаётся в title-подсказке). */
	const compact = $derived(block !== null && block.endMin - block.startMin <= 30);
	const tooltip = $derived(
		`Повторяющееся событие: ${occ.title}` +
			(compact && occ.time !== null ? ` (${rangeLabel ?? occ.time})` : ""),
	);

	function openEdit(): void {
		const { rule, time } = splitEventRule(occ.task.recurrence ?? "");
		new EventSeriesModal(
			app,
			{ name: occ.title, rule, time },
			"Изменить серию",
			(name, ruleText) => {
				void editEventSeries({ vault, task: occ.task, name, ruleText }).then((res) => {
					if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
				});
			},
		).open();
	}

	async function deleteSeries(): Promise<void> {
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

	function onContextMenu(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();
		menu.addItem((mi) => mi.setTitle("Изменить серию…").setIcon("pencil").onClick(() => openEdit()));
		menu.addItem((mi) =>
			mi.setTitle("Удалить серию").setIcon("trash").onClick(() => void deleteSeries()),
		);
		menu.showAtMouseEvent(e);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="gtd-cal-chip gtd-cal-event"
	class:is-block={block !== null}
	style={block !== null ? `top:${block.topPct}%; height:${block.heightPct}%; left:${leftPct}%; width:${widthPct}%` : ""}
	title={tooltip}
	oncontextmenu={onContextMenu}
>
	{#if block !== null}
		<!-- блок тайм-сетки: шапка-время сверху (прячется у коротких), название с переносами -->
		{#if rangeLabel !== null && !compact}
			<div class="gtd-tg-ev-range">{rangeLabel}</div>
		{/if}
		<div class="gtd-tg-ev-body">
			<span class="gtd-cal-event-mark" aria-label="Повторяющееся событие">⟳</span>
			<span class="gtd-cal-chip-text is-wrapping">{occ.title}</span>
		</div>
	{:else}
		{#if rangeLabel !== null}
			<span class="gtd-cal-chip-time">{rangeLabel}</span>
		{/if}
		<span class="gtd-cal-event-mark" aria-label="Повторяющееся событие">⟳</span>
		{#if rangeLabel === null && occ.time !== null}
			<span class="gtd-cal-chip-time">{occ.time}</span>
		{/if}
		<span class="gtd-cal-chip-text">{occ.title}</span>
	{/if}
</div>

<style>
	/* стили EventChip component-scoped — событие несёт собственный полный набор.
	   Класс .gtd-cal-chip оставлен для .closest() в обработчиках ячейки/колонки
	   (клик по событию не должен запускать quick-add/создание). */
	.gtd-cal-event {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 1px 4px;
		border-radius: var(--radius-s, 4px);
		font-size: var(--font-ui-smaller, 0.85em);
		cursor: default;
		border: 1px dashed var(--background-modifier-border);
		background: var(--background-secondary-alt, var(--background-secondary));
	}
	.gtd-cal-event.is-block {
		position: absolute;
		box-sizing: border-box;
		min-height: 20px;
		flex-direction: column;
		align-items: stretch;
		gap: 0;
		padding: 0;
		overflow: hidden;
		z-index: 1; /* под реальными задачами (их блоки z-index:2) */
	}
	.gtd-tg-ev-range {
		flex: none;
		padding: 0 4px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
		border-bottom: 1px dashed var(--background-modifier-border);
		white-space: nowrap;
		overflow: hidden;
	}
	.gtd-tg-ev-body {
		display: flex;
		gap: 4px;
		align-items: flex-start;
		padding: 1px 4px;
		min-height: 0;
		overflow: hidden;
	}
	.gtd-cal-chip-text.is-wrapping {
		white-space: normal;
		overflow-wrap: anywhere;
		line-height: 1.25;
	}
	.gtd-cal-event-mark {
		flex: none;
		color: var(--text-accent, var(--text-muted));
	}
	.gtd-cal-chip-time {
		flex: none;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.gtd-cal-chip-text {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
