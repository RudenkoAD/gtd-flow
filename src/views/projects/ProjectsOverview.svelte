<script lang="ts">
	import { Notice } from "obsidian";
	import type { ProjectStatus } from "../../core/model/Task";
	import type { ProjectPort } from "../../services/ProjectService";
	import type { TaskStore } from "../../stores/taskStore";
	import { buildProjectRows, type ProjectRow } from "./projectsOverviewLogic";

	let {
		taskStore,
		projects = null,
		openProject,
	}: {
		taskStore: TaskStore;
		/** null до интеграции сервиса проектов в main.ts (plugin.projects). */
		projects?: ProjectPort | null;
		/** Открыть граф проекта по пути (навигация живёт в ProjectsOverviewView). */
		openProject: (path: string) => void;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf)
	// svelte-ignore state_referenced_locally
	const epoch = taskStore.epoch;

	const STATUS_LABELS: Record<ProjectStatus, string> = {
		active: "активен",
		"on-hold": "на паузе",
		done: "завершён",
		archived: "в архиве",
	};
	const STATUS_ORDER: ProjectStatus[] = ["active", "on-hold", "done", "archived"];

	// проекты живут в индексе — пересканируем на каждую его смену
	const rows = $derived.by<ProjectRow[]>(() => {
		void $epoch;
		if (projects === null) return [];
		return buildProjectRows(projects.discoverProjects(), (path) =>
			taskStore.index().fileTasks(path),
		);
	});

	function onStatusChange(e: Event, row: ProjectRow): void {
		const port = projects;
		if (port === null) return;
		const value = (e.currentTarget as HTMLSelectElement).value as ProjectStatus;
		if (value === row.status) return;
		void (async () => {
			try {
				await port.setProjectStatus(row.path, value);
			} catch (err) {
				new Notice(`GTD Flow: статус не сохранён: ${String(err)}`);
			}
		})();
	}

	function activate(row: ProjectRow): void {
		openProject(row.path);
	}
</script>

<div class="gtd-po">
	<div class="gtd-po-header">Проекты</div>

	{#if projects === null}
		<div class="gtd-po-empty">Вид проектов не подключён (сервис недоступен)</div>
	{:else if rows.length === 0}
		<div class="gtd-po-empty">
			Проектов не найдено. Создайте заметку с frontmatter <code>gtd-project: true</code>
			и задачами-строками — зависимости задаются полем ⛔.
		</div>
	{:else}
		{#each rows as row (row.path)}
			<!-- клик/Enter по строке открывает граф; селектор статуса гасит всплытие -->
			<div
				class="gtd-po-row gtd-po-status-{row.status}"
				role="button"
				tabindex="0"
				onclick={() => activate(row)}
				onkeydown={(e) => {
					if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						activate(row);
					}
				}}
			>
				<div class="gtd-po-main">
					<div class="gtd-po-name">{row.name}</div>
					<div class="gtd-po-progress">
						<div class="gtd-po-bar">
							<div class="gtd-po-fill" style:width="{row.pct}%"></div>
						</div>
						<span class="gtd-po-count">{row.done}/{row.total}</span>
					</div>
					{#if row.complete || row.stalled}
						<div class="gtd-po-badges">
							{#if row.complete}
								<span
									class="gtd-po-badge is-complete"
									title="Все задачи выполнены/отменены — завершите проект явно"
								>
									✓ всё выполнено
								</span>
							{/if}
							{#if row.stalled}
								<span
									class="gtd-po-badge is-stalled"
									title="Есть невыполненные задачи, но ни одной готовой или в работе"
								>
									💤 стагнация
								</span>
							{/if}
						</div>
					{/if}
				</div>
				<select
					class="dropdown gtd-po-status-select"
					aria-label="Статус проекта «{row.name}»"
					value={row.status}
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => e.stopPropagation()}
					onchange={(e) => onStatusChange(e, row)}
				>
					{#each STATUS_ORDER as st}
						<option value={st}>{STATUS_LABELS[st]}</option>
					{/each}
				</select>
			</div>
		{/each}
	{/if}
</div>

<style>
	.gtd-po {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
	.gtd-po-header {
		padding: 8px 10px;
		font-weight: 600;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-po-empty {
		padding: 24px 12px;
		text-align: center;
		color: var(--text-muted);
	}
	.gtd-po-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
		border-left: 3px solid transparent;
		cursor: pointer;
	}
	.gtd-po-row:hover {
		background: var(--background-secondary);
	}
	.gtd-po-row:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: -2px;
	}
	.gtd-po-status-active {
		border-left-color: var(--interactive-accent);
	}
	.gtd-po-status-done {
		border-left-color: var(--color-green, #4caf50);
	}
	.gtd-po-status-archived,
	.gtd-po-status-on-hold {
		border-left-color: var(--background-modifier-border);
	}
	/* завершённые/архивные приглушаем — фокус на активной работе */
	.gtd-po-status-done .gtd-po-name,
	.gtd-po-status-archived .gtd-po-name {
		color: var(--text-muted);
	}
	.gtd-po-main {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-po-name {
		overflow-wrap: anywhere;
		font-weight: 500;
	}
	.gtd-po-progress {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
	}
	.gtd-po-bar {
		flex: 1 1 auto;
		height: 6px;
		border-radius: var(--radius-s, 4px);
		background: var(--background-modifier-border);
		overflow: hidden;
	}
	.gtd-po-fill {
		height: 100%;
		background: var(--interactive-accent);
		transition: width 120ms ease-out;
	}
	.gtd-po-count {
		flex: none;
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.gtd-po-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 4px;
	}
	.gtd-po-badge {
		font-size: var(--font-ui-smaller, 0.85em);
		border-radius: var(--radius-s, 4px);
		padding: 1px 6px;
		background: var(--background-secondary);
	}
	.gtd-po-badge.is-complete {
		color: var(--color-green, #4caf50);
	}
	.gtd-po-badge.is-stalled {
		color: var(--text-warning, var(--text-muted));
	}
	.gtd-po-status-select {
		flex: none;
		max-width: 40%;
	}
</style>
