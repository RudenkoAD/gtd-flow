<script lang="ts">
	import type { CalendarMode } from "./calendarLogic";

	let {
		title,
		mode,
		overdueCount = 0,
		onPrev,
		onToday,
		onNext,
		onMode,
	}: {
		title: string;
		mode: CalendarMode;
		overdueCount?: number;
		onPrev: () => void;
		onToday: () => void;
		onNext: () => void;
		onMode: (mode: CalendarMode) => void;
	} = $props();

	const MODE_ORDER: readonly { id: CalendarMode; label: string }[] = [
		{ id: "month", label: "Месяц" },
		{ id: "week", label: "Неделя" },
		{ id: "agenda", label: "Агенда" },
		{ id: "3days", label: "3 дня" },
		{ id: "day", label: "День" },
	];
</script>

<div class="gtd-cal-toolbar">
	<div class="gtd-cal-header">
		<div class="gtd-cal-nav">
			<button aria-label="Назад" onclick={onPrev}>‹</button>
			<button onclick={onToday}>Сегодня</button>
			<button aria-label="Вперёд" onclick={onNext}>›</button>
		</div>
		<span class="gtd-cal-title" {title}>{title}</span>
		{#if overdueCount > 0}
			<button
				class="gtd-cal-overdue"
				title="Просроченных задач: {overdueCount} — показать в агенде"
				aria-label="Просроченных задач: {overdueCount}; показать в агенде"
				onclick={() => onMode("agenda")}
			>
				⚠ {overdueCount}
			</button>
		{/if}
		<div class="gtd-cal-modes" aria-label="Режим календаря">
			{#each MODE_ORDER as item (item.id)}
				<button
					class:is-active={mode === item.id}
					aria-pressed={mode === item.id}
					onclick={() => onMode(item.id)}
				>
					{item.label}
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.gtd-cal-toolbar {
		flex: none;
		container-type: inline-size;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-cal-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
	}
	.gtd-cal-nav {
		display: flex;
		gap: 2px;
	}
	.gtd-cal-nav button,
	.gtd-cal-modes button,
	.gtd-cal-overdue {
		min-height: 36px;
	}
	.gtd-cal-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.gtd-cal-overdue {
		flex: none;
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-warning, var(--text-muted));
		cursor: pointer;
		padding: 1px 8px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-cal-overdue:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-cal-modes {
		flex: none;
		display: flex;
		gap: 2px;
	}
	.gtd-cal-modes button.is-active {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}

	@container (max-width: 42rem) {
		.gtd-cal-header {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 6px;
			padding: 6px 8px 8px;
		}
		.gtd-cal-nav button,
		.gtd-cal-modes button,
		.gtd-cal-overdue {
			min-height: 44px;
		}
		.gtd-cal-title {
			text-align: center;
		}
		.gtd-cal-modes {
			grid-column: 1 / -1;
			display: grid;
			grid-template-columns: repeat(5, minmax(0, 1fr));
			min-width: 0;
		}
		.gtd-cal-modes button {
			min-width: 0;
			padding-inline: 3px;
			font-size: var(--font-ui-smaller, 0.85em);
			white-space: normal;
		}
	}

	@container (max-width: 24rem) {
		.gtd-cal-header {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.gtd-cal-nav {
			grid-column: 1 / -1;
			display: grid;
			grid-template-columns: 44px minmax(0, 1fr) 44px;
		}
	}
</style>
