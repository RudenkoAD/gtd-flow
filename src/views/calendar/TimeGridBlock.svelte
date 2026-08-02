<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import { addDaysIso } from "../common/dates";
	import type { DndPort } from "../dnd/types";
	import EventChip from "./EventChip.svelte";
	import type { PlacedEvent } from "./calendarLogic";
	import {
		minutesFromOffsetY,
		minutesToTime,
		resizeEndMin,
		SNAP_STEP_MIN,
		snapMinutes,
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
	const resizable = !Platform.isMobileApp;

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
	/** Короткий блок (≤30 мин): шапка с временем прячется — место названию
	 *  (фидбек). Во время resize шапка видна всегда: это live-индикатор конца.
	 *  Время остаётся в title-подсказке блока. */
	const compact = $derived(!resizing && endMinEff - block.startMin <= 30);

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

	async function persistEnd(endMin: number): Promise<void> {
		const timeEnd = minutesToTime(endMin); // 1440 клампится к "23:59"
		// вырожденный конец (start в последней минуте суток) — не пишем
		if (timeEnd <= minutesToTime(block.startMin)) {
			previewEndMin = null;
			return;
		}
		try {
			const res = await dispatcher.dispatch({
				type: "set-date",
				key: ev.task.key,
				field: ev.field,
				date,
				timeEnd,
			});
			if (!res.ok) {
				previewEndMin = null; // откат превью — на диске ничего не поменялось
				new Notice(`GTD Flow: ${res.reason}`);
			}
		} catch (error) {
			previewEndMin = null;
			new Notice(`GTD Flow: не удалось изменить длительность: ${String(error)}`);
		}
	}

	function onResizeUp(): void {
		if (!resizing) return;
		resizing = false;
		const endMin = previewEndMin;
		if (endMin === null) return;
		void persistEnd(endMin);
	}

	function onResizeCancel(): void {
		if (!resizing) return;
		resizing = false;
		previewEndMin = null;
	}

	/** Keyboard move: arrows shift the task by one snap or one day. Shift+arrows
	 * resize the end edge. These use the same `set-date` write as pointer actions. */
	function onBlockKeydown(e: KeyboardEvent): void {
		if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
		e.preventDefault();
		if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			const currentEnd = previewEndMin ?? block.endMin;
			const end = resizeEndMin(
				currentEnd + (e.key === "ArrowUp" ? -SNAP_STEP_MIN : SNAP_STEP_MIN),
				block.startMin,
			);
			previewEndMin = end;
			void persistEnd(end);
			return;
		}

		let nextDate = date;
		let nextStart = block.startMin;
		if (e.key === "ArrowLeft") nextDate = addDaysIso(date, -1);
		else if (e.key === "ArrowRight") nextDate = addDaysIso(date, 1);
		else if (e.key === "ArrowUp") nextStart = Math.max(0, block.startMin - SNAP_STEP_MIN);
		else nextStart = Math.min(1440 - SNAP_STEP_MIN, block.startMin + SNAP_STEP_MIN);

		const duration = block.hasEnd ? block.endMin - block.startMin : 0;
		const nextEnd = duration > 0 ? Math.min(1439, nextStart + duration) : null;
		void (async () => {
			try {
				const res = await dispatcher.dispatch({
					type: "set-date",
					key: ev.task.key,
					field: ev.field,
					date: nextDate,
					time: minutesToTime(snapMinutes(nextStart)),
					...(nextEnd === null ? {} : { timeEnd: minutesToTime(nextEnd) }),
				});
				if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			} catch (error) {
				new Notice(`GTD Flow: не удалось перенести задачу: ${String(error)}`);
			}
		})();
	}
</script>

<div
	class="gtd-tg-block"
	class:has-range={rangeLabel !== null}
	class:is-resizing={resizing}
	bind:this={el}
	title={compact ? rangeLabel : null}
	style="top:{block.topPct}%; height:{heightPctEff}%; left:{leftPct}%; width:{widthPct}%"
>
	{#if rangeLabel !== null && !compact}
		<div class="gtd-tg-block-range">{rangeLabel}</div>
	{/if}
	<EventChip {ev} {today} {dnd} {dispatcher} {app} {settings} {menuPorts} dragAnchor={el} />
	<!-- Отдельный фокусируемый контрол: не делаем весь блок интерактивным div,
	     потому что внутри есть чекбокс EventChip. Стрелки двигают, Shift+↑/↓
	     меняют длину тем же set-date путём, что и pointer-жест. -->
	<button
		type="button"
		class="gtd-tg-block-move"
		aria-label={`Переместить ${ev.task.description}: стрелки — перенос, Shift+стрелки вверх/вниз — длительность`}
		aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
		onkeydown={onBlockKeydown}
		onclick={() => new Notice("Используйте стрелки для перемещения задачи")}>↔</button
	>
	{#if resizable}
		<button
			type="button"
			class="gtd-tg-block-resize"
			aria-label="Изменить длительность: Shift+стрелка вверх или вниз"
			onpointerdown={onResizeDown}
			onpointermove={onResizeMove}
			onpointerup={onResizeUp}
			onpointercancel={onResizeCancel}
			onkeydown={(e) => {
				if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				e.stopPropagation();
				const end = resizeEndMin(
					(previewEndMin ?? block.endMin) +
						(e.key === "ArrowUp" ? -SNAP_STEP_MIN : SNAP_STEP_MIN),
					block.startMin,
				);
				previewEndMin = end;
				void persistEnd(end);
			}}
		></button>
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
	/* строка-диапазон уже показывает начало-конец — бейдж "14:30" чипа лишний;
	   в компактном режиме шапки нет, но время живёт в title-подсказке блока */
	.gtd-tg-block.has-range :global(.gtd-cal-chip-time) {
		display: none;
	}
	/* Внутри блока (в отличие от чипов месяца) названию есть куда расти —
	   переносим строки вместо обрезания; клип по низу блока даёт overflow чипа */
	.gtd-tg-block :global(.gtd-cal-chip-text) {
		white-space: normal;
		overflow-wrap: anywhere;
		line-height: 1.25;
	}
	.gtd-tg-block-resize {
		position: absolute;
		left: 0;
		right: 2px; /* совпадает с padding-right блока */
		bottom: 0;
		height: 6px;
		z-index: 3; /* поверх чипа — pointerdown достаётся ручке, не drag'у чипа */
		cursor: ns-resize;
		padding: 0;
		border: 0;
		background: transparent;
		touch-action: none; /* на десктопном тач-экране resize не скроллит сетку */
	}
	.gtd-tg-block-move {
		position: absolute;
		top: 2px;
		right: 4px;
		z-index: 4;
		min-width: 18px;
		height: 18px;
		padding: 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s, 4px);
		background: var(--background-primary);
		color: var(--text-muted);
		opacity: 0;
		cursor: move;
	}
	.gtd-tg-block:hover .gtd-tg-block-move,
	.gtd-tg-block-move:focus-visible {
		opacity: 1;
	}
	.gtd-tg-block-move:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: 1px;
	}
	.gtd-tg-block-resize:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: -2px;
	}
</style>
