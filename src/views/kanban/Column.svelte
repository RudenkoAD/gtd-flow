<script lang="ts">
	import { Menu, Notice, Platform, type App } from "obsidian";
	import type { BoardDef } from "../../core/board/boardFile";
	import type { IsoDate } from "../../core/model/Task";
	import type { BoardService } from "../../services/BoardService";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { confirm } from "../common/ConfirmModal";
	import TaskCard from "../common/TaskCard.svelte";
	import { nlCaptureHint } from "../common/taskActions";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import { runAction } from "../common/runAction";
	import { insertIndexByY, type FlatRect } from "../dnd/dndCore";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import {
		columnCaptureTransform,
		isFromTickler,
		type BoardWritePort,
		type ColumnVM,
	} from "./kanbanLogic";

	let {
		column,
		boardPath,
		def,
		boards,
		dnd,
		dispatcher,
		app,
		settings,
		vault,
		today,
		menuPorts = null,
	}: {
		column: ColumnVM;
		boardPath: string;
		def: BoardDef;
		boards: BoardService;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		/** Структурный порт записи задачи в файл доски; совместим с VaultAdapter. */
		vault: BoardWritePort;
		today: IsoDate;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
	} = $props();

	// ТЗ §8: на телефоне drag не инициируем — жест уходит длинному тапу карточки
	const cardDraggable = $derived(dnd !== null && !Platform.isPhone);

	let colEl: HTMLElement | null = $state(null);
	let listEl: HTMLElement | null = $state(null);

	/** Позиция вставки из вертикали курсора: rect'ы карточек → dndCore. */
	function dropIndex(y: number): number {
		if (listEl === null) return column.tasks.length;
		const rects: FlatRect[] = [];
		for (const child of Array.from(listEl.children)) {
			const r = child.getBoundingClientRect();
			rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
		}
		return insertIndexByY(rects, y);
	}

	// Drop-цель — вся колонка (шапка тоже принимает).
	// Замыкание drop читает реактивные props — цель всегда бьёт в актуальную доску.
	$effect(() => {
		if (dnd === null || colEl === null) return;
		return dnd.registerDropTarget({
			el: colEl,
			accepts: (p) => p.taskKey !== "",
			drop: async (p, ctx) => {
				const index = dropIndex(ctx.clientY);
				// Tickler → Kanban — не два независимых dispatch: сервис сохраняет
				// исходный 🛫, компенсирует провал движения и возвращает его при
				// неуспехе. Поэтому задача не исчезает из обоих представлений.
				const res = await runAction("не удалось перенести карточку", () =>
					isFromTickler(p.sourceViewType)
						? boards.moveCardFromTickler(boardPath, def, p.taskKey, column.id, index)
						: boards.moveCard(boardPath, def, p.taskKey, column.id, index),
				);
				if (res === null || !res.ok) {
					return;
				}
				if (isFromTickler(p.sourceViewType))
					new Notice("Возвращена из отложенных и перенесена на доску");
			},
		});
	});

	function onCardPointerDown(e: PointerEvent, taskKey: string): void {
		if (!cardDraggable || dnd === null || e.button !== 0) return;
		// клики по контролам карточки (чекбокс, меню) — не начало drag
		if (e.target instanceof Element && e.target.closest("input, button, a, select, textarea"))
			return;
		dnd.startDrag(
			{ taskKey, sourceViewType: VIEW_TYPES.kanban },
			e,
			e.currentTarget as HTMLElement,
		);
	}

	// --- переименование колонки: дабл-клик по заголовку ---
	// Одиночный клик по заголовку намеренно ничего не делает (сворачивание убрано
	// по фидбеку). С drag карточек конфликта нет: заголовок не drag-источник
	// (pointerdown навешан только на карточки в теле колонки).
	let renaming = $state(false);
	let renameValue = $state("");
	let renameInputEl: HTMLInputElement | null = $state(null);

	$effect(() => {
		if (renaming && renameInputEl !== null) {
			renameInputEl.focus();
			renameInputEl.select();
		}
	});

	function onHeaderDblClick(): void {
		renaming = true;
		renameValue = column.name;
	}

	async function commitRename(): Promise<void> {
		if (!renaming) return; // blur после Escape/Enter — уже обработано
		renaming = false;
		const name = renameValue.trim();
		if (name === "" || name === column.name) return;
		try {
			const res = await boards.renameColumn(boardPath, column.id, name);
			if (!res.ok)
				new Notice(
					`GTD Flow: не удалось переименовать колонку (${res.reason ?? "unknown"})`,
				);
		} catch (error) {
			new Notice(`GTD Flow: не удалось переименовать колонку: ${String(error)}`);
		}
	}

	function onRenameKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			void commitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			renaming = false; // отмена; последующий blur — no-op (guard в commitRename)
		}
	}

	// --- меню колонки: ⋯ в заголовке (переименовать / влево / вправо / удалить) ---

	function startRename(): void {
		renaming = true;
		renameValue = column.name;
	}

	async function moveCol(dir: -1 | 1): Promise<void> {
		try {
			const res = await boards.moveColumn(boardPath, column.id, dir);
			if (!res.ok)
				new Notice(`GTD Flow: не удалось переставить колонку (${res.reason ?? "unknown"})`);
		} catch (error) {
			new Notice(`GTD Flow: не удалось переставить колонку: ${String(error)}`);
		}
	}

	async function deleteCol(): Promise<void> {
		try {
			const ok = await confirm(
				app,
				"Удалить колонку",
				`Колонка «${column.name}» будет убрана с доски. Теги карточек (${column.match}) ` +
					`останутся в задачах — карточки просто перестанут показываться на доске.`,
				"Удалить",
			);
			if (!ok) return;
			const res = await boards.deleteColumn(boardPath, column.id);
			if (!res.ok)
				new Notice(`GTD Flow: не удалось удалить колонку (${res.reason ?? "unknown"})`);
		} catch (error) {
			new Notice(`GTD Flow: не удалось удалить колонку: ${String(error)}`);
		}
	}

	function openColMenu(e: MouseEvent): void {
		e.stopPropagation(); // не даём клику дойти до заголовка (dblclick-переименование)
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Переименовать").setIcon("pencil").onClick(startRename));
		menu.addItem((i) =>
			i
				.setTitle("Влево")
				.setIcon("arrow-left")
				.onClick(() => void moveCol(-1)),
		);
		menu.addItem((i) =>
			i
				.setTitle("Вправо")
				.setIcon("arrow-right")
				.onClick(() => void moveCol(1)),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Удалить колонку…")
				.setIcon("trash")
				.onClick(() => void deleteCol()),
		);
		menu.showAtMouseEvent(e);
	}

	// --- создание задачи прямо в колонке (＋ внизу): серийный ввод как во Входящих ---

	let addingTask = $state(false);
	let newTaskText = $state("");
	let addTaskInputEl: HTMLInputElement | null = $state(null);
	// живая подсказка распознанной даты (NLP): «📅 чт 15 авг · 15:00» или null
	const nlHint = $derived(nlCaptureHint(newTaskText, today));

	$effect(() => {
		if (addingTask && addTaskInputEl !== null) addTaskInputEl.focus();
	});

	function cancelAddTask(): void {
		addingTask = false;
		newTaskText = "";
	}

	async function commitAddTask(): Promise<void> {
		// тег колонки метит строку (column.match) → задача ляжет в эту колонку; тег
		// скрыт в отображении карточки (stripColumnTags). Пусто → остаёмся в поле.
		const transform = columnCaptureTransform(newTaskText, column.match, today);
		if (transform === null) return;
		const entered = newTaskText;
		newTaskText = ""; // очистка сразу — серийный ввод, фокус остаётся на input
		try {
			await vault.ensureFile(boardPath);
			const ok = await vault.processFile(boardPath, transform);
			// новая карточка появится сама после реиндекса файла доски
			if (!ok) new Notice(`GTD Flow: не удалось записать задачу в ${boardPath}: ${entered}`);
		} catch (e) {
			// поле уже очищено — возвращаем текст в уведомлении, чтобы ввод не пропал
			new Notice(`GTD Flow: не удалось записать задачу: ${String(e)}\nТекст: ${entered}`, 0);
		}
	}

	function onAddTaskKeydown(e: KeyboardEvent): void {
		// IME: Enter подтверждает композицию, а не отправку (образец Inbox.svelte)
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === "Enter") {
			e.preventDefault();
			void commitAddTask();
		} else if (e.key === "Escape") {
			// не отдаём Escape наружу — он закрыл бы попап/модал вокруг вида
			e.preventDefault();
			e.stopPropagation();
			cancelAddTask();
		}
	}
</script>

<section class="gtd-kanban-col" bind:this={colEl} aria-label={column.name}>
	{#if renaming}
		<div class="gtd-kanban-col-header is-renaming">
			<input
				class="gtd-kanban-col-rename"
				type="text"
				aria-label="Новое имя колонки"
				bind:this={renameInputEl}
				bind:value={renameValue}
				onkeydown={onRenameKeydown}
				onblur={commitRename}
			/>
		</div>
	{:else}
		<!-- одиночный клик по заголовку ничего не делает; дабл-клик — переименование,
		     ⋯ — меню (доступная альтернатива дабл-клику) -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gtd-kanban-col-header"
			ondblclick={onHeaderDblClick}
			title="Дабл-клик — переименовать колонку"
		>
			<span class="gtd-kanban-col-name">{column.name}</span>
			<span class="gtd-kanban-col-count">{column.count}</span>
			<button
				class="gtd-kanban-col-menu"
				title="Меню колонки"
				aria-label="Меню колонки"
				onclick={openColMenu}
			>
				⋯
			</button>
		</div>
	{/if}
	<div class="gtd-kanban-col-body">
		{#if column.tasks.length === 0}
			<div class="gtd-kanban-col-empty">Пусто</div>
		{/if}
		<div class="gtd-kanban-cards" bind:this={listEl}>
			{#each column.tasks as task (task.key)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="gtd-kanban-card"
					class:is-draggable={cardDraggable}
					onpointerdown={(e) => onCardPointerDown(e, task.key)}
				>
					<TaskCard
						{task}
						{dispatcher}
						{app}
						{settings}
						{today}
						{menuPorts}
						inBoard={true}
					/>
				</div>
			{/each}
		</div>
		{#if addingTask}
			<div class="gtd-kanban-add-task is-editing">
				<input
					class="gtd-kanban-add-task-input"
					type="text"
					placeholder="Новая задача…"
					aria-label="Новая задача в колонке"
					bind:this={addTaskInputEl}
					bind:value={newTaskText}
					onkeydown={onAddTaskKeydown}
					onblur={cancelAddTask}
				/>
				{#if nlHint !== null}
					<div class="gtd-nl-hint" aria-label="Распознанная дата">{nlHint}</div>
				{/if}
			</div>
		{:else}
			<button
				class="gtd-kanban-add-task"
				title="Добавить задачу"
				onclick={() => (addingTask = true)}
			>
				＋ Задача
			</button>
		{/if}
	</div>
</section>

<style>
	.gtd-kanban-col {
		flex: 0 0 260px;
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: 100%;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-m, 8px);
		overflow: hidden;
	}
	.gtd-kanban-col-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		border: none;
		border-bottom: 1px solid var(--background-modifier-border);
		box-shadow: none;
		background: transparent;
		color: var(--text-normal);
		cursor: pointer;
		font-weight: 600;
		text-align: left;
	}
	.gtd-kanban-col-header:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-kanban-col-header.is-renaming,
	.gtd-kanban-col-header.is-renaming:hover {
		cursor: default;
		background: transparent;
	}
	.gtd-kanban-col-rename {
		width: 100%;
		font-weight: 600;
	}
	.gtd-kanban-col-name {
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gtd-kanban-col-count {
		flex: none;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		background: var(--background-primary);
		border-radius: var(--radius-s, 4px);
		padding: 1px 6px;
	}
	.gtd-kanban-col-menu {
		flex: none;
		padding: 0 6px;
		background: transparent;
		box-shadow: none;
		color: var(--text-faint);
		cursor: pointer;
		font-weight: 700;
		line-height: 1;
	}
	.gtd-kanban-col-menu:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}
	.gtd-kanban-col-body {
		flex: 1 1 auto;
		min-height: 40px;
		overflow-y: auto;
	}
	/* «＋ Задача» внизу колонки: неброская full-width кнопка, инлайн-поле по клику */
	.gtd-kanban-add-task {
		display: block;
		width: 100%;
		padding: 6px 10px;
		background: transparent;
		border: none;
		box-shadow: none;
		color: var(--text-faint);
		cursor: pointer;
		text-align: left;
		font-size: var(--font-ui-smaller, 0.85em);
	}
	button.gtd-kanban-add-task:hover {
		background: var(--background-modifier-hover);
		color: var(--text-muted);
	}
	.gtd-kanban-add-task.is-editing {
		padding: 6px 8px;
	}
	.gtd-kanban-add-task-input {
		width: 100%;
	}
	.gtd-nl-hint {
		margin-top: 3px;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-kanban-col-empty {
		padding: 12px 10px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-kanban-card {
		background: var(--background-primary);
	}
	.gtd-kanban-card.is-draggable {
		/* pan-y, не none: вертикальный свайп — нативному скроллу колонки (иначе
		   заполненная колонка непрокручиваема тачем); long-press без движения
		   активирует drag, дальше pan гасит touchmove-guard DndService;
		   на телефоне drag выключен — скролл и длинный тап полностью нативные */
		touch-action: pan-y;
		cursor: grab;
	}
	.gtd-kanban-card.is-draggable:active {
		cursor: grabbing;
	}
</style>
