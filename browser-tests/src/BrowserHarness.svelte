<script lang="ts">
	import { onMount } from "svelte";
	import { readable } from "svelte/store";
	import { Platform, type App, type Plugin } from "obsidian";
	import VirtualList from "../../src/views/common/VirtualList.svelte";
	import DayCell from "../../src/views/calendar/DayCell.svelte";
	import CalendarToolbar from "../../src/views/calendar/CalendarToolbar.svelte";
	import AI from "../../src/views/ai/AI.svelte";
	import TaskCard from "../../src/views/common/TaskCard.svelte";
	import Recurring from "../../src/views/recurring/Recurring.svelte";
	import Inbox from "../../src/views/inbox/Inbox.svelte";
	import Column from "../../src/views/kanban/Column.svelte";
	import type { BoardDef } from "../../src/core/board/boardFile";
	import type { BoardService } from "../../src/services/BoardService";
	import { DndService } from "../../src/views/dnd/DndService";
	import type { DndPort, DragPayload } from "../../src/views/dnd/types";
	import { createDefaultSettings } from "../../src/settings/Settings";
	import type { IntentDispatcher } from "../../src/services/WritebackService";
	import { emptyTaskProvenance } from "../../src/core/estimates/provenance";
	import { makeTask } from "../../src/stores/testSupport";
	import type { TaskMetadataPort, TaskMenuPorts } from "../../src/views/common/taskMenu";
	import type { BoardWritePort, ColumnVM } from "../../src/views/kanban/kanbanLogic";
	import { createBrowserAiFixture } from "./aiBrowserFixture";
	import { TaskIndex } from "../../src/core/index/TaskIndex";
	import type { TaskStore } from "../../src/stores/taskStore";
	import type { CalendarMode } from "../../src/views/calendar/calendarLogic";
	import type { TemplateVaultPort } from "../../src/views/recurring/recurringLogic";

	type FixtureRow = { id: string; label: string; height: number };

	const initialRows: FixtureRow[] = Array.from({ length: 36 }, (_, index) => ({
		id: `row-${index}`,
		label: `Variable row ${index + 1}`,
		height: 34 + ((index * 29) % 91),
	}));

	let rows = $state<FixtureRow[]>(initialRows);
	const settings = createDefaultSettings();
	Platform.isMobileApp = navigator.maxTouchPoints > 0;
	Platform.isPhone = Platform.isMobileApp && matchMedia("(max-width: 600px)").matches;
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
	const detailsTask = makeTask({
		key: "id:browser-task-1",
		taskId: "browser-task-1",
		filePath: "GTD/Inbox.md",
		description: "Browser details task",
		due: "2026-08-03",
		priority: "medium",
		location: "Desk",
		durationMinutes: 90,
		cognitiveIntensity: 3,
		emotionalIntensity: 2,
		physicalIntensity: 0,
		scopeId: "work",
	});
	const detailsCatalog = {
		schemaVersion: 1 as const,
		scopes: [
			{ id: "work", name: "Work", order: 0, archived: false },
			{ id: "life", name: "Life", order: 1, archived: false },
		],
	};
	let detailsUpdateCalls = $state(0);
	let detailsLastUpdate = $state("none");
	type DetailsSaveResult = { ok: true } | { ok: false; reason: string };
	type DetailsSaveMode = "success" | "pending-scope-failure" | "feedback-warning";
	const DETAILS_SAVE_RESOLVE_EVENT = "gtd-browser-resolve-task-details-save";
	let detailsSaveMode: DetailsSaveMode = $state("success");
	const detailsMetadata: TaskMetadataPort = {
		scopes: () => detailsCatalog,
		scopeName: (scopeId) =>
			detailsCatalog.scopes.find((scope) => scope.id === scopeId)?.name ?? null,
		durationLongStyle: () => "whole-days",
		provenanceForTask: async (taskId) =>
			emptyTaskProvenance(taskId, "2026-08-02T00:00:00.000Z"),
		applyManualPatch: async () => ({ ok: true }),
		applyManualUpdate: async (_task, ordinaryIntents, metadataPatch) => {
			detailsUpdateCalls++;
			detailsLastUpdate = JSON.stringify({
				ordinaryTypes: ordinaryIntents.map((intent) => intent.type),
				metadataPatch,
			});
			if (detailsSaveMode === "feedback-warning") {
				detailsSaveMode = "success";
				return { ok: false, reason: "metadata-saved-but-feedback-write-failed" };
			}
			if (detailsSaveMode === "pending-scope-failure") {
				return new Promise<DetailsSaveResult>((resolve) => {
					window.addEventListener(
						DETAILS_SAVE_RESOLVE_EVENT,
						() => resolve({ ok: false, reason: "scope-not-active" }),
						{ once: true },
					);
				});
			}
			return { ok: true };
		},
	};
	const detailsMenuPorts: TaskMenuPorts = {
		metadata: detailsMetadata,
		cards: {
			cardPathOf: () => "GTD/Cards/browser-task-1.md",
			progressOf: () => ({ done: 1, total: 2 }),
			openOrCreate: async () => ({ ok: true, path: "GTD/Cards/browser-task-1.md" }),
		},
	};
	let mobileCalendarMode = $state<CalendarMode>("day");
	const recurringIndex = new TaskIndex();
	recurringIndex.replaceFile("GTD/Recurring.md", [
		makeTask({
			filePath: "GTD/Recurring.md",
			taskId: "browser-recurring-1",
			container: "recurring",
			description: "A deliberately long recurring task that must wrap on a phone",
			recurrence: "every 2 weeks on mon, thu",
			nextSpawn: "2026-08-03",
		}),
	]);
	const recurringTaskStore: TaskStore = {
		epoch: readable(recurringIndex.epoch),
		today: readable("2026-08-02"),
		index: () => recurringIndex,
		dispose: () => {},
	};
	const recurringSettingsRevision = readable(0);
	const recurringVault: TemplateVaultPort = {
		ensureFile: async () => {},
		processFile: async () => true,
		processFrontmatter: async () => {},
	};

	function resolvePendingDetailsSave(): void {
		detailsSaveMode = "success";
		window.dispatchEvent(new Event(DETAILS_SAVE_RESOLVE_EVENT));
	}
	const detailsColumn: ColumnVM = {
		id: "doing",
		name: "Doing",
		match: "#kanban/browser/doing",
		count: 1,
		tasks: [detailsTask],
	};
	const detailsBoardDef: BoardDef = {
		id: "browser",
		name: "Browser board",
		groupBy: "tag",
		columns: [{ id: "doing", name: "Doing", match: "#kanban/browser/doing" }],
		skippedColumns: [],
		order: { doing: ["browser-task-1"] },
	};
	const detailsBoards = {
		moveCard: async () => ({ ok: true }),
		moveCardFromTickler: async () => ({ ok: true }),
		renameColumn: async () => ({ ok: true }),
		moveColumn: async () => ({ ok: true }),
		deleteColumn: async () => ({ ok: true }),
	} as unknown as BoardService;
	const detailsBoardVault: BoardWritePort = {
		ensureFile: async () => {},
		processFile: async () => true,
	};
	let detailsColumnDragStarts = $state(0);
	const detailsColumnDnd: DndPort = {
		registerDropTarget: () => () => {},
		startDrag: () => {
			detailsColumnDragStarts++;
		},
	};
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

	<section
		aria-labelledby="mobile-calendar-toolbar-heading"
		data-testid="mobile-calendar-toolbar-fixture"
	>
		<h2 id="mobile-calendar-toolbar-heading">Narrow calendar toolbar</h2>
		<div class="mobile-narrow-frame">
			<CalendarToolbar
				title="Воскресенье, 2 августа 2026"
				mode={mobileCalendarMode}
				overdueCount={2}
				onPrev={() => {}}
				onToday={() => {}}
				onNext={() => {}}
				onMode={(mode) => (mobileCalendarMode = mode)}
			/>
		</div>
		<output data-testid="mobile-calendar-mode">{mobileCalendarMode}</output>
	</section>

	<section aria-labelledby="mobile-recurring-heading" data-testid="mobile-recurring-fixture">
		<h2 id="mobile-recurring-heading">Narrow recurring view</h2>
		<div class="mobile-narrow-frame">
			<Recurring
				taskStore={recurringTaskStore}
				{dispatcher}
				{settings}
				settingsRevision={recurringSettingsRevision}
				{app}
				recurrence={null}
				cards={null}
				vault={recurringVault}
			/>
		</div>
	</section>

	<section aria-labelledby="mobile-inbox-heading" data-testid="mobile-inbox-fixture">
		<h2 id="mobile-inbox-heading">Narrow inbox view</h2>
		<div class="mobile-narrow-frame mobile-inbox-frame">
			<Inbox
				taskStore={recurringTaskStore}
				{dispatcher}
				{settings}
				settingsRevision={recurringSettingsRevision}
				{app}
				dnd={null}
				menuPorts={null}
				vault={recurringVault}
			/>
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

	<section aria-labelledby="task-details-heading" data-testid="task-details-fixture">
		<h2 id="task-details-heading">Task details modal</h2>
		<TaskCard
			task={detailsTask}
			{dispatcher}
			{app}
			{settings}
			today="2026-08-02"
			{dnd}
			dragPayload={{ taskKey: detailsTask.key, sourceViewType: "browser-harness" }}
			menuPorts={detailsMenuPorts}
		/>
		<p>
			Apply calls:
			<output aria-label="Task details apply calls" data-testid="task-details-apply-count"
				>{detailsUpdateCalls}</output
			>
		</p>
		<pre
			aria-label="Last task details update"
			data-testid="task-details-last-update">{detailsLastUpdate}</pre>
		<button
			type="button"
			data-testid="task-details-pending-mode"
			onclick={() => (detailsSaveMode = "pending-scope-failure")}
		>
			Use pending scope failure
		</button>
		<button
			type="button"
			data-testid="task-details-resolve-pending"
			onclick={resolvePendingDetailsSave}
		>
			Resolve pending details save
		</button>
		<button
			type="button"
			data-testid="task-details-feedback-warning-mode"
			onclick={() => (detailsSaveMode = "feedback-warning")}
		>
			Use feedback finalization warning
		</button>
	</section>

	<section
		aria-labelledby="kanban-popout-control-heading"
		data-testid="kanban-popout-control-fixture"
	>
		<h2 id="kanban-popout-control-heading">Kanban pop-out controls</h2>
		<Column
			column={detailsColumn}
			boardPath="GTD/Browser board.md"
			def={detailsBoardDef}
			boards={detailsBoards}
			dnd={detailsColumnDnd}
			{dispatcher}
			{app}
			{settings}
			vault={detailsBoardVault}
			today="2026-08-02"
			menuPorts={detailsMenuPorts}
		/>
		<output aria-label="Kanban drag starts" data-testid="kanban-drag-start-count"
			>{detailsColumnDragStarts}</output
		>
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
	.mobile-narrow-frame {
		width: min(100%, 22rem);
		min-width: 0;
		border: 1px solid #94a3b8;
		overflow: hidden;
	}
	.mobile-inbox-frame {
		height: 12rem;
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
