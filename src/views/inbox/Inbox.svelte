<script lang="ts">
	import type { App } from "obsidian";
	import { defaultInboxConfig } from "../../core/query/querySpec";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { inboxStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import TaskCard from "../common/TaskCard.svelte";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import VirtualList from "../common/VirtualList.svelte";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { filterTasks } from "./inboxLogic";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
		dnd = null,
		menuPorts = null,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd?: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const tasks = inboxStore(
		taskStore,
		defaultInboxConfig(settings.inboxSources),
		settings.debounceMs.queryRecompute,
	);
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	let query = $state("");
	const shown = $derived(filterTasks($tasks, query));
	const filtered = $derived(query.trim() !== "");
</script>

<div class="gtd-inbox">
	<div class="gtd-inbox-header">
		<span class="gtd-inbox-count" aria-label="Количество задач">
			{filtered ? `${shown.length} / ${$tasks.length}` : $tasks.length}
		</span>
		<input
			class="gtd-inbox-filter"
			type="search"
			placeholder="Фильтр…"
			bind:value={query}
		/>
	</div>
	{#if shown.length === 0}
		<div class="gtd-inbox-empty">
			{filtered ? "Ничего не найдено" : "Входящие пусты"}
		</div>
	{:else}
		<VirtualList items={shown}>
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
	.gtd-inbox-empty {
		padding: 24px 10px;
		text-align: center;
		color: var(--text-muted);
	}
</style>
