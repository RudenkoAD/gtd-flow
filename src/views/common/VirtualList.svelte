<script lang="ts" generics="T">
	import type { Snippet } from "svelte";
	import { SvelteMap } from "svelte/reactivity";
	import { cumulativeOffsets, measuredVisibleRange } from "./virtualListLogic";

	let {
		items,
		itemHeight = 44,
		threshold = 100,
		overscan = 8,
		keyOf = (_item: T, index: number) => String(index),
		row,
	}: {
		items: readonly T[];
		/** Fallback для ещё не измеренных строк, px. */
		itemHeight?: number;
		/** До этого числа строк список рендерится полностью. */
		threshold?: number;
		overscan?: number;
		/** Стабильная идентичность строки — нужна и DOM, и измерениям. */
		keyOf?: (item: T, index: number) => string;
		row: Snippet<[T, number]>;
	} = $props();

	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	const measured = new SvelteMap<string, number>();

	const keys = $derived(items.map((item, index) => keyOf(item, index)));
	const offsets = $derived(cumulativeOffsets(items.length, measured, keys, itemHeight));
	const totalHeight = $derived(offsets[items.length] ?? 0);

	// Для коротких списков избегаем лишних wrapper/observer. Для длинных —
	// offsets строится из фактических высот, поэтому многострочная карточка не
	// даёт зазоры, наложения или недостижимый хвост списка.
	const virtual = $derived(items.length > Math.max(0, threshold));
	const range = $derived(
		virtual
			? measuredVisibleRange(offsets, scrollTop, viewportHeight, overscan)
			: { first: 0, last: items.length },
	);
	const first = $derived(range.first);
	const last = $derived(range.last);
	const visible = $derived(items.slice(first, last));

	function observeRow(node: HTMLElement, key: string): { destroy: () => void } {
		const update = (): void => {
			const height = Math.ceil(node.getBoundingClientRect().height);
			if (height <= 0 || measured.get(key) === height) return;
			measured.set(key, height);
		};
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();
		// Svelte actions return an object in Svelte 5.  Returning the raw
		// destructor worked at runtime, but is not part of the action contract
		// checked by svelte-check.
		return { destroy: () => observer.disconnect() };
	}
</script>

<div
	class="gtd-vlist"
	bind:clientHeight={viewportHeight}
	onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
	{#if virtual}
		<div class="gtd-vlist-spacer" style:height="{totalHeight}px">
			<div class="gtd-vlist-window" style:transform="translateY({offsets[first] ?? 0}px)">
				{#each visible as item, i (keyOf(item, first + i))}
					<div class="gtd-vlist-row" use:observeRow={keyOf(item, first + i)}>
						{@render row(item, first + i)}
					</div>
				{/each}
			</div>
		</div>
	{:else}
		{#each items as item, i (keyOf(item, i))}
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
