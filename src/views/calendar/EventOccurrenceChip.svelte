<script lang="ts">
	import { Menu, Notice, Platform, type App } from "obsidian";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import { confirm } from "../common/ConfirmModal";
	import { DatePromptModal } from "../common/DatePromptModal";
	import { TextPromptModal } from "../common/TextPromptModal";
	import { obsidianTooltip } from "../common/tooltip";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { agendaTimeLabel, type EventOccurrence } from "./calendarLogic";
	import {
		editEventSeries,
		excludeEventOccurrence,
		setEventLocation,
		splitEventRule,
		transferEventOccurrence,
		type EventVaultPort,
	} from "./eventSeries";
	import { EventSeriesModal } from "./EventSeriesModal";
	import { preservedTimeEnd, type TimedBlock } from "./timeGrid";

	let {
		occ,
		app,
		dispatcher,
		vault,
		block = null,
		dnd = null,
	}: {
		occ: EventOccurrence;
		app: App;
		dispatcher: IntentDispatcher;
		vault: EventVaultPort;
		/** Геометрия для тайм-сетки; null — обычный chip (месяц/неделя/агенда/«Весь день»). */
		block?: TimedBlock | null;
		/** DnD-порт: непусто только в блоках тайм-сетки — там вхождение можно тянуть. */
		dnd?: DndPort | null;
	} = $props();

	/** Корневой элемент — призрак drag'а и якорь времени (верх блока = время начала). */
	let rootEl = $state<HTMLElement | null>(null);

	const isSeries = $derived(occ.kind === "series");
	const leftPct = $derived(block === null ? 0 : (block.laneIndex / block.laneCount) * 100);
	const widthPct = $derived(block === null ? 100 : 100 / block.laneCount);
	/** «19:00–20:30» в блоке при собственном конце; иначе бейдж времени в тексте. */
	const rangeLabel = $derived(
		block !== null && block.hasEnd && occ.timeEnd !== null ? `${occ.time}–${occ.timeEnd}` : null,
	);
	/** Бейдж времени вне блока (агенда/месяц/«Весь день»): «19:00–20:30» при
	 *  заданном конце, иначе «19:00»; null — «Весь день» (без времени). */
	const timeLabel = $derived(agendaTimeLabel(occ.time, occ.timeEnd));
	/** Короткий блок (≤30 мин): шапка времени прячется — место названию
	 *  (та же логика, что у блоков задач; время остаётся в title-подсказке). */
	const compact = $derived(block !== null && block.endMin - block.startMin <= 30);
	/** Одиночный маркер: серия — ⟳, одноразовое событие — ◇. */
	const mark = $derived(isSeries ? "⟳" : "◇");
	const markLabel = $derived(isSeries ? "Повторяющееся событие" : "Событие");
	/** Провенанс переноса у одноразового: подсказка «перенесено из серии». */
	const movedFromSeries = $derived(!isSeries && occ.task.spawnedFrom !== null);
	const tooltip = $derived(
		(isSeries
			? "Повторяющееся событие: "
			: movedFromSeries
				? "Событие (перенесено из серии): "
				: "Событие: ") +
			occ.title +
			(compact && occ.time !== null ? ` (${rangeLabel ?? occ.time})` : ""),
	);
	/** Место события (📍): непустой текст или null. */
	const locationText = $derived(
		occ.location !== null && occ.location.trim() !== "" ? occ.location.trim() : null,
	);
	/** При наличии места — единая Obsidian-подсказка ПОД элементом (placement
	 *  bottom): описание события + строка «📍 <место>». native title при этом
	 *  снимается (см. разметку), чтобы не было двойной подсказки; без места —
	 *  null, и работает прежний native title. */
	const eventTooltip = $derived(locationText === null ? null : `${tooltip}\n📍 ${locationText}`);
	/** Тянуть можно только блок тайм-сетки на десктопе (как чипы задач, ТЗ §8). */
	const draggable = $derived(block !== null && dnd !== null && !Platform.isPhone);

	function openEdit(): void {
		const { rule, time } = splitEventRule(occ.task.recurrence ?? "");
		new EventSeriesModal(
			app,
			{ name: occ.title, rule, time, location: occ.location ?? "" },
			"Изменить серию",
			(name, ruleText, location) => {
				void editEventSeries({ vault, task: occ.task, name, ruleText, location }).then((res) => {
					if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
				});
			},
		).open();
	}

	/** «Место…» — промпт с текущим 📍; пустое = снять поле. Правит строку
	 *  события (серии ИЛИ одноразового) через setEventLocation одной записью. */
	function openLocation(): void {
		new TextPromptModal(
			app,
			"Место события",
			(value) => {
				void setEventLocation({
					vault,
					task: occ.task,
					location: value === "" ? null : value,
				}).then((res) => {
					if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
				});
			},
			occ.location ?? "",
			"Адрес или место (пусто — убрать)",
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

	/** Удалить это вхождение серии: 🚫 <дата> (обратимо) — без confirm. */
	async function deleteOccurrence(): Promise<void> {
		const res = await excludeEventOccurrence({ vault, task: occ.task, date: occ.date });
		if (res.ok) new Notice(`Вхождение ${occ.date} удалено`);
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	/** Удалить одноразовое событие: удаление строки (delete-line), с confirm как у серии. */
	async function deleteSingle(): Promise<void> {
		const ok = await confirm(
			app,
			"Удалить событие?",
			`Удалить событие «${occ.title}» (${occ.date})?`,
			"Удалить событие",
		);
		if (!ok) return;
		const res = await dispatcher.dispatch({ type: "delete-line", key: occ.task.key });
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	/** Перенести вхождение на выбранные дату+время (та же атомарная запись, что и drag). */
	async function applyTransfer(toDate: string, time: string | null): Promise<void> {
		// сохраняем длительность вхождения (конец = новый старт + прежняя длительность)
		const timeEnd =
			time === null ? null : (preservedTimeEnd(occ.time, occ.timeEnd, time) ?? null);
		const res = await transferEventOccurrence({
			vault,
			task: occ.task,
			kind: occ.kind,
			fromDate: occ.date,
			toDate,
			time,
			timeEnd,
		});
		if (res.ok) new Notice(`Перенесено: ${occ.date} → ${toDate}`);
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	function openTransfer(): void {
		new DatePromptModal(
			app,
			"Перенести вхождение…",
			(date, time) => void applyTransfer(date, time),
			occ.date,
			true,
			occ.time,
		).open();
	}

	/** Начало drag блока-вхождения: призрак — весь блок, время при drop — по его верху. */
	function onPointerDown(e: PointerEvent): void {
		if (!draggable || dnd === null || rootEl === null || e.button !== 0) return;
		if (e.target instanceof Element && e.target.closest("input, button, a, select, textarea")) return;
		dnd.startDrag(
			{
				taskKey: occ.task.key,
				sourceViewType: VIEW_TYPES.calendar,
				grabOffsetY: e.clientY - rootEl.getBoundingClientRect().top,
				occurrence: { kind: occ.kind, date: occ.date, time: occ.time, timeEnd: occ.timeEnd },
			},
			e,
			rootEl,
		);
	}

	function onContextMenu(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();
		if (isSeries) {
			menu.addItem((mi) =>
				mi.setTitle("Изменить серию…").setIcon("pencil").onClick(() => openEdit()),
			);
			menu.addItem((mi) =>
				mi.setTitle("Место…").setIcon("map-pin").onClick(() => openLocation()),
			);
			menu.addItem((mi) =>
				mi.setTitle("Перенести вхождение…").setIcon("calendar-clock").onClick(() => openTransfer()),
			);
			menu.addItem((mi) =>
				mi
					.setTitle("Удалить это вхождение")
					.setIcon("calendar-x")
					.onClick(() => void deleteOccurrence()),
			);
			menu.addItem((mi) =>
				mi.setTitle("Удалить серию").setIcon("trash").onClick(() => void deleteSeries()),
			);
		} else {
			menu.addItem((mi) =>
				mi.setTitle("Место…").setIcon("map-pin").onClick(() => openLocation()),
			);
			menu.addItem((mi) =>
				mi.setTitle("Перенести вхождение…").setIcon("calendar-clock").onClick(() => openTransfer()),
			);
			menu.addItem((mi) =>
				mi.setTitle("Удалить событие").setIcon("trash").onClick(() => void deleteSingle()),
			);
		}
		menu.showAtMouseEvent(e);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="gtd-cal-chip gtd-cal-event"
	class:is-block={block !== null}
	class:is-single={!isSeries}
	class:is-draggable={draggable}
	bind:this={rootEl}
	style={block !== null ? `top:${block.topPct}%; height:${block.heightPct}%; left:${leftPct}%; width:${widthPct}%` : ""}
	title={locationText === null ? tooltip : null}
	use:obsidianTooltip={{ text: eventTooltip, placement: "bottom", classes: ["gtd-event-tooltip"] }}
	onpointerdown={onPointerDown}
	oncontextmenu={onContextMenu}
>
	{#if block !== null}
		<!-- блок тайм-сетки: шапка-время сверху (прячется у коротких), название с переносами -->
		{#if rangeLabel !== null && !compact}
			<div class="gtd-tg-ev-range">{rangeLabel}</div>
		{/if}
		<div class="gtd-tg-ev-body">
			<span class="gtd-cal-event-mark" aria-label={markLabel}>{mark}</span>
			<span class="gtd-cal-chip-text is-wrapping">{occ.title}</span>
		</div>
	{:else}
		<span class="gtd-cal-event-mark" aria-label={markLabel}>{mark}</span>
		{#if timeLabel !== null}
			<span class="gtd-cal-chip-time">{timeLabel}</span>
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
	.gtd-cal-event.is-draggable {
		cursor: grab;
		/* pan-y: вертикальный свайп — нативному скроллу сетки; drag — от pointerdown */
		touch-action: pan-y;
	}
	/* одноразовое событие: сплошная рамка отличает его от пунктирной серии */
	.gtd-cal-event.is-single {
		border-style: solid;
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
