<script lang="ts">
	import { onMount } from "svelte";
	import type { App, Plugin } from "obsidian";
	import VirtualList from "../../src/views/common/VirtualList.svelte";
	import DayCell from "../../src/views/calendar/DayCell.svelte";
	import AI from "../../src/views/ai/AI.svelte";
	import { DndService } from "../../src/views/dnd/DndService";
	import type { DragPayload } from "../../src/views/dnd/types";
	import { createDefaultSettings } from "../../src/settings/Settings";
	import type { IntentDispatcher } from "../../src/services/WritebackService";
	import { createBrowserAiFixture } from "./aiBrowserFixture";

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
	const ai = createBrowserAiFixture();
	let aiRevision = $state(0);
	let aiViewRevision = $state(0);
	let aiStarted = $state(false);
	const aiState = $derived.by(() => {
		void aiRevision;
		return ai.snapshot();
	});

	onMount(() => {
		const unsubscribe = ai.subscribe(() => aiRevision++);
		void ai.start().then(() => {
			aiStarted = true;
		});
		return unsubscribe;
	});

	async function processAiInbox(): Promise<void> {
		await ai.processInbox();
		aiRevision++;
		aiViewRevision++;
	}

	async function correctAiDuration(): Promise<void> {
		await ai.correctDuration();
		aiRevision++;
		// Manual ownership changes invalidate pending AI follow-ups as well as
		// the writeback snapshot, so remount the visible AI state for this gate.
		aiViewRevision++;
	}

	async function rateLimitAi(): Promise<void> {
		await ai.rateLimit();
		aiRevision++;
		aiViewRevision++;
	}

	async function retryAi(): Promise<void> {
		await ai.retry();
		aiRevision++;
		aiViewRevision++;
	}

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

<div class="browser-harness">
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

	<section aria-labelledby="ai-heading" data-testid="ai-fixture">
		<h2 id="ai-heading">Embedded AI</h2>
		<div class="ai-runtime-controls" aria-label="Integrated inbox processing">
			<button type="button" onclick={processAiInbox} disabled={!aiStarted}>
				Process inbox with AI
			</button>
			<button type="button" onclick={correctAiDuration} disabled={aiState.duration === null}>
				Correct duration to 120 minutes
			</button>
			<button type="button" onclick={rateLimitAi} disabled={!aiStarted}>
				Trigger rate-limited run
			</button>
			<button type="button" onclick={retryAi} disabled={!aiStarted}>
				Retry rate-limited run
			</button>
			<p role="status" data-testid="ai-runtime-status">{aiState.status}</p>
			<dl class="ai-runtime-task" aria-label="Atomic task writeback">
				<div>
					<dt>Duration</dt>
					<dd>{aiState.duration ?? "unprocessed"}</dd>
				</div>
				<div>
					<dt>Cognitive</dt>
					<dd>{aiState.cognitive ?? "unprocessed"}</dd>
				</div>
				<div>
					<dt>Emotional</dt>
					<dd>{aiState.emotional ?? "unprocessed"}</dd>
				</div>
				<div>
					<dt>Physical</dt>
					<dd>{aiState.physical ?? "unprocessed"}</dd>
				</div>
				<div>
					<dt>Scope</dt>
					<dd>{aiState.scope ?? "unprocessed"}</dd>
				</div>
				<div>
					<dt>Last runtime fields</dt>
					<dd>{aiState.lastFields ?? "none"}</dd>
				</div>
				<div>
					<dt>Created tasks</dt>
					<dd>{aiState.createdTasks}</dd>
				</div>
				<div>
					<dt>Task deleted</dt>
					<dd>{aiState.deleted ? "yes" : "no"}</dd>
				</div>
			</dl>
		</div>
		<div class="ai-frame">
			{#if aiStarted}
				{#key aiViewRevision}
					<AI port={ai.port} />
				{/key}
			{:else}
				<p>Starting integrated AI runtime…</p>
			{/if}
		</div>
	</section>
</div>

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
	.browser-harness {
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
		overflow: hidden;
	}
	.virtual-list-frame :global(.gtd-vlist) {
		height: 100%;
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
	.ai-frame {
		min-height: 40rem;
		border: 1px solid #94a3b8;
	}
</style>
