<script lang="ts">
	import { Notice, type App } from "obsidian";
	import type { Readable } from "svelte/store";
	import type { BoardService } from "../../services/BoardService";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskStore } from "../../stores/taskStore";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import Column from "./Column.svelte";
	import {
		buildColumnVMs,
		pickBoardPath,
		toggleCollapsed,
		type KanbanPersistedState,
	} from "./kanbanLogic";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
		boards,
		dnd,
		menuPorts = null,
		persisted,
		persist,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
		/** null до интеграции этапа 4 в main.ts (plugin.boards). */
		boards: BoardService | null;
		/** null — drag выключен (plugin.dnd ещё не подключён / телефон). */
		dnd: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Состояние из workspace-раскладки; приходит ПОСЛЕ монтирования. */
		persisted: Readable<KanbanPersistedState>;
		persist: (s: KanbanPersistedState) => void;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const epoch = taskStore.epoch;
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	// настройка появится в SettingsTab позже; поле читаем опционально
	// svelte-ignore state_referenced_locally
	const defaultBoardPath =
		(settings as GtdFlowSettings & { defaultBoardPath?: string }).defaultBoardPath ?? null;

	let selectedPath = $state<string | null>(null);
	let collapsed = $state<Record<string, boolean>>({});

	// восстановление из viewState (setState приходит после onOpen — поэтому store)
	$effect(() =>
		persisted.subscribe((s) => {
			if (s.boardPath !== undefined) selectedPath = s.boardPath;
			if (s.collapsed !== undefined) collapsed = { ...s.collapsed };
		}),
	);

	const discovery = $derived.by(() => {
		void $epoch; // доски живут в индексе — пересканируем на каждую его смену
		return boards === null ? { boards: [], errors: [] } : boards.discoverBoards();
	});
	const shownPath = $derived(pickBoardPath(discovery.boards, defaultBoardPath, selectedPath));
	const model = $derived.by(() => {
		void $epoch;
		if (boards === null || shownPath === null) return null;
		const entry = discovery.boards.find((b) => b.path === shownPath);
		return entry === undefined ? null : boards.boardModel(entry.path, entry.def);
	});
	const columns = $derived(model === null ? [] : buildColumnVMs(model.columns, collapsed));

	function persistNow(): void {
		persist({
			...(shownPath !== null ? { boardPath: shownPath } : {}),
			collapsed,
		});
	}

	function onSelectBoard(e: Event): void {
		selectedPath = (e.currentTarget as HTMLSelectElement).value;
		persistNow();
	}

	function onToggle(colId: string): void {
		collapsed = toggleCollapsed(collapsed, colId);
		persistNow();
	}

	// --- добавление колонки («призрачная» колонка с «+» в конце доски) ---

	let addingCol = $state(false);
	let newColName = $state("");
	let addInputEl: HTMLInputElement | null = $state(null);

	// фокус в инлайн-input сразу после появления
	$effect(() => {
		if (addingCol && addInputEl !== null) addInputEl.focus();
	});

	function cancelAddCol(): void {
		addingCol = false;
		newColName = "";
	}

	async function commitAddCol(): Promise<void> {
		const name = newColName.trim();
		if (name === "" || boards === null || shownPath === null) {
			cancelAddCol();
			return;
		}
		const res = await boards.addColumn(shownPath, name);
		if (res.ok) cancelAddCol();
		// при отказе input остаётся с текстом — можно поправить имя и повторить
		else new Notice(`GTD Flow: не удалось создать колонку (${res.reason ?? "unknown"})`);
	}

	function onAddColKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			void commitAddCol();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelAddCol();
		}
	}
</script>

<div class="gtd-kanban">
	<div class="gtd-kanban-header">
		<select
			class="dropdown gtd-kanban-select"
			aria-label="Доска"
			disabled={discovery.boards.length === 0}
			value={shownPath ?? ""}
			onchange={onSelectBoard}
		>
			{#each discovery.boards as b (b.path)}
				<option value={b.path}>{b.def.name}</option>
			{/each}
		</select>
		{#if discovery.errors.length > 0}
			<span
				class="gtd-kanban-errors"
				title={discovery.errors.map((e) => `${e.path}: ${e.error}`).join("\n")}
			>
				⚠ {discovery.errors.length}
			</span>
		{/if}
	</div>

	{#if boards === null}
		<div class="gtd-kanban-empty">Kanban не подключён (сервис досок недоступен)</div>
	{:else if model === null}
		<div class="gtd-kanban-empty">
			Досок не найдено. Создайте заметку с frontmatter <code>gtd-board: true</code>,
			полями <code>id</code> и <code>columns</code> — и хотя бы одной задачей в файле.
		</div>
	{:else}
		<div class="gtd-kanban-board">
			{#each columns as column (column.id)}
				<Column
					{column}
					boardPath={model.path}
					def={model.def}
					boards={boards}
					{dnd}
					{dispatcher}
					{app}
					{settings}
					today={$today}
					{menuPorts}
					{onToggle}
				/>
			{/each}
			{#if addingCol}
				<div class="gtd-kanban-add-col is-editing">
					<input
						class="gtd-kanban-add-input"
						type="text"
						placeholder="Название колонки"
						aria-label="Название новой колонки"
						bind:this={addInputEl}
						bind:value={newColName}
						onkeydown={onAddColKeydown}
						onblur={cancelAddCol}
					/>
				</div>
			{:else}
				<button
					class="gtd-kanban-add-col"
					title="Добавить колонку"
					onclick={() => (addingCol = true)}
				>
					+
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.gtd-kanban {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-kanban-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-kanban-select {
		max-width: 60%;
	}
	.gtd-kanban-errors {
		color: var(--text-warning, var(--text-muted));
		font-size: var(--font-ui-smaller, 0.85em);
		cursor: help;
	}
	.gtd-kanban-empty {
		padding: 24px 12px;
		text-align: center;
		color: var(--text-muted);
	}
	.gtd-kanban-board {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		align-items: stretch;
		gap: 10px;
		padding: 10px;
		overflow-x: auto; /* горизонтальный скролл доски (ТЗ §4) */
		overflow-y: hidden;
	}
	/* «призрачная» колонка: та же ширина, но пунктир и без заливки */
	.gtd-kanban-add-col {
		flex: 0 0 260px;
		align-self: flex-start;
		min-height: 80px;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 10px;
		background: transparent;
		border: 1px dashed var(--background-modifier-border);
		border-radius: var(--radius-m, 8px);
		box-shadow: none;
		color: var(--text-faint);
		font-size: 1.4em;
		cursor: pointer;
	}
	button.gtd-kanban-add-col:hover {
		background: var(--background-modifier-hover);
		color: var(--text-muted);
	}
	.gtd-kanban-add-col.is-editing {
		cursor: default;
	}
	.gtd-kanban-add-input {
		width: 100%;
	}
</style>
