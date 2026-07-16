<script lang="ts">
	import { get, type Readable } from "svelte/store";
	import type { NamespaceDef } from "../../core/namespace/namespace";
	import { namespaceOptions } from "./namespaceSwitcher";

	/**
	 * Компактный ГЛОБАЛЬНЫЙ переключатель активного пространства GTD в шапке вида.
	 * Одно активное пространство на всё приложение: выбор зовёт plugin.setActiveNamespace
	 * (нормализует, персистит, толкает activeNamespace$), а виды пере-рендерятся своей
	 * подпиской на этот же store. Виден ТОЛЬКО когда настроено ≥1 пространство (иначе UI
	 * прежний — обратная совместимость).
	 */
	let {
		active,
		namespaces,
		setActive,
		onSelect,
		title = "Активное пространство GTD",
	}: {
		/** Реактивный источник активного пространства (plugin.activeNamespace$). */
		active: Readable<string>;
		/** Снимок списка пространств (settings.namespaces). Пусто ⇒ ничего не рендерим. */
		namespaces: readonly NamespaceDef[];
		/** Смена активного пространства (plugin.setActiveNamespace). Синоним onSelect:
		 *  часть видов зовёт проп setActive, часть — onSelect; поддерживаем оба, чтобы
		 *  не трогать чужую зону (виды). Хотя бы один обязан быть задан. */
		setActive?: (name: string) => void;
		/** Синоним setActive (историческое имя пропа в части видов). */
		onSelect?: (name: string) => void;
		title?: string;
	} = $props();

	// зеркало активного пространства для <select bind:value>; sel синхронизируется
	// из store (смена через палитру/другой вид отражается тут), а onchange толкает
	// выбор обратно в store — второй проход эффекта совпадает по значению, без петли
	// svelte-ignore state_referenced_locally
	let sel = $state<string>(get(active));
	$effect(() =>
		active.subscribe((v) => {
			if (v !== sel) sel = v;
		}),
	);

	function onChange(): void {
		(setActive ?? onSelect)?.(sel);
	}

	// «Общее» (sentinel DEFAULT_NS) + именованные; подпись «Общего» — единый
	// источник в namespaceSwitcher.ts (общий с пикером/командой палитры).
	const options = $derived(namespaceOptions(namespaces));
</script>

{#if namespaces.length > 0}
	<select
		class="gtd-ns-switcher dropdown"
		aria-label={title}
		{title}
		bind:value={sel}
		onchange={onChange}
	>
		<!-- sentinel DEFAULT_NS отображается как «Общее» (само значение скрыто от глаз) -->
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
