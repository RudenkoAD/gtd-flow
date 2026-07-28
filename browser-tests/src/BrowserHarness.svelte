<script lang="ts">
	import type { App, Plugin } from "obsidian";
	import VirtualList from "../../src/views/common/VirtualList.svelte";
	import DayCell from "../../src/views/calendar/DayCell.svelte";
	import { DndService } from "../../src/views/dnd/DndService";
	import type { DragPayload } from "../../src/views/dnd/types";
	import { createDefaultSettings } from "../../src/settings/Settings";
	import type { IntentDispatcher } from "../../src/services/WritebackService";

	type FixtureRow = { id: string; label: string; height: number };

	const initialRows: FixtureRow[] = Array.from({ length: 36 }, (_, index) => ({
		id: `row-${index}`,
		label: `Variable row ${index + 1}`,
		height: 34 + ((index * 29) % 91),
	}));

	let rows = $state<FixtureRow[]>(initialRows);
	const settings = createDefaultSettings();
	const app = {} as App;
	const dispatcher = {
		dispatch: async () => ({ ok: true }),
	} as unknown as IntentDispatcher;
	const dndPlugin = {
		app: { workspace: { on: () => ({}) } },
		registerEvent: () => {},
		register: () => {},
	} as unknown as Plugin;
	(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow = window;
	const dnd = new DndService(dndPlugin);
	const rejectedDropPayload: DragPayload = {
		taskKey: "browser-test:1",
		sourceViewType: "browser-harness",
	};
	let rejectedDropTarget = $state<HTMLElement | null>(null);

	function swapLeadingRows(): void {
		rows = [rows[1]!, rows[0]!, ...rows.slice(2)];
	}

	async function rejectQuickAdd(): Promise<void> {
		throw new Error("test write port unavailable");
	}

	function startRejectedDrop(event: PointerEvent): void {
		if (event.button !== 0) return;
		dnd.startDrag(rejectedDropPayload, event, event.currentTarget as HTMLElement);
	}

	$effect(() => {
		if (rejectedDropTarget === null) return;
		return dnd.registerDropTarget({
			el: rejectedDropTarget,
			accepts: () => true,
			drop: async () => {
				throw new Error("browser drop rejected");
			},
		});
	});
</script>

<main>
	<h1>GTD Flow mounted component gate</h1>

	<section aria-labelledby="virtual-list-heading" data-testid="virtual-list-fixture">
		<h2 id="virtual-list-heading">Virtual list</h2>
		<button type="button" data-testid="swap-leading-rows" onclick={swapLeadingRows}>
			Swap first two rows
		</button>
		<div class="virtual-list-frame">
			<VirtualList
				items={rows}
				itemHeight={56}
				threshold={1}
				overscan={2}
				keyOf={(row) => row.id}
			>
				{#snippet row(item)}
					<article
						class="fixture-row"
						data-row-id={item.id}
						style:height={`${item.height}px`}
					>
						<label>
							{item.label}
							<input
								data-testid={`draft-${item.id}`}
								aria-label={`Draft for ${item.label}`}
							/>
						</label>
					</article>
				{/snippet}
			</VirtualList>
		</div>
	</section>

	<section aria-labelledby="calendar-day-heading" data-testid="calendar-day-fixture">
		<h2 id="calendar-day-heading">Calendar day</h2>
		<div role="grid" aria-label="Calendar fixture">
			<div role="row">
				<DayCell
					date="2026-07-28"
					today="2026-07-28"
					events={[]}
					dnd={null}
					{dispatcher}
					{app}
					{settings}
					onDropTask={async () => {}}
					onQuickAdd={rejectQuickAdd}
				/>
			</div>
		</div>
	</section>

	<section aria-labelledby="dnd-error-heading" data-testid="dnd-error-fixture">
		<h2 id="dnd-error-heading">Drag and drop error boundary</h2>
		<button type="button" data-testid="rejected-drop-source" onpointerdown={startRejectedDrop}>
			Drag rejected task
		</button>
		<div
			class="rejected-drop-target"
			data-testid="rejected-drop-target"
			bind:this={rejectedDropTarget}
		>
			Rejected drop target
		</div>
	</section>
</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		font-family: system-ui, sans-serif;
		color: #1f2937;
		background: #ffffff;
		--background-modifier-border: #cbd5e1;
		--background-secondary-alt: #f1f5f9;
		--background-modifier-hover: #e0f2fe;
		--background-primary: #ffffff;
		--text-faint: #64748b;
		--text-muted: #475569;
		--text-normal: #1f2937;
		--text-on-accent: #ffffff;
		--interactive-accent: #0369a1;
		--font-ui-smaller: 0.875rem;
	}
	main {
		display: grid;
		gap: 2rem;
		max-width: 48rem;
		padding: 1.5rem;
	}
	section {
		border: 1px solid #cbd5e1;
		border-radius: 0.5rem;
		padding: 1rem;
	}
	.virtual-list-frame {
		height: 17.5rem;
		margin-top: 0.75rem;
		border: 1px solid #94a3b8;
	}
	.fixture-row {
		display: grid;
		align-items: center;
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid #e2e8f0;
	}
	.fixture-row label {
		display: grid;
		gap: 0.25rem;
	}
	[data-testid="calendar-day-fixture"] :global(.gtd-cal-cell) {
		min-height: 8rem;
	}
	.rejected-drop-target {
		min-height: 5rem;
		margin-top: 0.75rem;
		padding: 1rem;
		border: 1px dashed #0369a1;
	}
</style>
