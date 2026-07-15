<script lang="ts" generics="T">
	import type { Snippet } from "svelte";

	let {
		items,
		itemHeight = 44,
		overscan = 8,
		row,
	}: {
		items: readonly T[];
		/** Оценка высоты строки, px — только для оффсетов виртуализации. */
		itemHeight?: number;
		overscan?: number;
		row: Snippet<[T, number]>;
	} = $props();

	let scrollTop = $state(0);
	let viewportHeight = $state(0);

	// до 100 строк виртуализация не окупается — рендерим всё
	const virtual = $derived(items.length > 100);
	const first = $derived(virtual ? Math.max(0, Math.floor(scrollTop / itemHeight) - overscan) : 0);
	const last = $derived(
		virtual
			? Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan)
			: items.length,
	);
	const visible = $derived(items.slice(first, last));
</script>

<div
	class="gtd-vlist"
	bind:clientHeight={viewportHeight}
	onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
	{#if virtual}
		<div class="gtd-vlist-spacer" style:height="{items.length * itemHeight}px">
			<div class="gtd-vlist-window" style:transform="translateY({first * itemHeight}px)">
				{#each visible as item, i}
					{@render row(item, first + i)}
				{/each}
			</div>
		</div>
	{:else}
		{#each items as item, i}
			{@render row(item, i)}
		{/each}
	{/if}
</div>

<style>
	.gtd-vlist {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
	.gtd-vlist-spacer {
		position: relative;
		overflow-anchor: none;
	}
	.gtd-vlist-window {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		will-change: transform;
	}
</style>
