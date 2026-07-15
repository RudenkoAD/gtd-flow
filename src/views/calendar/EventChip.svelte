<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
	import type { Intent } from "../../core/intents/Intent";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { PRIORITY_ICONS, PRIORITY_LABELS, stripColumnTags } from "../common/cardFormat";
	import { buildTaskMenu, type TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { deferredUntil, placedTime, type PlacedEvent } from "./calendarLogic";

	let {
		ev,
		today,
		dnd,
		dispatcher,
		app,
		settings,
		menuPorts = null,
		showDate = null,
		dragAnchor = null,
	}: {
		ev: PlacedEvent;
		today: IsoDate;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Показать дату в самом chip'е (секция просроченных в агенде). */
		showDate?: IsoDate | null;
		/** Блок time-grid вокруг чипа: он становится призраком drag'а, а его
		 *  верх — якорем времени (grabOffsetY в payload). null — обычный чип. */
		dragAnchor?: HTMLElement | null;
	} = $props();

	const isDone = $derived(ev.task.statusChar === "x" || ev.task.statusChar === "X");
	// описание без структурных тегов колонок доски (#kanban/…) — как в TaskCard,
	// иначе чип календаря тащил бы служебный тег в текст и подсказку
	const displayText = $derived(stripColumnTags(ev.task.description));
	// ТЗ §8: на телефоне кросс-видовой drag выключен — меню/пикеры вместо него
	const draggable = $derived(dnd !== null && !Platform.isPhone);
	/** Время поля-размещения — бейдж "14:30" перед текстом. */
	const time = $derived(placedTime(ev.task, ev.field));
	/** TICKLER (start > today): приглушённый чип, маркер ⏰, дата пробуждения в title. */
	const deferred = $derived(deferredUntil(ev.task, today));

	// --- инлайн-редактирование текста (дабл-клик ЛКМ) ---
	let editing = $state(false);
	let draft = $state("");
	// Дабл-клик детектируем ВРУЧНУЮ по click-событиям, а не нативным ondblclick.
	// Причина: после завершённого drag DndService глотает синтезированный click
	// на capture-фазе документа (stopPropagation) — до чипа он не доходит и наш
	// счётчик не взводится, поэтому «drop + быстрый второй клик» редактирование
	// НЕ стартует. Нативный же dblclick браузер собирает независимо от
	// stopPropagation на click: короткий drag внутри чипа (≥5px, отпустили на
	// нём же) + мгновенный клик дали бы случайный вход в редактирование.
	let lastClickAt = 0;
	const DBLCLICK_MS = 400;

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
		if (editing) return; // во время редактирования drag-источник отключён
		if (!draggable || dnd === null || e.button !== 0) return;
		// клик по точке-статусу — не начало drag
		if (e.target instanceof Element && e.target.closest("input, button, a, select, textarea")) return;
		if (dragAnchor !== null) {
			// блок сетки: призрак — весь блок, время при drop — по его верху
			dnd.startDrag(
				{
					taskKey: ev.task.key,
					sourceViewType: VIEW_TYPES.calendar,
					grabOffsetY: e.clientY - dragAnchor.getBoundingClientRect().top,
				},
				e,
				dragAnchor,
			);
			return;
		}
		dnd.startDrag(
			{ taskKey: ev.task.key, sourceViewType: VIEW_TYPES.calendar },
			e,
			e.currentTarget as HTMLElement,
		);
	}

	function openMenu(e: MouseEvent): void {
		buildTaskMenu({ task: ev.task, app, dispatcher, settings, today, ports: menuPorts })
			.showAtMouseEvent(e);
	}

	/** ПКМ — меню задачи. Во время редактирования не мешаем нативному меню input. */
	function onContextMenu(e: MouseEvent): void {
		if (editing) return;
		e.preventDefault();
		e.stopPropagation();
		openMenu(e);
	}

	/** ЛКМ: одиночный клик — ничего (взводит счётчик), два подряд — редактирование. */
	function onClick(): void {
		if (editing) return;
		const now = Date.now();
		if (now - lastClickAt <= DBLCLICK_MS) {
			lastClickAt = 0;
			startEdit();
		} else {
			lastClickAt = now;
		}
	}

	function startEdit(): void {
		draft = ev.task.description;
		editing = true;
	}

	function focusEdit(el: HTMLInputElement): void {
		el.focus();
		el.select();
	}

	function cancelEdit(): void {
		editing = false;
	}

	/**
	 * Enter и blur-с-изменениями — запись set-text; пустой или неизменённый текст —
	 * отмена (blur-без-изменений по фидбеку). Guard по editing: blur после
	 * Enter/Escape (input уходит из DOM) не диспатчит второй раз.
	 */
	function commitEdit(): void {
		if (!editing) return;
		editing = false;
		const text = draft.trim();
		if (text === "" || text === ev.task.description) return;
		void run({ type: "set-text", key: ev.task.key, text });
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
	class="gtd-cal-chip"
	class:is-done={isDone}
	class:is-draggable={draggable && !editing}
	class:is-deferred={deferred !== null}
	title={deferred !== null ? `Отложена до ${deferred}` : displayText}
	onpointerdown={onPointerDown}
	onclick={onClick}
	oncontextmenu={onContextMenu}
>
	{#if editing}
		<input
			class="gtd-cal-chip-edit"
			type="text"
			aria-label="Текст задачи"
			bind:value={draft}
			use:focusEdit
			onkeydown={(e) => {
				if (e.key === "Enter") commitEdit();
				else if (e.key === "Escape") cancelEdit();
			}}
			onblur={commitEdit}
		/>
	{:else}
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
		{#if deferred !== null}
			<span class="gtd-cal-chip-defer" aria-label="Отложена">⏰</span>
		{/if}
		{#if ev.task.priority !== "none"}
			<span class="gtd-cal-chip-prio" title={PRIORITY_LABELS[ev.task.priority]}
				>{PRIORITY_ICONS[ev.task.priority]}</span
			>
		{/if}
		{#if time !== null}
			<span class="gtd-cal-chip-time">{time}</span>
		{/if}
		<span class="gtd-cal-chip-text">{displayText}</span>
	{/if}
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
		/* pan-y, не none: вертикальный свайп — нативному скроллу списка событий
		   дня; long-press drag защищён touchmove-guard'ом DndService */
		touch-action: pan-y;
	}
	.gtd-cal-chip.is-deferred {
		opacity: 0.5;
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
	.gtd-cal-chip-defer {
		flex: none;
	}
	.gtd-cal-chip-prio {
		flex: none;
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
	.gtd-cal-chip-edit {
		flex: 1 1 auto;
		min-width: 0;
		height: auto;
		padding: 0 2px;
		font-size: inherit;
	}
</style>
