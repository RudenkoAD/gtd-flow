/**
 * Geometry helpers for the measured virtual list.
 *
 * Keeping the prefix-sum/search work outside the Svelte component makes the
 * variable-height contract testable without a DOM.  Heights are keyed by an
 * item identity in the component, so reordering never transfers a measured
 * height (or an edited row) to a different task.
 */

/** Build cumulative offsets. `offsets[i]` is the top of item i. */
export function cumulativeOffsets(
	count: number,
	measured: ReadonlyMap<string, number>,
	keys: readonly string[],
	estimatedHeight: number,
): number[] {
	const offsets = new Array<number>(count + 1);
	offsets[0] = 0;
	for (let i = 0; i < count; i++) {
		const key = keys[i] ?? String(i);
		const measuredHeight = measured.get(key);
		const height =
			measuredHeight !== undefined && Number.isFinite(measuredHeight) && measuredHeight > 0
				? measuredHeight
				: estimatedHeight;
		offsets[i + 1] = offsets[i]! + height;
	}
	return offsets;
}

/** First item whose bottom is after `offset`. */
export function firstVisibleIndex(offsets: readonly number[], offset: number): number {
	const count = Math.max(0, offsets.length - 1);
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if ((offsets[mid + 1] ?? 0) <= offset) lo = mid + 1;
		else hi = mid;
	}
	return Math.min(lo, Math.max(0, count - 1));
}

export interface VisibleRange {
	first: number;
	last: number;
}

/**
 * Return an exclusive visible range with an item-count overscan.  The caller
 * can render [first, last) at `offsets[first]` without assuming a fixed row
 * height.
 */
export function measuredVisibleRange(
	offsets: readonly number[],
	scrollTop: number,
	viewportHeight: number,
	overscan: number,
): VisibleRange {
	const count = Math.max(0, offsets.length - 1);
	if (count === 0) return { first: 0, last: 0 };
	const safeScrollTop = Math.max(0, scrollTop);
	const safeViewport = Math.max(0, viewportHeight);
	const first = Math.max(0, firstVisibleIndex(offsets, safeScrollTop) - Math.max(0, overscan));
	const afterViewport = firstVisibleIndex(offsets, safeScrollTop + safeViewport);
	const last = Math.min(count, afterViewport + 1 + Math.max(0, overscan));
	return { first, last: Math.max(first, last) };
}
