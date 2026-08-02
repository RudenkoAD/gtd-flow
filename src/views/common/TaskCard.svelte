<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
	import type { Intent } from "../../core/intents/Intent";
	import type { TaskEstimateProvenance } from "../../core/estimates/provenance";
	import type { IsoDate, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { DndPort, DragPayload } from "../dnd/types";
	import { reportAsync } from "./runAction";
	import { buildTaskMenu, openTaskDetailsModal, type TaskMenuPorts } from "./taskMenu";
	import {
		PRIORITY_ICONS,
		PRIORITY_LABELS,
		dateBadges,
		displaySegments,
		renderWikiLinks,
	} from "./cardFormat";
	import { taskMetadataBadges } from "./taskMetadataDisplay";

	let {
		task,
		dispatcher,
		app,
		settings,
		today,
		inTickler = false,
		inBoard = false,
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
		/** Пункт «Архивировать» — только из вида доски. */
		inBoard?: boolean;
		/** Заданы оба — карточка сама drag-источник (ТЗ §8); иначе как раньше
		 *  (kanban оборачивает карточку своим drag-контейнером). */
		dnd?: DndPort | null;
		dragPayload?: DragPayload;
		/** Порты паритета (меню/карточка/прогресс); null — базовое меню. */
		menuPorts?: TaskMenuPorts | null;
	} = $props();

	// инлайн-редактирование названия (dblclick) — состояние объявлено до
	// draggable: во время правки drag выключен
	let editing = $state(false);
	let editText = $state("");

	// ТЗ §8: на телефоне кросс-видовой drag выключен — startDrag не инициируем,
	// touch-action возвращается нативному скроллу, длинный тап открывает карточку
	const draggable = $derived(
		dnd !== null && dragPayload !== undefined && !Platform.isMobileApp && !editing,
	);

	/**
	 * Event targets from Obsidian pop-out windows belong to another JS realm, so
	 * `target instanceof Element` is false even for a real element. Use the DOM
	 * capability structurally and preserve its receiver when calling it.
	 */
	function closestFromTarget(target: EventTarget | null, selector: string): Element | null {
		if (target === null) return null;
		const closest = (target as { closest?: unknown }).closest;
		if (typeof closest !== "function") return null;
		return closest.call(target, selector) as Element | null;
	}

	function isControl(target: EventTarget | null): boolean {
		return closestFromTarget(target, "input, button, a, select, textarea") !== null;
	}

	function isTaskTitle(target: EventTarget | null): boolean {
		return closestFromTarget(target, ".gtd-task-desc") !== null;
	}

	function onCardPointerDown(e: PointerEvent): void {
		if (editing) return; // во время инлайн-редактирования drag/long-press выключены
		if (isControl(e.target)) return; // клики по контролам — не drag и не long-press
		if (Platform.isMobileApp) {
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
	let suppressNextClick = false;

	function startLongPress(e: PointerEvent): void {
		cancelLongPress();
		lpX = e.clientX;
		lpY = e.clientY;
		lpTimer = window.setTimeout(() => {
			lpTimer = null;
			if (menuPorts?.cards != null) {
				// A browser click follows the completed touch sequence. Consume that
				// synthetic click so long-press opens the card, not the details modal too.
				suppressNextClick = true;
				void openCard();
			}
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

	function finishPointerSequence(): void {
		cancelLongPress();
		// If this pointer sequence produces no click, do not consume a later tap.
		if (suppressNextClick) window.setTimeout(() => (suppressNextClick = false), 0);
	}

	const isDone = $derived(task.statusChar === "x" || task.statusChar === "X");
	// раунд 3: карточки любого статуса живут на доске — отменённая, как и
	// выполненная, показывается зачёркнутой (чекбокс при этом снят)
	const isCancelled = $derived(task.statusChar === "-");
	// вики-ссылки → плоский текст (alias/basename, ссылка на свою карточку прячется),
	// затем сегментация #тегов без структурных тегов колонок доски (#kanban/…)
	const segments = $derived(displaySegments(renderWikiLinks(task.description, task.taskId)));
	const badges = $derived(dateBadges(task));
	let metadataProvenance = $state<TaskEstimateProvenance | null>(null);
	$effect(() => {
		const metadata = menuPorts?.metadata ?? null;
		const taskId = task.taskId;
		metadataProvenance = null;
		if (metadata === null || taskId === null) return;
		let alive = true;
		void metadata
			.provenanceForTask(taskId)
			.then((value) => {
				if (alive) metadataProvenance = value;
			})
			.catch(() => {
				if (alive) metadataProvenance = null;
			});
		return () => {
			alive = false;
		};
	});
	const metadataBadges = $derived(
		taskMetadataBadges(task, menuPorts?.metadata ?? null, metadataProvenance),
	);

	// --- инлайн-редактирование названия (dblclick) ---

	function startEdit(): void {
		editText = task.description;
		editing = true;
	}

	function cancelEdit(): void {
		editing = false;
	}

	function commitEdit(): void {
		const text = editText.trim();
		editing = false;
		if (text === "" || text === task.description) return; // пусто/без изменений = отмена
		void run({ type: "set-text", key: task.key, text });
	}

	function onEditKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			commitEdit();
		} else if (e.key === "Escape") {
			// не отдаём Escape наружу — он закрыл бы модал/попап вокруг вида
			e.preventDefault();
			e.stopPropagation();
			cancelEdit();
		}
	}

	/** use:-экшен: фокус + выделение сразу после появления input в DOM. */
	function focusAndSelect(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

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

	function openCard(): void {
		const cards = menuPorts?.cards ?? null;
		if (cards == null) return; // порт не подключён — карточек нет
		reportAsync("не удалось открыть карточку", async () => {
			const res = await cards.openOrCreate(task.key);
			if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
		});
	}

	function openDetails(): void {
		openTaskDetailsModal({
			task,
			app,
			dispatcher,
			settings,
			today,
			inTickler,
			inBoard,
			ports: menuPorts,
		});
	}

	/**
	 * A card-background click opens task details. The title deliberately remains a
	 * separate target: one click does nothing and a double-click edits it inline.
	 * DndService swallows the synthetic click after a completed drag.
	 */
	function onCardClick(e: MouseEvent): void {
		if (suppressNextClick) {
			suppressNextClick = false;
			return;
		}
		if (editing || isControl(e.target) || isTaskTitle(e.target)) return;
		openDetails();
	}

	// dblclick = inline title edit only. Details live on the surrounding card area
	// and on the explicit keyboard-accessible button.
	function onCardDblClick(e: MouseEvent): void {
		if (editing || isControl(e.target) || !isTaskTitle(e.target)) return;
		startEdit();
	}

	// единая точка write-back: отказ — уведомление, а не тихо съеденный клик
	function run(intent: Intent): void {
		reportAsync("не удалось изменить задачу", async () => {
			const res = await dispatcher.dispatch(intent);
			if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
		});
	}

	function toggleStatus(): void {
		void run(
			isDone
				? { type: "set-status", key: task.key, statusChar: " " }
				: { type: "set-status", key: task.key, statusChar: "x", date: today },
		);
	}

	function openMenu(e: MouseEvent): void {
		buildTaskMenu({
			task,
			app,
			dispatcher,
			settings,
			today,
			inTickler,
			inBoard,
			ports: menuPorts,
		}).showAtMouseEvent(e);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
	class="gtd-task-card"
	class:is-done={isDone}
	class:is-cancelled={isCancelled}
	class:is-draggable={draggable}
	class:is-phone={Platform.isMobileApp}
	onpointerdown={onCardPointerDown}
	onpointermove={onCardPointerMove}
	onpointerup={finishPointerSequence}
	onpointercancel={finishPointerSequence}
	onpointerleave={finishPointerSequence}
	onclick={onCardClick}
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
			{#if editing}
				<!-- Enter = set-text, Escape/пусто = отмена; blur без Enter — тоже отмена -->
				<input
					type="text"
					class="gtd-task-edit"
					bind:value={editText}
					use:focusAndSelect
					onkeydown={onEditKeydown}
					onblur={cancelEdit}
				/>
			{:else}
				{#if task.priority !== "none"}
					<span class="gtd-task-prio" title={PRIORITY_LABELS[task.priority]}
						>{PRIORITY_ICONS[task.priority]}</span
					>
				{/if}
				{#each segments as seg (seg.text)}{#if seg.tag}<span class="tag">{seg.text}</span
						>{:else}{seg.text}{/if}{/each}
			{/if}
		</div>
		{#if badges.length > 0}
			<div class="gtd-task-badges">
				{#each badges as b (b.field)}
					<span class="gtd-task-badge gtd-badge-{b.field}">{b.icon} {b.date}</span>
				{/each}
			</div>
		{/if}
		{#if metadataBadges.length > 0}
			<div class="gtd-task-metadata" aria-label="Task estimate and scope">
				{#each metadataBadges as badge (badge.field)}
					<span class="gtd-task-metadata-badge" title={badge.title}>{badge.label}</span>
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
	<button
		class="gtd-task-details"
		title="Сведения о задаче"
		aria-label="Открыть сведения и редактирование задачи"
		onclick={openDetails}
	>
		ⓘ
	</button>
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
	.gtd-task-card.is-phone {
		align-items: center;
		min-height: 52px;
		padding-block: 4px;
	}
	.gtd-task-card.is-phone .gtd-task-check {
		width: 28px;
		height: 28px;
		margin-block: 8px;
	}
	.gtd-task-card.is-phone .gtd-task-progress,
	.gtd-task-card.is-phone .gtd-task-details,
	.gtd-task-card.is-phone .gtd-task-more {
		min-width: 44px;
		min-height: 44px;
		padding-inline: 8px;
		touch-action: manipulation;
	}
	.gtd-task-card.is-done .gtd-task-desc,
	.gtd-task-card.is-cancelled .gtd-task-desc {
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
	.gtd-task-edit {
		width: 100%;
		font: inherit;
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
	.gtd-task-metadata {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 3px;
	}
	.gtd-task-metadata-badge {
		font-size: var(--font-ui-smaller, 0.8em);
		color: var(--text-muted);
		background: var(--background-secondary-alt);
		border-radius: var(--radius-s, 4px);
		padding: 0 4px;
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
	.gtd-task-details,
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
	.gtd-task-details:hover,
	.gtd-task-more:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
</style>
