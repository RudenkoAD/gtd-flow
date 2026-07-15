<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
	import type { Intent } from "../../core/intents/Intent";
	import type { IsoDate, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { DndPort, DragPayload } from "../dnd/types";
	import { buildTaskMenu, type TaskMenuPorts } from "./taskMenu";
	import {
		PRIORITY_ICONS,
		PRIORITY_LABELS,
		dateBadges,
		segmentDescription,
	} from "./cardFormat";

	let {
		task,
		dispatcher,
		app,
		settings,
		today,
		inTickler = false,
		dnd = null,
		dragPayload,
		menuPorts = null,
	}: {
		task: Task;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		today: IsoDate;
		/** Пункт «Вернуть во входящие» (снять 🛫) — только из вида отложенных. */
		inTickler?: boolean;
		/** Заданы оба — карточка сама drag-источник (ТЗ §8); иначе как раньше
		 *  (kanban оборачивает карточку своим drag-контейнером). */
		dnd?: DndPort | null;
		dragPayload?: DragPayload;
		/** Порты паритета (меню/карточка/прогресс); null — базовое меню. */
		menuPorts?: TaskMenuPorts | null;
	} = $props();

	// ТЗ §8: на телефоне кросс-видовой drag выключен — startDrag не инициируем,
	// touch-action возвращается нативному скроллу, длинный тап открывает карточку
	const draggable = $derived(dnd !== null && dragPayload !== undefined && !Platform.isPhone);

	function isControl(target: EventTarget | null): boolean {
		return target instanceof Element && target.closest("input, button, a, select, textarea") !== null;
	}

	function onCardPointerDown(e: PointerEvent): void {
		if (isControl(e.target)) return; // клики по контролам — не drag и не long-press
		if (Platform.isPhone) {
			startLongPress(e);
			return;
		}
		if (dnd === null || dragPayload === undefined || e.button !== 0) return;
		dnd.startDrag(dragPayload, e, e.currentTarget as HTMLElement);
	}

	// --- длинный тап (только телефон) = открыть карточку ---

	const LONG_TAP_MS = 450;
	const LONG_TAP_SLOP_PX = 10;
	let lpTimer: number | null = null;
	let lpX = 0;
	let lpY = 0;

	function startLongPress(e: PointerEvent): void {
		cancelLongPress();
		lpX = e.clientX;
		lpY = e.clientY;
		lpTimer = window.setTimeout(() => {
			lpTimer = null;
			void openCard();
		}, LONG_TAP_MS);
	}

	function onCardPointerMove(e: PointerEvent): void {
		if (lpTimer === null) return;
		if (Math.hypot(e.clientX - lpX, e.clientY - lpY) > LONG_TAP_SLOP_PX) cancelLongPress();
	}

	function cancelLongPress(): void {
		if (lpTimer !== null) {
			window.clearTimeout(lpTimer);
			lpTimer = null;
		}
	}

	const isDone = $derived(task.statusChar === "x" || task.statusChar === "X");
	const segments = $derived(segmentDescription(task.description));
	const badges = $derived(dateBadges(task));

	// --- прогресс карточки n/m (CardPort.progressOf) ---
	// чек-строки живут в файле-карточке, а не в задаче: их правка НЕ пересоздаёт
	// объект task — пересчёт цепляем к epoch индекса
	let epochVal = $state(0);
	$effect(() => {
		const store = menuPorts?.epoch ?? null;
		if (store == null) return;
		return store.subscribe((v) => {
			epochVal = v;
		});
	});
	const progress = $derived.by(() => {
		void epochVal;
		const cards = menuPorts?.cards ?? null;
		if (cards == null || task.taskId === null) return null;
		return cards.progressOf(task.taskId);
	});

	async function openCard(): Promise<void> {
		const cards = menuPorts?.cards ?? null;
		if (cards == null) return; // порт не подключён — карточек нет
		const res = await cards.openOrCreate(task.key);
		if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
	}

	function onCardDblClick(e: MouseEvent): void {
		if (isControl(e.target)) return;
		void openCard();
	}

	// единая точка write-back: отказ — уведомление, а не тихо съеденный клик
	async function run(intent: Intent): Promise<void> {
		const res = await dispatcher.dispatch(intent);
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	function toggleStatus(): void {
		void run(
			isDone
				? { type: "set-status", key: task.key, statusChar: " " }
				: { type: "set-status", key: task.key, statusChar: "x", date: today },
		);
	}

	function openMenu(e: MouseEvent): void {
		buildTaskMenu({ task, app, dispatcher, settings, today, inTickler, ports: menuPorts })
			.showAtMouseEvent(e);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="gtd-task-card"
	class:is-done={isDone}
	class:is-draggable={draggable}
	onpointerdown={onCardPointerDown}
	onpointermove={onCardPointerMove}
	onpointerup={cancelLongPress}
	onpointercancel={cancelLongPress}
	onpointerleave={cancelLongPress}
	ondblclick={onCardDblClick}
>
	<input
		type="checkbox"
		class="gtd-task-check"
		checked={isDone}
		aria-label={isDone ? "Открыть заново" : "Выполнено"}
		onclick={(e) => {
			// состояние чекбокса придёт из индекса после write-back
			e.preventDefault();
			toggleStatus();
		}}
	/>
	<div class="gtd-task-body">
		<div class="gtd-task-desc">
			{#if task.priority !== "none"}
				<span class="gtd-task-prio" title={PRIORITY_LABELS[task.priority]}
					>{PRIORITY_ICONS[task.priority]}</span
				>
			{/if}
			{#each segments as seg}{#if seg.tag}<span class="tag">{seg.text}</span
				>{:else}{seg.text}{/if}{/each}
		</div>
		{#if badges.length > 0}
			<div class="gtd-task-badges">
				{#each badges as b}
					<span class="gtd-task-badge gtd-badge-{b.field}">{b.icon} {b.date}</span>
				{/each}
			</div>
		{/if}
	</div>
	{#if progress !== null}
		<button
			class="gtd-task-progress"
			title="Открыть карточку"
			aria-label="Чеклист карточки: {progress.done} из {progress.total}"
			onclick={() => void openCard()}
		>
			{progress.done}/{progress.total}
		</button>
	{/if}
	<button class="gtd-task-more" aria-label="Меню задачи" onclick={openMenu}>⋯</button>
</div>

<style>
	.gtd-task-card {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-task-card:hover {
		background: var(--background-secondary);
	}
	.gtd-task-card.is-draggable {
		/* pan-y, не none: вертикальный свайп — нативному скроллу (иначе плотный
		   список карточек непрокручиваем тачем на планшете); неподвижный палец
		   доживает до long-press drag, а активный drag от pan защищает
		   touchmove-guard DndService */
		touch-action: pan-y;
		cursor: grab;
	}
	.gtd-task-card.is-draggable:active {
		cursor: grabbing;
	}
	.gtd-task-card.is-done .gtd-task-desc {
		color: var(--text-muted);
		text-decoration: line-through;
	}
	.gtd-task-check {
		margin-top: 3px;
		flex: none;
	}
	.gtd-task-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-task-desc {
		overflow-wrap: anywhere;
	}
	.gtd-task-prio {
		margin-right: 4px;
	}
	.gtd-task-desc .tag {
		color: var(--text-accent);
		background: var(--background-secondary-alt);
		border-radius: var(--radius-s, 4px);
		padding: 0 4px;
		font-size: 0.9em;
	}
	.gtd-task-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}
	.gtd-task-badge {
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
	}
	.gtd-task-progress {
		flex: none;
		border: none;
		box-shadow: none;
		background: var(--background-secondary-alt);
		color: var(--text-muted);
		cursor: pointer;
		padding: 0 6px;
		border-radius: var(--radius-s, 4px);
		font-size: var(--font-ui-smaller, 0.85em);
		font-variant-numeric: tabular-nums;
	}
	.gtd-task-progress:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
	.gtd-task-more {
		flex: none;
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0 6px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-task-more:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
</style>
