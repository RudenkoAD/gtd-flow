<script lang="ts">
	import { Menu } from "obsidian";
	import { get, type Readable } from "svelte/store";
	import type { NamespaceDef } from "../../core/namespace/namespace";
	import { namespaceOptions } from "./namespaceSwitcher";

	/**
	 * Компактный переключатель активного пространства GTD в шапке вида. С итерации 2
	 * фидбека — ПОФАЙЛОВЫЙ (per-view): выбор зовёт ЛОКАЛЬНЫЙ сеттер вида (свой store +
	 * персист в viewState), а не глобальный. Виден ТОЛЬКО когда настроено ≥1
	 * пространство (иначе UI прежний — обратная совместимость).
	 *
	 * НЕ нативный <select>, а кнопка с Menu Obsidian (фикс фидбека «через UI всё ещё
	 * невозможно переключиться»): trusted change нативного попапа Electron гуляюще
	 * терялся на стыке с делегированием событий Svelte (диагностика: value коммитился
	 * и тут же отскакивал, хендлер не вызывался; синтетический bubbled change при этом
	 * работал). Меню Obsidian свободно от нативного попапа и в этом приложении
	 * срабатывает безотказно (все живые проверки).
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

	// зеркало активного пространства — только для ПОДПИСИ кнопки; смена через
	// палитру/другой вид отражается тут же
	// svelte-ignore state_referenced_locally
	let sel = $state<string>(get(active));
	$effect(() =>
		active.subscribe((v) => {
			if (v !== sel) sel = v;
		}),
	);

	// «Общее» (sentinel DEFAULT_NS) + именованные [+ «Все» при allowAll]; подписи —
	// единый источник в namespaceSwitcher.ts (общий с пикером/командой палитры).
	const options = $derived(namespaceOptions(namespaces, allowAll));
	const label = $derived(options.find((o) => o.value === sel)?.label ?? sel);

	function openMenu(ev: MouseEvent): void {
		const menu = new Menu();
		for (const opt of options) {
			menu.addItem((mi) =>
				mi
					.setTitle(opt.label)
					.setChecked(opt.value === sel)
					.onClick(() => (setActive ?? onSelect)?.(opt.value)),
			);
		}
		menu.showAtMouseEvent(ev);
	}
</script>

{#if namespaces.length > 0}
	<button class="gtd-ns-switcher" aria-label={title} {title} onclick={openMenu}>
		{label}
		<span class="gtd-ns-caret">▾</span>
	</button>
{/if}

<style>
	.gtd-ns-switcher {
		flex: none;
		min-width: 0;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--font-ui-smaller, 0.85em);
		height: auto;
		padding: 2px 8px;
	}
	.gtd-ns-caret {
		opacity: 0.7;
		margin-left: 2px;
	}
</style>
