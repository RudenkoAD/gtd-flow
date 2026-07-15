<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import EventChip from "./EventChip.svelte";
	import type { PlacedEvent } from "./calendarLogic";
	import {
		minutesFromOffsetY,
		minutesToTime,
		resizeEndMin,
		type TimedBlock,
	} from "./timeGrid";

	let {
		ev,
		block,
		date,
		today,
		dnd,
		dispatcher,
		app,
		settings,
		menuPorts = null,
	}: {
		ev: PlacedEvent;
		/** Геометрия из layoutDay: точная позиция по времени + реальный интервал + дорожка. */
		block: TimedBlock;
		/** Дата колонки — она же дата поля-размещения (set-date при resize). */
		date: IsoDate;
		today: IsoDate;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		menuPorts?: TaskMenuPorts | null;
	} = $props();

	/** Собственный элемент — призрак drag'а и якорь времени (dragAnchor чипа). */
	let el = $state<HTMLElement | null>(null);

	const leftPct = $derived((block.laneIndex / block.laneCount) * 100);
	const widthPct = $derived(100 / block.laneCount);

	// --- resize за нижний край -------------------------------------------------
	// Зоны drag и resize НЕ пересекаются по построению: ручка — СОСЕДНИЙ
	// (не вложенный) элемент чипа, absolute-оверлей нижних 6px блока поверх
	// чипа (z-index выше). pointerdown по ручке всплывает по пути
	// ручка → блок → колонка, чип в пути НЕ участвует — его onpointerdown
	// (старт drag в EventChip) не срабатывает, пороги не нужны.
	// ПКМ-меню и dblclick-редактирование чипа ручка перекрывает только на
	// нижних 6px — компромисс принят как у всех календарей с resize.
	// На телефоне resize выключен (как и drag): пальцем в 6px не попасть,
	// паритет — «Дата…» в меню задачи.
	const resizable = !Platform.isPhone;

	/** Минуты конца live-превью; null — resize не идёт и превью нет. После
	 *  pointerup превью НЕ сбрасывается до прихода нового block.endMin из
	 *  индекса — иначе блок мигал бы старой высотой на время write-back. */
	let previewEndMin = $state<number | null>(null);
	let resizing = $state(false);

	// ИЗМЕНИВШИЙСЯ block.endMin (пришла новая раскладка) гасит превью.
	// Сравнение с последним виденным, а не «любой перезапуск»: раскладка
	// пересобирается и по чужим задачам, превью при этом должно жить.
	// Снимок стартового значения намеренный — дальше ведём вручную в $effect.
	// svelte-ignore state_referenced_locally
	let lastEndMin = block.endMin;
	$effect(() => {
		if (block.endMin !== lastEndMin) {
			lastEndMin = block.endMin;
			previewEndMin = null;
		}
	});

	const endMinEff = $derived(previewEndMin ?? block.endMin);
	const heightPctEff = $derived(((endMinEff - block.startMin) / 1440) * 100);
	/** «14:30–16:00» — при реальном конце или live-превью resize. */
	const rangeLabel = $derived(
		block.hasEnd || previewEndMin !== null
			? `${minutesToTime(block.startMin)}–${minutesToTime(endMinEff)}`
			: null,
	);

	/** Высота колонки (родитель блока, position: relative) — конверсия px → минуты. */
	function colRect(): DOMRect | null {
		const col = el?.parentElement ?? null;
		return col === null ? null : col.getBoundingClientRect();
	}

	function onResizeDown(e: PointerEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		resizing = true;
		previewEndMin = block.endMin;
	}

	function onResizeMove(e: PointerEvent): void {
		if (!resizing) return;
		const rect = colRect();
		if (rect === null) return;
		previewEndMin = resizeEndMin(
			minutesFromOffsetY(e.clientY - rect.top, rect.height),
			block.startMin,
		);
	}

	function onResizeUp(): void {
		if (!resizing) return;
		resizing = false;
		const endMin = previewEndMin;
		if (endMin === null) return;
		const timeEnd = minutesToTime(endMin); // 1440 клампится к "23:59"
		// вырожденный конец (start в последней минуте суток) — не пишем
		if (timeEnd <= minutesToTime(block.startMin)) {
			previewEndMin = null;
			return;
		}
		// тот же field/date; time: undefined — начало не трогаем (контракт SetDate)
		void dispatcher
			.dispatch({ type: "set-date", key: ev.task.key, field: ev.field, date, timeEnd })
			.then((res) => {
				if (!res.ok) {
					previewEndMin = null; // откат превью — на диске ничего не поменялось
					new Notice(`GTD Flow: ${res.reason}`);
				}
			});
	}

	function onResizeCancel(): void {
		if (!resizing) return;
		resizing = false;
		previewEndMin = null;
	}
</script>

<div
	class="gtd-tg-block"
	class:has-range={rangeLabel !== null}
	class:is-resizing={resizing}
	bind:this={el}
	style="top:{block.topPct}%; height:{heightPctEff}%; left:{leftPct}%; width:{widthPct}%"
>
	{#if rangeLabel !== null}
		<div class="gtd-tg-block-range">{rangeLabel}</div>
	{/if}
	<EventChip {ev} {today} {dnd} {dispatcher} {app} {settings} {menuPorts} dragAnchor={el} />
	{#if resizable}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gtd-tg-block-resize"
			aria-hidden="true"
			onpointerdown={onResizeDown}
			onpointermove={onResizeMove}
			onpointerup={onResizeUp}
			onpointercancel={onResizeCancel}
		></div>
	{/if}
</div>

<style>
	.gtd-tg-block {
		position: absolute;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		padding: 0 2px 1px 0;
		min-height: 24px; /* текст читаем даже у 15-минутного интервала */
		z-index: 2; /* над линиями часов */
	}
	.gtd-tg-block.is-resizing {
		z-index: 4; /* над соседями и quick-add — превью не прячется */
		user-select: none;
	}
	.gtd-tg-block-range {
		flex: none;
		padding: 0 4px;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-bottom: none;
		overflow: hidden;
		white-space: nowrap;
	}
	/* Чип внутри блока растягивается на весь интервал; рамка отделяет
	   соседние дорожки при пересечениях. Переменные тем — светлая/тёмная бесплатно. */
	.gtd-tg-block :global(.gtd-cal-chip) {
		flex: 1 1 auto;
		min-height: 0;
		height: auto;
		align-items: flex-start;
		overflow: hidden;
		border: 1px solid var(--background-modifier-border);
		box-shadow: var(--shadow-s, none);
	}
	/* строка-диапазон уже показывает начало-конец — бейдж "14:30" чипа лишний */
	.gtd-tg-block.has-range :global(.gtd-cal-chip-time) {
		display: none;
	}
	.gtd-tg-block-resize {
		position: absolute;
		left: 0;
		right: 2px; /* совпадает с padding-right блока */
		bottom: 0;
		height: 6px;
		z-index: 3; /* поверх чипа — pointerdown достаётся ручке, не drag'у чипа */
		cursor: ns-resize;
		touch-action: none; /* на десктопном тач-экране resize не скроллит сетку */
	}
</style>
