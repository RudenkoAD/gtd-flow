<script lang="ts">
	import { Handle, Position } from "@xyflow/svelte";
	import type { NodeState } from "../../core/projects/graphEngine";
	import type { Task } from "../../core/model/Task";
	import {
		PRIORITY_ICONS,
		PRIORITY_LABELS,
		dateBadges,
		displaySegments,
		renderWikiLinks,
	} from "../common/cardFormat";
	import { stateColorClass } from "./projectGraphLogic";

	/** data узла собирается в ProjectGraph: VM + подсветка + колбэки. */
	interface TaskNodeData {
		task: Task;
		state: NodeState;
		ghost: boolean;
		critical: boolean;
		toggle: () => void;
		/** Прогресс чеклиста карточки {done,total} или null — тогда бейджа нет. */
		progress: { done: number; total: number } | null;
		/** Открыть карточку задачи (порт cards); у призрака — no-op (read-only). */
		openCard: () => void;
	}

	// Svelte Flow передаёт кастомному узлу все NodeProps; нам нужны data и selected
	let { data, selected = false }: { data: TaskNodeData; selected?: boolean } = $props();

	const task = $derived(data.task);
	const isDone = $derived(data.state === "done");
	const isCancelled = $derived(data.state === "cancelled");
	const badges = $derived(dateBadges(task));
	// вики-ссылки → плоский текст (ссылка на свою карточку скрыта), затем
	// сегментация #тегов без структурных тегов колонок доски — как на доске
	const segments = $derived(displaySegments(renderWikiLinks(task.description, task.taskId)));

	/** Иконка состояния (ТЗ §7): blocked — замок, deferred — часы, waiting — ожидание. */
	const stateIcon = $derived.by(() => {
		switch (data.state) {
			case "blocked":
				return "🔒";
			case "deferred":
				return "🕓";
			case "waiting":
				return "⏳";
			case "doing":
				return "▶";
			default:
				return "";
		}
	});
</script>

<div
	class="gtd-tnode {stateColorClass(data.state)}"
	class:is-ghost={data.ghost}
	class:is-critical={data.critical}
	class:is-selected={selected}
	title={data.ghost ? `Внешняя зависимость: ${task.filePath}` : undefined}
>
	<Handle type="target" position={Position.Left} isConnectable={!data.ghost} />
	<div class="gtd-tnode-row">
		<input
			type="checkbox"
			class="gtd-tnode-check nodrag"
			checked={isDone}
			disabled={data.ghost}
			aria-label={isDone ? "Открыть заново" : "Выполнено"}
			onclick={(e) => {
				// состояние придёт из индекса после write-back
				e.preventDefault();
				e.stopPropagation();
				if (!data.ghost) data.toggle();
			}}
		/>
		<div class="gtd-tnode-body">
			<div class="gtd-tnode-desc" class:is-struck={isDone || isCancelled}>
				{#if task.priority !== "none"}
					<span title={PRIORITY_LABELS[task.priority]}>{PRIORITY_ICONS[task.priority]}</span>
				{/if}
				{#each segments as seg}{#if seg.tag}<span class="tag">{seg.text}</span
					>{:else}{seg.text}{/if}{/each}
			</div>
			{#if badges.length > 0}
				<div class="gtd-tnode-badges">
					{#each badges as b (b.field)}
						<span class="gtd-tnode-badge">{b.icon} {b.date}</span>
					{/each}
				</div>
			{/if}
		</div>
		{#if stateIcon !== ""}
			<span class="gtd-tnode-state-icon">{stateIcon}</span>
		{/if}
		{#if data.progress !== null}
			<!-- nodrag: интерактивный элемент внутри узла Svelte Flow не должен начинать drag -->
			<button
				class="gtd-tnode-progress nodrag"
				title="Открыть карточку"
				aria-label="Чеклист карточки: {data.progress.done} из {data.progress.total}"
				onclick={(e) => {
					e.stopPropagation();
					data.openCard();
				}}
			>
				{data.progress.done}/{data.progress.total}
			</button>
		{/if}
	</div>
	<Handle type="source" position={Position.Right} isConnectable={!data.ghost} />
</div>

<style>
	.gtd-tnode {
		width: 240px;
		box-sizing: border-box;
		padding: 8px 10px;
		border-radius: var(--radius-m, 8px);
		background: var(--background-primary);
		border: 2px solid var(--background-modifier-border);
		font-size: var(--font-ui-small, 0.9em);
		color: var(--text-normal);
	}
	.gtd-tnode.is-selected {
		box-shadow: 0 0 0 2px var(--background-modifier-border-focus, var(--interactive-accent));
	}
	/* цвета рамки по состоянию (ТЗ §7) */
	.gtd-tnode.gtd-node-ready {
		border-color: var(--interactive-accent);
	}
	.gtd-tnode.gtd-node-blocked {
		border-color: var(--background-modifier-border);
		opacity: 0.85;
	}
	.gtd-tnode.gtd-node-done {
		border-color: var(--color-green, #4caf50);
	}
	.gtd-tnode.gtd-node-cancelled {
		border-color: var(--background-modifier-border);
		opacity: 0.65;
	}
	.gtd-tnode.gtd-node-deferred {
		border-color: var(--color-blue, #2196f3);
	}
	.gtd-tnode.gtd-node-waiting {
		border-color: var(--color-yellow, #e5b567);
	}
	.gtd-tnode.gtd-node-doing {
		border-color: var(--color-purple, #9c27b0);
	}
	/* призрак: read-only узел чужого файла — пунктир */
	.gtd-tnode.is-ghost {
		border-style: dashed;
		background: var(--background-secondary);
		opacity: 0.8;
	}
	/* критический путь */
	.gtd-tnode.is-critical {
		box-shadow: 0 0 0 3px var(--color-orange, #e5892a);
	}
	.gtd-tnode-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.gtd-tnode-check {
		margin-top: 2px;
		flex: none;
	}
	.gtd-tnode-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-tnode-desc {
		overflow-wrap: anywhere;
	}
	.gtd-tnode-desc.is-struck {
		color: var(--text-muted);
		text-decoration: line-through;
	}
	.gtd-tnode-desc .tag {
		color: var(--text-accent);
		background: var(--background-secondary-alt);
		border-radius: var(--radius-s, 4px);
		padding: 0 4px;
		font-size: 0.9em;
	}
	.gtd-tnode-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}
	.gtd-tnode-badge {
		font-size: var(--font-ui-smaller, 0.8em);
		color: var(--text-muted);
	}
	.gtd-tnode-state-icon {
		flex: none;
		font-size: 0.95em;
	}
	/* бейдж прогресса карточки n/m — компактнее доски (узел 240px) */
	.gtd-tnode-progress {
		flex: none;
		border: none;
		box-shadow: none;
		background: var(--background-secondary-alt);
		color: var(--text-muted);
		cursor: pointer;
		padding: 0 5px;
		border-radius: var(--radius-s, 4px);
		font-size: var(--font-ui-smaller, 0.8em);
		font-variant-numeric: tabular-nums;
	}
	.gtd-tnode-progress:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
</style>
