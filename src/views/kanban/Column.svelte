<script lang="ts">
	import { Notice, Platform, type App } from "obsidian";
	import type { BoardDef } from "../../core/board/boardFile";
	import type { IsoDate } from "../../core/model/Task";
	import type { BoardService } from "../../services/BoardService";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import TaskCard from "../common/TaskCard.svelte";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import { insertIndexByY, type FlatRect } from "../dnd/dndCore";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import type { ColumnVM } from "./kanbanLogic";

	let {
		column,
		boardPath,
		def,
		boards,
		dnd,
		dispatcher,
		app,
		settings,
		today,
		menuPorts = null,
		onToggle,
	}: {
		column: ColumnVM;
		boardPath: string;
		def: BoardDef;
		boards: BoardService;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		today: IsoDate;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		onToggle: (colId: string) => void;
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

	// Drop-цель — вся колонка (шапка и свёрнутая полоска тоже принимают).
	// Замыкание drop читает реактивные props — цель всегда бьёт в актуальную доску.
	$effect(() => {
		if (dnd === null || colEl === null) return;
		return dnd.registerDropTarget({
			el: colEl,
			accepts: (p) => p.taskKey !== "",
			drop: async (p, ctx) => {
				const res = await boards.moveCard(boardPath, def, p.taskKey, column.id, dropIndex(ctx.clientY));
				if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			},
		});
	});

	function onCardPointerDown(e: PointerEvent, taskKey: string): void {
		if (!cardDraggable || dnd === null || e.button !== 0) return;
		// клики по контролам карточки (чекбокс, меню) — не начало drag
		if (e.target instanceof Element && e.target.closest("input, button, a, select, textarea")) return;
		dnd.startDrag({ taskKey, sourceViewType: VIEW_TYPES.kanban }, e, e.currentTarget as HTMLElement);
	}

	// --- переименование колонки: дабл-клик по заголовку ---
	// Конфликт с одиночным кликом (сворачивание): нельзя сворачивать сразу,
	// иначе после первого клика шапка сменится на вертикальную полоску и
	// dblclick прилетит уже в другой элемент. Поэтому collapse откладывается
	// на 250 мс (типовой double-click interval); второй клик в окне отменяет
	// таймер и открывает rename. Цена — едва заметная задержка сворачивания.
	// С drag карточек конфликта нет: заголовок не является drag-источником
	// (pointerdown навешан только на карточки в теле колонки).
	const DBLCLICK_MS = 250;
	let collapseTimer: number | null = null;

	let renaming = $state(false);
	let renameValue = $state("");
	let renameInputEl: HTMLInputElement | null = $state(null);

	$effect(() => {
		if (renaming && renameInputEl !== null) {
			renameInputEl.focus();
			renameInputEl.select();
		}
	});

	// таймер не должен сработать после демонтажа колонки
	$effect(() => () => {
		if (collapseTimer !== null) window.clearTimeout(collapseTimer);
	});

	function onHeaderClick(): void {
		if (collapseTimer !== null) return; // второй клик серии — его обработает dblclick
		collapseTimer = window.setTimeout(() => {
			collapseTimer = null;
			onToggle(column.id); // одиночный клик — сворачивание, как и раньше
		}, DBLCLICK_MS);
	}

	function onHeaderDblClick(): void {
		if (collapseTimer !== null) {
			window.clearTimeout(collapseTimer);
			collapseTimer = null;
		}
		renaming = true;
		renameValue = column.name;
	}

	async function commitRename(): Promise<void> {
		if (!renaming) return; // blur после Escape/Enter — уже обработано
		renaming = false;
		const name = renameValue.trim();
		if (name === "" || name === column.name) return;
		const res = await boards.renameColumn(boardPath, column.id, name);
		if (!res.ok) new Notice(`GTD Flow: не удалось переименовать колонку (${res.reason ?? "unknown"})`);
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
</script>

<section
	class="gtd-kanban-col"
	class:is-collapsed={column.collapsed}
	bind:this={colEl}
	aria-label={column.name}
>
	{#if column.collapsed}
		<button
			class="gtd-kanban-col-strip"
			aria-expanded="false"
			onclick={() => onToggle(column.id)}
			title="Развернуть колонку"
		>
			<span class="gtd-kanban-col-strip-name">{column.name}</span>
			<span class="gtd-kanban-col-count">{column.count}</span>
		</button>
	{:else}
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
			<button
				class="gtd-kanban-col-header"
				aria-expanded="true"
				onclick={onHeaderClick}
				ondblclick={onHeaderDblClick}
				title="Свернуть колонку (дабл-клик — переименовать)"
			>
				<span class="gtd-kanban-col-chevron">▾</span>
				<span class="gtd-kanban-col-name">{column.name}</span>
				<span class="gtd-kanban-col-count">{column.count}</span>
			</button>
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
						<TaskCard {task} {dispatcher} {app} {settings} {today} {menuPorts} />
					</div>
				{/each}
			</div>
		</div>
	{/if}
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
	.gtd-kanban-col.is-collapsed {
		flex: 0 0 34px;
	}
	.gtd-kanban-col-header,
	.gtd-kanban-col-strip {
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-normal);
		cursor: pointer;
		font-weight: 600;
	}
	.gtd-kanban-col-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
		text-align: left;
	}
	.gtd-kanban-col-header:hover,
	.gtd-kanban-col-strip:hover {
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
	.gtd-kanban-col-chevron {
		color: var(--text-muted);
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
	.gtd-kanban-col-strip {
		flex: 1 1 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 10px 4px;
	}
	.gtd-kanban-col-strip-name {
		writing-mode: vertical-rl;
		overflow: hidden;
		text-overflow: ellipsis;
		max-height: 60vh;
	}
	.gtd-kanban-col-body {
		flex: 1 1 auto;
		min-height: 40px;
		overflow-y: auto;
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
