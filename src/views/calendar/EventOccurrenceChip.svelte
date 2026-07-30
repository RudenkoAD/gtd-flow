<script lang="ts">
	import { Platform, type App } from "obsidian";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { obsidianTooltip } from "../common/tooltip";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { agendaTimeLabel, type EventOccurrence } from "./calendarLogic";
	import { showEventMenu } from "./eventMenu";
	import { type EventVaultPort } from "./eventSeries";
	import { type TimedBlock } from "./timeGrid";
	import { occurrenceKeyboardAction, surfaceKeyboardAction } from "./calendarKeyboard";

	let {
		occ,
		app,
		dispatcher,
		vault,
		settings,
		block = null,
		dnd = null,
		onKeyboardMove = null,
	}: {
		occ: EventOccurrence;
		app: App;
		dispatcher: IntentDispatcher;
		vault: EventVaultPort;
		/** Настройки — для цели «Копировать…» у внешнего события. */
		settings: GtdFlowSettings;
		/** Геометрия для тайм-сетки; null — обычный chip (месяц/неделя/агенда/«Весь день»). */
		block?: TimedBlock | null;
		/** DnD-порт: непусто только в блоках тайм-сетки — там вхождение можно тянуть. */
		dnd?: DndPort | null;
		/** Клавиатурный перенос timed-вхождения (реализует TimeGridCol). */
		onKeyboardMove?:
			((key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => void) | null;
	} = $props();

	/** Событие из файла-зеркала внешнего календаря (gtd-external): read-only —
	 *  приглушённый вид, метка 🔗, меню без правок/удаления/переноса. */
	const external = $derived(occ.task.external === true);
	/** External-event copies always become local events in the configured global file. */
	const copyTargetFile = $derived(settings.eventsFile);

	/** Корневой элемент — призрак drag'а и якорь времени (верх блока = время начала). */
	let rootEl = $state<HTMLElement | null>(null);

	const isSeries = $derived(occ.kind === "series");
	const leftPct = $derived(block === null ? 0 : (block.laneIndex / block.laneCount) * 100);
	const widthPct = $derived(block === null ? 100 : 100 / block.laneCount);
	/** «19:00–20:30» в блоке при собственном конце; иначе бейдж времени в тексте. */
	const rangeLabel = $derived(
		block !== null && block.hasEnd && occ.timeEnd !== null
			? `${occ.time}–${occ.timeEnd}`
			: null,
	);
	/** Бейдж времени вне блока (агенда/месяц/«Весь день»): «19:00–20:30» при
	 *  заданном конце, иначе «19:00»; null — «Весь день» (без времени). */
	const timeLabel = $derived(agendaTimeLabel(occ.time, occ.timeEnd));
	/** Короткий блок (≤30 мин): шапка времени прячется — место названию
	 *  (та же логика, что у блоков задач; время остаётся в title-подсказке). */
	const compact = $derived(block !== null && block.endMin - block.startMin <= 30);
	/** Одиночный маркер: внешнее — 🔗, серия — ⟳, одноразовое событие — ◇. */
	const mark = $derived(external ? "🔗" : isSeries ? "⟳" : "◇");
	const markLabel = $derived(
		external ? "Внешнее событие" : isSeries ? "Повторяющееся событие" : "Событие",
	);
	/** Провенанс переноса у одноразового: подсказка «перенесено из серии». */
	const movedFromSeries = $derived(!isSeries && occ.task.spawnedFrom !== null);
	const tooltipPrefix = $derived(
		external
			? "Внешнее событие: "
			: isSeries
				? "Повторяющееся событие: "
				: movedFromSeries
					? "Событие (перенесено из серии): "
					: "Событие: ",
	);
	const tooltip = $derived(
		tooltipPrefix +
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
	/** Тянуть можно только блок тайм-сетки на десктопе (как чипы задач, ТЗ §8).
	 *  Внешнее событие тянуть нельзя — перенос затёрся бы синхронизацией (read-only). */
	const draggable = $derived(block !== null && dnd !== null && !Platform.isPhone && !external);
	/** Перенос стрелками — клавиатурный дублёр drag, поэтому и ограничения те же:
	 *  внешнее событие не двигаем (правка ушла бы в файл-зеркало и была бы затёрта
	 *  ближайшим синком; меню внешнего события правки и так прячет). Один флаг на
	 *  обработчик, aria-label и aria-keyshortcuts — иначе клавиатура обещала бы
	 *  скринридеру то, чего не делает. */
	const keyboardMovable = $derived(block !== null && onKeyboardMove !== null && !external);

	/** Начало drag блока-вхождения: призрак — весь блок, время при drop — по его верху. */
	function onPointerDown(e: PointerEvent): void {
		if (!draggable || dnd === null || rootEl === null || e.button !== 0) return;
		if (e.target instanceof Element && e.target.closest("input, button, a, select, textarea"))
			return;
		dnd.startDrag(
			{
				taskKey: occ.task.key,
				sourceViewType: VIEW_TYPES.calendar,
				grabOffsetY: e.clientY - rootEl.getBoundingClientRect().top,
				occurrence: {
					kind: occ.kind,
					date: occ.date,
					time: occ.time,
					timeEnd: occ.timeEnd,
				},
			},
			e,
			rootEl,
		);
	}

	/** ПКМ по чипу/блоку события — общее меню события (eventMenu.ts): один источник
	 *  пунктов и действий для чипов (месяц/агенда/«Весь день») и блоков почасовой сетки. */
	function onContextMenu(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		showEventMenu(e, { occ, app, dispatcher, vault, external, copyTargetFile });
	}

	function openMenuFromKeyboard(): void {
		if (rootEl === null) return;
		const rect = rootEl.getBoundingClientRect();
		const e = new MouseEvent("contextmenu", {
			bubbles: true,
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
		});
		onContextMenu(e);
	}

	/** Enter/Space and the menu key expose the context menu without a mouse.
	 * Timed editable occurrences additionally support arrow-key movement; the
	 * parent performs the same transfer operation as drag-and-drop. */
	function onKeydown(e: KeyboardEvent): void {
		const surfaceAction = surfaceKeyboardAction(e.key, e.shiftKey);
		if (surfaceAction === "quick-add") {
			e.preventDefault();
			openMenuFromKeyboard();
			return;
		}
		if (surfaceAction === "menu") {
			e.preventDefault();
			openMenuFromKeyboard();
			return;
		}
		const move = occurrenceKeyboardAction(e.key);
		// onKeyboardMove повторён явно: сузить тип через $derived-флаг компилятор не может
		if (keyboardMovable && move !== null && onKeyboardMove !== null) {
			e.preventDefault();
			// `occurrenceKeyboardAction` is the shared policy check; narrow the
			// original DOM key before forwarding it to the typed move port.
			switch (e.key) {
				case "ArrowLeft":
				case "ArrowRight":
				case "ArrowUp":
				case "ArrowDown":
					onKeyboardMove(e.key);
			}
		}
	}
</script>

<div
	class="gtd-cal-chip gtd-cal-event"
	class:is-block={block !== null}
	class:is-single={!isSeries}
	class:is-external={external}
	class:is-draggable={draggable}
	bind:this={rootEl}
	role="button"
	tabindex="0"
	aria-label={`${markLabel}: ${occ.title}. Enter — меню${keyboardMovable ? ", стрелки — перенести" : ""}`}
	aria-keyshortcuts={keyboardMovable ? "ArrowLeft ArrowRight ArrowUp ArrowDown" : undefined}
	style={block !== null
		? `top:${block.topPct}%; height:${block.heightPct}%; left:${leftPct}%; width:${widthPct}%`
		: ""}
	title={locationText === null ? tooltip : null}
	use:obsidianTooltip={{
		text: eventTooltip,
		placement: "bottom",
		classes: ["gtd-event-tooltip"],
	}}
	onpointerdown={onPointerDown}
	oncontextmenu={onContextMenu}
	onkeydown={onKeydown}
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
	/* внешнее событие (зеркало, read-only): скромный отличитель — приглушённый вид
	   (метка 🔗 несёт основной сигнал, дизайн-систему не изобретаем) */
	.gtd-cal-event.is-external {
		opacity: 0.8;
		border-style: dotted;
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
