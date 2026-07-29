<script lang="ts">
	import { Menu, Modal, Notice, type App } from "obsidian";
	import type { Readable } from "svelte/store";
	import type { BoardService } from "../../services/BoardService";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskStore } from "../../stores/taskStore";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import { runAction } from "../common/runAction";
	import type { DndPort } from "../dnd/types";
	import Column from "./Column.svelte";
	import {
		buildColumnVMs,
		pickBoardPath,
		uniqueBoardPath,
		type BoardWritePort,
		type KanbanPersistedState,
	} from "./kanbanLogic";

	let {
		taskStore,
		dispatcher,
		settings,
		settingsRevision,
		app,
		boards,
		dnd,
		menuPorts = null,
		vault,
		persisted,
		persist,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		settingsRevision: Readable<number>;
		app: App;
		/** null до интеграции этапа 4 в main.ts (plugin.boards). */
		boards: BoardService | null;
		/** null — drag выключен (plugin.dnd ещё не подключён / телефон). */
		dnd: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Структурный порт записи задачи в файл доски; совместим с VaultAdapter. */
		vault: BoardWritePort;
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
	const defaultBoardPath = $derived.by(() => {
		void $settingsRevision;
		return settings.defaultBoardPath || null;
	});

	let selectedPath = $state<string | null>(null);

	// восстановление из viewState (setState приходит после onOpen — поэтому store)
	$effect(() =>
		persisted.subscribe((s) => {
			if (s.boardPath !== undefined) selectedPath = s.boardPath;
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
	const columns = $derived(model === null ? [] : buildColumnVMs(model.columns));

	function persistNow(): void {
		persist(shownPath !== null ? { boardPath: shownPath } : {});
	}

	function onSelectBoard(e: Event): void {
		selectedPath = (e.currentTarget as HTMLSelectElement).value;
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
		try {
			const res = await boards.addColumn(shownPath, name);
			if (res.ok) cancelAddCol();
			// при отказе input остаётся с текстом — можно поправить имя и повторить
			else new Notice(`GTD Flow: не удалось создать колонку (${res.reason ?? "unknown"})`);
		} catch (error) {
			new Notice(`GTD Flow: не удалось создать колонку: ${String(error)}`);
		}
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

	// --- создание / переименование доски ---

	// Модал с одним полем «Название» (паттерн TextPromptModal, ProjectGraph.svelte).
	class TextPromptModal extends Modal {
		constructor(
			modalApp: App,
			private readonly promptTitle: string,
			private readonly initial: string,
			private readonly placeholder: string,
			private readonly onSubmit: (text: string) => void,
		) {
			super(modalApp);
		}

		override onOpen(): void {
			this.titleEl.setText(this.promptTitle);
			const wrap = this.contentEl.createDiv();
			wrap.style.display = "flex";
			wrap.style.gap = "8px";
			const input = wrap.createEl("input", { type: "text" });
			input.style.flex = "1 1 auto";
			input.placeholder = this.placeholder;
			input.value = this.initial;
			const submit = (): void => {
				const value = input.value.trim();
				if (value === "") return;
				this.close();
				this.onSubmit(value);
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
			});
			const ok = wrap.createEl("button", { text: "OK", cls: "mod-cta" });
			ok.addEventListener("click", submit);
			input.focus();
			input.select();
		}

		override onClose(): void {
			this.contentEl.empty();
		}
	}

	function promptCreateBoard(): void {
		if (boards === null) return;
		const svc = boards;
		new TextPromptModal(app, "Новая доска", "", "Название доски", (name) => {
			const inboxDir = settings.inboxFile.split("/").slice(0, -1).join("/");
			const dir = inboxDir === "" ? "Boards" : `${inboxDir}/Boards`;
			// уникализуем путь по реальным файлам хранилища: createBoard не должен
			// дописать флаг доски в чужую заметку с тем же именем
			const path = uniqueBoardPath(dir, name, (p) => app.vault.getFileByPath(p) !== null);
			void (async () => {
				const res = await runAction("не удалось создать доску", () =>
					svc.createBoard(path, name),
				);
				if (res === null || !res.ok || res.path === undefined) return;
				// выбрать созданную доску; она появится в списке после реиндекса
				// (файл виден discovery по frontmatter-флагу даже без задач)
				selectedPath = res.path;
				persist({ boardPath: res.path });
			})();
		}).open();
	}

	function promptRenameBoard(): void {
		if (boards === null || shownPath === null) return;
		const svc = boards;
		const path = shownPath;
		const current = discovery.boards.find((b) => b.path === path)?.def.name ?? "";
		new TextPromptModal(app, "Переименовать доску", current, "Название доски", (name) => {
			void runAction("не удалось переименовать доску", () => svc.renameBoard(path, name));
		}).open();
	}

	function openBoardMenu(e: MouseEvent): void {
		if (boards === null || shownPath === null) return;
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle("Переименовать доску…").setIcon("pencil").onClick(promptRenameBoard),
		);
		menu.showAtMouseEvent(e);
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
		{#if boards !== null}
			<button class="gtd-kanban-new-board" title="Создать доску" onclick={promptCreateBoard}>
				＋ Доска
			</button>
		{/if}
		{#if boards !== null && shownPath !== null}
			<button
				class="gtd-kanban-board-menu"
				title="Меню доски"
				aria-label="Меню доски"
				onclick={openBoardMenu}
			>
				⋯
			</button>
		{/if}
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
			<p>Досок пока нет.</p>
			<button class="mod-cta gtd-kanban-create-board" onclick={promptCreateBoard}>
				＋ Создать доску
			</button>
		</div>
	{:else}
		<div class="gtd-kanban-board">
			{#each columns as column (column.id)}
				<Column
					{column}
					boardPath={model.path}
					def={model.def}
					{boards}
					{dnd}
					{dispatcher}
					{app}
					{settings}
					{vault}
					today={$today}
					{menuPorts}
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
		max-width: 50%;
	}
	.gtd-kanban-new-board {
		flex: none;
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-kanban-board-menu {
		flex: none;
		padding: 4px 8px;
		background: transparent;
		box-shadow: none;
		color: var(--text-muted);
		cursor: pointer;
		font-weight: 700;
		line-height: 1;
	}
	.gtd-kanban-board-menu:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
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
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}
	.gtd-kanban-create-board {
		cursor: pointer;
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
