<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { derived, type Readable } from "svelte/store";
	import { type NamespaceDef, type NamespaceFilter } from "../../core/namespace/namespace";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { ticklerStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { confirm } from "../common/ConfirmModal";
	import NamespaceSwitcher from "../common/NamespaceSwitcher.svelte";
	import { namespaceLabel } from "../common/namespaceSwitcher";
	import { pickDate } from "../common/pickers";
	import TaskCard from "../common/TaskCard.svelte";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { BUCKET_ORDER, bucketDeferDate, bucketize, type BucketId } from "./buckets";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
		dnd = null,
		menuPorts = null,
		activeNamespace,
		namespaces,
		setActiveNamespace,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd?: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Реактивное активное пространство (plugin.activeNamespace$). */
		activeNamespace: Readable<string>;
		/** Снимок списка пространств (settings.namespaces). */
		namespaces: readonly NamespaceDef[];
		/** Глобальная смена активного пространства (plugin.setActiveNamespace). */
		setActiveNamespace: (name: string) => void;
	} = $props();

	// Фильтр пространства для ticklerStore: смена активного инвалидирует мемо стора
	// и пере-рендерит подпиской (эпоху индекса не бампает, см. память проекта).
	// svelte-ignore state_referenced_locally
	const namespace$: Readable<NamespaceFilter> = derived(activeNamespace, (a) => ({
		active: a,
		defs: namespaces,
	}));

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const tasks = ticklerStore(taskStore, settings.debounceMs.queryRecompute, namespace$);
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	const buckets = $derived(bucketize($tasks, $today, settings.firstDayOfWeek));
	/** Метка активного пространства для шапки — только когда настроено. */
	const nsLabel = $derived(namespaces.length === 0 ? null : namespaceLabel($activeNamespace));

	let collapsed = $state<Record<BucketId, boolean>>({
		tomorrow: false,
		thisWeek: false,
		later: false,
	});

	let sectionEls = $state<Record<BucketId, HTMLElement | null>>({
		tomorrow: null,
		thisWeek: null,
		later: null,
	});

	// Секция-бакет = drop-цель (ТЗ §8): drop открывает пикер даты, предзаполненный
	// датой бакета (bucketDeferDate) — карточка не «исчезает» молча, а пользователь
	// видит/правит дату откладывания и получает Notice. $today читается в
	// drop-замыкании — актуальна на момент жеста, а не регистрации.
	$effect(() => {
		if (dnd === null) return;
		const unregs: (() => void)[] = [];
		for (const bucket of BUCKET_ORDER) {
			const el = sectionEls[bucket.id];
			if (el === null) continue;
			unregs.push(
				dnd.registerDropTarget({
					el,
					accepts: (p) => p.taskKey !== "",
					drop: async (p) => {
						// Пикер предзаполнен датой бакета; отмена (null) — карточка
						// остаётся где была, ничего не пишем.
						const suggested = bucketDeferDate(bucket.id, $today, settings.firstDayOfWeek);
						const until = await pickDate(app, "Отложить до", suggested);
						if (until === null) return;
						// «🛫 и 📅 взаимоисключающие»: отложить запланированную —
						// только сняв план, с подтверждением (атомарная запись).
						const task = taskStore.index().get(p.taskKey);
						let clearDue = false;
						if (task !== undefined && task.due !== null) {
							const ok = await confirm(
								app,
								"Снять с плана?",
								`Задача запланирована на ${task.due}. Отложенная задача не может ` +
									`оставаться в плане: отложить до ${until} и снять с плана?`,
								"Отложить и снять план",
							);
							if (!ok) return;
							clearDue = true;
						}
						const res = await dispatcher.dispatch({
							type: "defer",
							key: p.taskKey,
							until,
							clearDue,
						});
						// Всегда явный отклик на успех: карточка уходит из исходного
						// вида (или не меняется видимо, если 🛫 уже был на эту дату) —
						// без Notice это читается как «карточка просто исчезла».
						if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
						else new Notice(clearDue ? `Отложена до ${until}, план снят` : `Отложена до ${until}`);
					},
				}),
			);
		}
		return () => {
			for (const unreg of unregs) unreg();
		};
	});
</script>

<div class="gtd-tickler">
	<!-- Шапка со сменой пространства видна только когда пространства настроены. -->
	{#if nsLabel !== null}
		<div class="gtd-tickler-header">
			<span class="gtd-tickler-title">Отложенные · {nsLabel}</span>
			<NamespaceSwitcher active={activeNamespace} {namespaces} onSelect={setActiveNamespace} />
		</div>
	{/if}
	<div class="gtd-tickler-body">
	<!-- Бакеты видны и при пустом тикле: пустая секция — всё ещё drop-цель. -->
	{#each BUCKET_ORDER as bucket (bucket.id)}
		{@const list = buckets[bucket.id]}
		<section class="gtd-bucket" bind:this={sectionEls[bucket.id]}>
			<button
				class="gtd-bucket-header"
				aria-expanded={!collapsed[bucket.id]}
				onclick={() => (collapsed[bucket.id] = !collapsed[bucket.id])}
			>
				<span class="gtd-bucket-chevron" class:is-collapsed={collapsed[bucket.id]}>▸</span>
				<span class="gtd-bucket-title">{bucket.title}</span>
				<span class="gtd-bucket-count">{list.length}</span>
			</button>
			{#if !collapsed[bucket.id]}
				{#each list as task (task.key)}
					<TaskCard
						{task}
						{dispatcher}
						{app}
						{settings}
						today={$today}
						inTickler={true}
						{dnd}
						dragPayload={{ taskKey: task.key, sourceViewType: VIEW_TYPES.tickler }}
						{menuPorts}
					/>
				{:else}
					<div class="gtd-bucket-empty">Пусто</div>
				{/each}
			{/if}
		</section>
	{/each}
	</div>
</div>

<style>
	.gtd-tickler {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-tickler-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-tickler-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.gtd-tickler-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
	.gtd-bucket-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		border: none;
		box-shadow: none;
		background: var(--background-secondary);
		color: var(--text-normal);
		cursor: pointer;
		padding: 5px 10px;
		font-weight: 600;
		text-align: left;
	}
	.gtd-bucket-header:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-bucket-chevron {
		display: inline-block;
		transform: rotate(90deg);
		transition: transform 0.12s ease;
		color: var(--text-muted);
	}
	.gtd-bucket-chevron.is-collapsed {
		transform: rotate(0deg);
	}
	.gtd-bucket-title {
		flex: 1 1 auto;
	}
	.gtd-bucket-count {
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-bucket-empty {
		padding: 8px 10px 12px 26px;
		color: var(--text-faint);
		font-size: var(--font-ui-smaller, 0.85em);
	}
</style>
