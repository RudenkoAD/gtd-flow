<script lang="ts">
	import type { App } from "obsidian";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { ticklerStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import TaskCard from "../common/TaskCard.svelte";
	import { BUCKET_ORDER, bucketize, type BucketId } from "./buckets";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const tasks = ticklerStore(taskStore, settings.debounceMs.queryRecompute);
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	const buckets = $derived(bucketize($tasks, $today, settings.firstDayOfWeek));

	let collapsed = $state<Record<BucketId, boolean>>({
		tomorrow: false,
		thisWeek: false,
		later: false,
	});
</script>

<div class="gtd-tickler">
	{#if $tasks.length === 0}
		<div class="gtd-tickler-empty">Отложенных задач нет</div>
	{:else}
		{#each BUCKET_ORDER as bucket (bucket.id)}
			{@const list = buckets[bucket.id]}
			<section class="gtd-bucket">
				<button
					class="gtd-bucket-header"
					aria-expanded={!collapsed[bucket.id]}
					onclick={() => (collapsed[bucket.id] = !collapsed[bucket.id])}
				>
					<span class="gtd-bucket-chevron" class:is-collapsed={collapsed[bucket.id]}>▸</span>
					<span class="gtd-bucket-title">{bucket.title}</span>
					<span class="gtd-bucket-count">{list.length}</span>
				</button>
				{#if !collapsed[bucket.id]}
					{#each list as task (task.key)}
						<TaskCard {task} {dispatcher} {app} {settings} today={$today} inTickler={true} />
					{:else}
						<div class="gtd-bucket-empty">Пусто</div>
					{/each}
				{/if}
			</section>
		{/each}
	{/if}
</div>

<style>
	.gtd-tickler {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
	.gtd-tickler-empty {
		padding: 24px 10px;
		text-align: center;
		color: var(--text-muted);
	}
	.gtd-bucket-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		border: none;
		box-shadow: none;
		background: var(--background-secondary);
		color: var(--text-normal);
		cursor: pointer;
		padding: 5px 10px;
		font-weight: 600;
		text-align: left;
	}
	.gtd-bucket-header:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-bucket-chevron {
		display: inline-block;
		transform: rotate(90deg);
		transition: transform 0.12s ease;
		color: var(--text-muted);
	}
	.gtd-bucket-chevron.is-collapsed {
		transform: rotate(0deg);
	}
	.gtd-bucket-title {
		flex: 1 1 auto;
	}
	.gtd-bucket-count {
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-bucket-empty {
		padding: 8px 10px 12px 26px;
		color: var(--text-faint);
		font-size: var(--font-ui-smaller, 0.85em);
	}
</style>
