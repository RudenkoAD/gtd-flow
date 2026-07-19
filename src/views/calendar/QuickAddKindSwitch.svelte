<script lang="ts">
	// Канон союза QuickAddKind — в настройках (там же его хранит lastQuickAddKind).
	import type { QuickAddKind } from "../../settings/Settings";

	let {
		kind,
		onChange,
	}: {
		/** Текущий выбор (липкий, из настроек через родителя). */
		kind: QuickAddKind;
		/** Клик по сегменту — родитель сохраняет выбор (persist в настройки). */
		onChange: (kind: QuickAddKind) => void;
	} = $props();

	const SEGMENTS: readonly { id: QuickAddKind; label: string }[] = [
		{ id: "task", label: "Задача" },
		{ id: "event", label: "Событие" },
	];

	// mousedown с preventDefault: клик по сегменту НЕ уводит фокус из соседнего
	// поля ввода (у которого onblur=cancel) — фокус остаётся в поле, и следующий
	// Enter сразу отправляет с выбранным типом. Именно mousedown (не pointerdown):
	// для мыши отмена pointerdown в Chromium НЕ подавляет фокус, mousedown —
	// подавляет. Сам выбор — на click (preventDefault на mousedown его не отменяет).
	// Клавиатура работает штатно (Tab на кнопку, Space/Enter — активация): blur-guard
	// поля по relatedTarget оставляет ввод живым, пока фокус в пределах обёртки.
	function keepFocus(e: MouseEvent): void {
		e.preventDefault();
	}
</script>

<div class="gtd-qa-kind" role="group" aria-label="Тип записи">
	{#each SEGMENTS as seg (seg.id)}
		<button
			type="button"
			class:is-active={kind === seg.id}
			aria-pressed={kind === seg.id}
			onmousedown={keepFocus}
			onclick={() => onChange(seg.id)}>{seg.label}</button
		>
	{/each}
</div>

<style>
	.gtd-qa-kind {
		display: inline-flex;
		flex: none;
		gap: 0;
	}
	.gtd-qa-kind button {
		padding: 0 6px;
		font-size: var(--font-ui-smaller, 0.8em);
		line-height: 1.4;
		height: auto;
		box-shadow: none;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-muted);
		cursor: pointer;
	}
	/* схлопнуть внутреннюю границу сегментов в одну линию, скруглить только края */
	.gtd-qa-kind button:first-child {
		border-radius: var(--radius-s, 4px) 0 0 var(--radius-s, 4px);
	}
	.gtd-qa-kind button:last-child {
		border-radius: 0 var(--radius-s, 4px) var(--radius-s, 4px) 0;
		margin-left: -1px;
	}
	.gtd-qa-kind button:hover {
		color: var(--text-normal);
	}
	.gtd-qa-kind button.is-active {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		border-color: var(--interactive-accent);
		z-index: 1;
	}
</style>
