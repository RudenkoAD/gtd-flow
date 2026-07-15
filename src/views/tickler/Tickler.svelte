<script lang="ts">
	import { Notice, type App } from "obsidian";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { ticklerStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import TaskCard from "../common/TaskCard.svelte";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { BUCKET_ORDER, bucketDeferDate, bucketize, type BucketId } from "./buckets";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
		dnd = null,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd?: DndPort | null;
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

	let sectionEls = $state<Record<BucketId, HTMLElement | null>>({
		tomorrow: null,
		thisWeek: null,
		later: null,
	});

	// Секция-бакет = drop-цель (ТЗ §8): drop пишет 🛫 = дата бакета
	// (bucketDeferDate). $today читается в drop-замыкании — актуальна на момент
	// жеста, а не регистрации.
	$effect(() => {
		if (dnd === null) return;
		const unregs: (() => void)[] = [];
		for (const bucket of BUCKET_ORDER) {
			const el = sectionEls[bucket.id];
			if (el === null) continue;
			unregs.push(
				dnd.registerDropTarget({
					el,
					accepts: (p) => p.taskKey !== "",
					drop: async (p) => {
						const res = await dispatcher.dispatch({
							type: "defer",
							key: p.taskKey,
							until: bucketDeferDate(bucket.id, $today, settings.firstDayOfWeek),
						});
						if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
					},
				}),
			);
		}
		return () => {
			for (const unreg of unregs) unreg();
		};
	});
</script>

<div class="gtd-tickler">
	<!-- Бакеты видны и при пустом тикле: пустая секция — всё ещё drop-цель. -->
	{#each BUCKET_ORDER as bucket (bucket.id)}
		{@const list = buckets[bucket.id]}
		<section class="gtd-bucket" bind:this={sectionEls[bucket.id]}>
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
					<TaskCard
						{task}
						{dispatcher}
						{app}
						{settings}
						today={$today}
						inTickler={true}
						{dnd}
						dragPayload={{ taskKey: task.key, sourceViewType: VIEW_TYPES.tickler }}
					/>
				{:else}
					<div class="gtd-bucket-empty">Пусто</div>
				{/each}
			{/if}
		</section>
	{/each}
</div>

<style>
	.gtd-tickler {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
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
