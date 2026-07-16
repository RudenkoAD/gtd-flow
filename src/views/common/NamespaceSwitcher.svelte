<script lang="ts">
	import { get, type Readable } from "svelte/store";
	import type { NamespaceDef } from "../../core/namespace/namespace";
	import { namespaceOptions } from "./namespaceSwitcher";

	/**
	 * Компактный переключатель активного пространства GTD в шапке вида. С итерации 2
	 * фидбека — ПОФАЙЛОВЫЙ (per-view): выбор зовёт ЛОКАЛЬНЫЙ сеттер вида (свой store +
	 * персист в viewState), а не глобальный. Виден ТОЛЬКО когда настроено ≥1
	 * пространство (иначе UI прежний — обратная совместимость).
	 */
	let {
		active,
		namespaces,
		setActive,
		onSelect,
		allowAll = false,
		title = "Пространство GTD этого вида",
	}: {
		/** Реактивный источник ЛОКАЛЬНОГО активного пространства вида. */
		active: Readable<string>;
		/** Снимок списка пространств (settings.namespaces). Пусто ⇒ ничего не рендерим. */
		namespaces: readonly NamespaceDef[];
		/** Смена локального пространства вида. Синоним onSelect: часть видов зовёт проп
		 *  setActive, часть — onSelect; поддерживаем оба, чтобы не плодить лишний рефактор.
		 *  Хотя бы один обязан быть задан. */
		setActive?: (name: string) => void;
		/** Синоним setActive (историческое имя пропа в части видов). */
		onSelect?: (name: string) => void;
		/** Добавить опцию «Все» (агрегат всех пространств) — только календарь. */
		allowAll?: boolean;
		title?: string;
	} = $props();

	// зеркало активного пространства для <select bind:value>; sel синхронизируется
	// из store (смена через палитру/другой вид отражается тут). ВАЖНО (фикс фидбека):
	// onchange берёт значение ИЗ СОБЫТИЯ (e.currentTarget.value), НЕ из sel —
	// порядок svelte-слушателей делал бы чтение sel устаревшим, и переключение из UI
	// не срабатывало у реального пользователя.
	// svelte-ignore state_referenced_locally
	let sel = $state<string>(get(active));
	$effect(() =>
		active.subscribe((v) => {
			if (v !== sel) sel = v;
		}),
	);

	function onChange(value: string): void {
		(setActive ?? onSelect)?.(value);
	}

	// «Общее» (sentinel DEFAULT_NS) + именованные [+ «Все» при allowAll]; подписи —
	// единый источник в namespaceSwitcher.ts (общий с пикером/командой палитры).
	const options = $derived(namespaceOptions(namespaces, allowAll));
</script>

{#if namespaces.length > 0}
	<select
		class="gtd-ns-switcher dropdown"
		aria-label={title}
		{title}
		bind:value={sel}
		onchange={(e) => onChange(e.currentTarget.value)}
	>
		<!-- sentinel'ы DEFAULT_NS/ALL_NS отображаются как «Общее»/«Все» (значения скрыты) -->
		{#each options as opt (opt.value)}
			<option value={opt.value}>{opt.label}</option>
		{/each}
	</select>
{/if}

<style>
	.gtd-ns-switcher {
		flex: none;
		min-width: 0;
		max-width: 40%;
		font-size: var(--font-ui-smaller, 0.85em);
		height: auto;
		padding: 2px 20px 2px 6px;
	}
</style>
