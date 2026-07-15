<script lang="ts">
	import { MarkdownView, Menu, Notice, TFile, type App } from "obsidian";
	import type { Intent } from "../../core/intents/Intent";
	import type { IsoDate, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { DatePromptModal } from "./DatePromptModal";
	import { addDaysIso } from "./dates";
	import {
		PRIORITY_ICONS,
		PRIORITY_LABELS,
		PRIORITY_ORDER,
		dateBadges,
		segmentDescription,
	} from "./cardFormat";

	let {
		task,
		dispatcher,
		app,
		settings,
		today,
		inTickler = false,
	}: {
		task: Task;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		today: IsoDate;
		/** Пункт «Вернуть во входящие» (снять 🛫) — только из вида отложенных. */
		inTickler?: boolean;
	} = $props();

	const isDone = $derived(task.statusChar === "x" || task.statusChar === "X");
	const segments = $derived(segmentDescription(task.description));
	const badges = $derived(dateBadges(task));

	// единая точка write-back: отказ — уведомление, а не тихо съеденный клик
	async function run(intent: Intent): Promise<void> {
		const res = await dispatcher.dispatch(intent);
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	function toggleStatus(): void {
		void run(
			isDone
				? { type: "set-status", key: task.key, statusChar: " " }
				: { type: "set-status", key: task.key, statusChar: "x", date: today },
		);
	}

	function deferTo(until: IsoDate): void {
		void run({ type: "defer", key: task.key, until });
	}

	async function openInFile(): Promise<void> {
		const file = app.vault.getAbstractFileByPath(task.filePath);
		if (!(file instanceof TFile)) {
			new Notice(`GTD Flow: файл не найден: ${task.filePath}`);
			return;
		}
		const leaf = app.workspace.getLeaf(false);
		await leaf.openFile(file);
		// best effort: строка — подсказка на момент парса, а не идентичность
		if (leaf.view instanceof MarkdownView) {
			leaf.view.editor.setCursor({ line: task.lineStart, ch: 0 });
		}
	}

	function openMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setSection("status")
				.setTitle(isDone ? "Открыть заново" : "Выполнено")
				.setIcon(isDone ? "rotate-ccw" : "check")
				.onClick(() => toggleStatus()),
		);
		// setSubmenu нет в публичных типах API — плоские пункты с секциями
		for (const p of PRIORITY_ORDER) {
			menu.addItem((item) =>
				item
					.setSection("priority")
					.setTitle(`Приоритет: ${PRIORITY_LABELS[p]}`)
					.setChecked(task.priority === p)
					.onClick(() => void run({ type: "set-priority", key: task.key, priority: p })),
			);
		}
		for (const preset of settings.deferPresets) {
			menu.addItem((item) =>
				item
					.setSection("defer")
					.setIcon("alarm-clock")
					.setTitle(`Отложить: ${preset.label}`)
					.onClick(() => deferTo(addDaysIso(today, preset.offsetDays))),
			);
		}
		menu.addItem((item) =>
			item
				.setSection("defer")
				.setIcon("calendar")
				.setTitle("Отложить: дата…")
				.onClick(() =>
					new DatePromptModal(app, "Отложить до", deferTo, task.start ?? undefined).open(),
				),
		);
		if (inTickler) {
			menu.addItem((item) =>
				item
					.setSection("defer")
					.setIcon("inbox")
					.setTitle("Вернуть во входящие")
					.onClick(() =>
						void run({ type: "set-date", key: task.key, field: "start", date: null }),
					),
			);
		}
		menu.addItem((item) =>
			item
				.setSection("nav")
				.setIcon("file-text")
				.setTitle("Открыть в файле")
				.onClick(() => void openInFile()),
		);
		menu.showAtMouseEvent(e);
	}
</script>

<div class="gtd-task-card" class:is-done={isDone}>
	<input
		type="checkbox"
		class="gtd-task-check"
		checked={isDone}
		aria-label={isDone ? "Открыть заново" : "Выполнено"}
		onclick={(e) => {
			// состояние чекбокса придёт из индекса после write-back
			e.preventDefault();
			toggleStatus();
		}}
	/>
	<div class="gtd-task-body">
		<div class="gtd-task-desc">
			{#if task.priority !== "none"}
				<span class="gtd-task-prio" title={PRIORITY_LABELS[task.priority]}
					>{PRIORITY_ICONS[task.priority]}</span
				>
			{/if}
			{#each segments as seg}{#if seg.tag}<span class="tag">{seg.text}</span
				>{:else}{seg.text}{/if}{/each}
		</div>
		{#if badges.length > 0}
			<div class="gtd-task-badges">
				{#each badges as b}
					<span class="gtd-task-badge gtd-badge-{b.field}">{b.icon} {b.date}</span>
				{/each}
			</div>
		{/if}
	</div>
	<button class="gtd-task-more" aria-label="Меню задачи" onclick={openMenu}>⋯</button>
</div>

<style>
	.gtd-task-card {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-task-card:hover {
		background: var(--background-secondary);
	}
	.gtd-task-card.is-done .gtd-task-desc {
		color: var(--text-muted);
		text-decoration: line-through;
	}
	.gtd-task-check {
		margin-top: 3px;
		flex: none;
	}
	.gtd-task-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-task-desc {
		overflow-wrap: anywhere;
	}
	.gtd-task-prio {
		margin-right: 4px;
	}
	.gtd-task-desc .tag {
		color: var(--text-accent);
		background: var(--background-secondary-alt);
		border-radius: var(--radius-s, 4px);
		padding: 0 4px;
		font-size: 0.9em;
	}
	.gtd-task-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}
	.gtd-task-badge {
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
	}
	.gtd-task-more {
		flex: none;
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0 6px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-task-more:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
</style>
