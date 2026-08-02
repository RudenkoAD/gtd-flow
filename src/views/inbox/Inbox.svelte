<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { type Readable } from "svelte/store";
	import type { Task } from "../../core/model/Task";
	import { defaultInboxConfig } from "../../core/query/querySpec";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { inboxStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import TaskCard from "../common/TaskCard.svelte";
	import { ensureCaptureFile, nlCaptureHint } from "../common/taskActions";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import VirtualList from "../common/VirtualList.svelte";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { filterTasks, inboxCaptureTransform, type InboxWritePort } from "./inboxLogic";

	let {
		taskStore,
		dispatcher,
		settings,
		settingsRevision,
		app,
		dnd = null,
		menuPorts = null,
		vault,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		/** Обновляется после saveSettings; settings мутируются in-place. */
		settingsRevision: Readable<number>;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd?: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Структурный порт записи для быстрого ввода; совместим с VaultAdapter. */
		vault: InboxWritePort;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	let tasks = $state<Task[]>([]);
	$effect(() => {
		void $settingsRevision;
		const store = inboxStore(
			taskStore,
			() => defaultInboxConfig(settings.inboxIncludePlain, settings.inboxFile),
			settings.debounceMs.queryRecompute,
			settingsRevision,
		);
		return store.subscribe((value) => (tasks = value));
	});
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	let query = $state("");
	const shown = $derived(filterTasks(tasks, query));
	const filtered = $derived(query.trim() !== "");
	// --- quick capture into the configured unified inbox ---
	let newTask = $state("");
	// живая подсказка распознанной даты (NLP): «📅 чт 15 авг · 15:00» или null
	const nlHint = $derived(nlCaptureHint(newTask, $today));

	async function addTask(): Promise<void> {
		const transform = inboxCaptureTransform(newTask, $today);
		if (transform === null) return; // пусто после санитации — молча ничего
		const target = settings.inboxFile;
		const entered = newTask;
		newTask = ""; // очистка сразу — быстрый ввод серии, фокус остаётся на input
		try {
			if (!(await ensureCaptureFile(vault, target))) {
				new Notice(
					`GTD Flow: не удалось подготовить файл входящих ${target}\nТекст: ${entered}`,
					0,
				);
				return;
			}
			const ok = await vault.processFile(target, transform);
			// новая задача появится в списке сама после реиндекса
			if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}: ${entered}`);
		} catch (e) {
			// поле уже очищено — возвращаем текст в уведомлении, чтобы ввод не пропал
			new Notice(
				`GTD Flow: не удалось записать в ${target}: ${String(e)}\nТекст: ${entered}`,
				0,
			);
		}
	}

	function onNewTaskKeydown(e: KeyboardEvent): void {
		// Enter в IME подтверждает композицию, а не отправку; keyCode 229 —
		// WebKit/iOS, где на коммит-Enter isComposing уже false (образец в commands.ts)
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === "Enter") {
			e.preventDefault();
			void addTask();
		} else if (e.key === "Escape") {
			// не отдаём Escape наружу — он закрыл бы попап/модал вокруг вида
			e.preventDefault();
			e.stopPropagation();
			newTask = "";
		}
	}
</script>

<div class="gtd-inbox">
	<div class="gtd-inbox-header">
		<span class="gtd-inbox-count" aria-label="Количество задач">
			{filtered ? `${shown.length} / ${tasks.length}` : tasks.length}
		</span>
		<input
			class="gtd-inbox-filter"
			type="search"
			placeholder="Фильтр…"
			aria-label="Фильтр входящих"
			bind:value={query}
		/>
	</div>
	<div class="gtd-inbox-new">
		<input
			class="gtd-inbox-new-input"
			type="text"
			placeholder="Новая задача…"
			aria-label="Новая задача"
			bind:value={newTask}
			onkeydown={onNewTaskKeydown}
		/>
		{#if nlHint !== null}
			<div class="gtd-nl-hint" aria-label="Распознанная дата">{nlHint}</div>
		{/if}
	</div>
	{#if shown.length === 0}
		<div class="gtd-inbox-empty">
			{filtered ? "Ничего не найдено" : "Входящие пусты"}
		</div>
	{:else}
		<VirtualList
			items={shown}
			threshold={settings.virtualizeThreshold}
			keyOf={(task) => task.key}
		>
			{#snippet row(task)}
				<TaskCard
					{task}
					{dispatcher}
					{app}
					{settings}
					today={$today}
					{dnd}
					dragPayload={{ taskKey: task.key, sourceViewType: VIEW_TYPES.inbox }}
					{menuPorts}
				/>
			{/snippet}
		</VirtualList>
	{/if}
</div>

<style>
	.gtd-inbox {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow-x: hidden;
		container-type: inline-size;
	}
	.gtd-inbox-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-inbox-count {
		flex: none;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		background: var(--background-secondary);
		border-radius: var(--radius-s, 4px);
		padding: 1px 8px;
	}
	.gtd-inbox-filter {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-inbox-new {
		flex: none;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-inbox-new-input {
		width: 100%;
	}
	.gtd-nl-hint {
		margin-top: 3px;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-inbox-empty {
		padding: 24px 10px;
		text-align: center;
		color: var(--text-muted);
	}

	@media (pointer: coarse) {
		.gtd-inbox-filter,
		.gtd-inbox-new-input {
			min-height: 44px;
			font-size: max(16px, 1em);
			touch-action: manipulation;
		}
	}

	@container (max-width: 34rem) {
		.gtd-inbox-header,
		.gtd-inbox-new {
			padding: 8px;
		}
		.gtd-inbox-count {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
