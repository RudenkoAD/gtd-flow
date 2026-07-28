<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { derived, get, type Readable } from "svelte/store";
	import type { Task } from "../../core/model/Task";
	import {
		NS_CONVENTION,
		nsCommonTarget,
		type NamespaceDef,
		type NamespaceFilter,
	} from "../../core/namespace/namespace";
	import { defaultInboxConfig } from "../../core/query/querySpec";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { inboxStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import NamespaceSwitcher from "../common/NamespaceSwitcher.svelte";
	import { namespaceLabel } from "../common/namespaceSwitcher";
	import TaskCard from "../common/TaskCard.svelte";
	import {
		captureTargetInNamespace,
		ensureCaptureFileNs,
		nlCaptureHint,
	} from "../common/taskActions";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import VirtualList from "../common/VirtualList.svelte";
	import type { DndPort } from "../dnd/types";
	import { VIEW_TYPES } from "../registry";
	import { filterTasks, inboxCaptureTransform, type InboxWritePort } from "./inboxLogic";

	let {
		taskStore,
		dispatcher,
		settings,
		settingsRevision,
		app,
		dnd = null,
		menuPorts = null,
		vault,
		activeNamespace,
		namespaces: _namespaces,
		setActiveNamespace,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		/** Обновляется после saveSettings; settings мутируются in-place. */
		settingsRevision: Readable<number>;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd?: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Структурный порт записи для быстрого ввода; совместим с VaultAdapter. */
		vault: InboxWritePort;
		/** Реактивное ЛОКАЛЬНОЕ активное пространство вида (per-tab, см. GtdView). */
		activeNamespace: Readable<string>;
		/** Снимок списка пространств (settings.namespaces). */
		namespaces: readonly NamespaceDef[];
		/** Смена ЛОКАЛЬНОГО пространства этого вида (persist в viewState). */
		setActiveNamespace: (name: string) => void;
	} = $props();

	/** Список может быть заменён при миграции настроек, поэтому не держим
	 * монтировочный снимок props.namespaces. */
	const liveNamespaces = $derived.by(() => {
		void $settingsRevision;
		return settings.namespaces;
	});
	// Фильтр пространства для inboxStore: derive из ЛОКАЛЬНОГО пространства вида +
	// список корней. Смена инвалидирует мемо-ключ стора (ось nsKey) и пере-рендерит
	// подпиской — эпоху индекса это не бампает (см. память проекта).
	// svelte-ignore state_referenced_locally
	const namespace$: Readable<NamespaceFilter> = derived(activeNamespace, (a) => ({
		active: a,
		defs: liveNamespaces,
	}));

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	let tasks = $state<Task[]>([]);
	$effect(() => {
		void $settingsRevision;
		const store = inboxStore(
			taskStore,
			() => defaultInboxConfig(settings.inboxIncludePlain),
			settings.debounceMs.queryRecompute,
			namespace$,
			settingsRevision,
		);
		return store.subscribe((value) => (tasks = value));
	});
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	let query = $state("");
	const shown = $derived(filterTasks(tasks, query));
	const filtered = $derived(query.trim() !== "");
	/** Метка активного пространства для пустого состояния — только когда настроено. */
	const nsLabel = $derived(liveNamespaces.length === 0 ? null : namespaceLabel($activeNamespace));

	// --- быстрый ввод новой задачи (append в первый gtd-inbox файл, фолбэк <commonRoot>/Входящие.md) ---
	let newTask = $state("");
	// живая подсказка распознанной даты (NLP): «📅 чт 15 авг · 15:00» или null
	const nlHint = $derived(nlCaptureHint(newTask, $today));

	async function addTask(): Promise<void> {
		const transform = inboxCaptureTransform(newTask, $today);
		if (transform === null) return; // пусто после санитации — молча ничего
		// цель захвата — В ЛОКАЛЬНОМ пространстве вида, В МОМЕНТ ввода: первый файл
		// gtd-inbox этого пространства из живого индекса, иначе конвенционные
		// Входящие.md: <root>/ (именованное) или <commonRoot>/ («Общее»).
		const active = get(activeNamespace);
		const fallback = nsCommonTarget(
			active,
			liveNamespaces,
			NS_CONVENTION.inbox,
			settings.commonRoot,
		);
		const target = captureTargetInNamespace(
			taskStore.index().all(),
			active,
			liveNamespaces,
			fallback,
		);
		if (target === "") {
			new Notice("GTD Flow: не задан файл входящих (пустая «Корневая папка Общего»)");
			return;
		}
		const entered = newTask;
		newTask = ""; // очистка сразу — быстрый ввод серии, фокус остаётся на input
		try {
			// файл входящих создаётся и помечается gtd-inbox: true (+ gtd-namespace для
			// файла-исключения вне корня пространства) СТРОГО до записи строки
			if (!(await ensureCaptureFileNs(vault, target, active, liveNamespaces))) {
				new Notice(
					`GTD Flow: не удалось подготовить файл входящих ${target}\nТекст: ${entered}`,
					0,
				);
				return;
			}
			const ok = await vault.processFile(target, transform);
			// новая задача появится в списке сама после реиндекса
			if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}: ${entered}`);
		} catch (e) {
			// поле уже очищено — возвращаем текст в уведомлении, чтобы ввод не пропал
			new Notice(
				`GTD Flow: не удалось записать в ${target}: ${String(e)}\nТекст: ${entered}`,
				0,
			);
		}
	}

	function onNewTaskKeydown(e: KeyboardEvent): void {
		// Enter в IME подтверждает композицию, а не отправку; keyCode 229 —
		// WebKit/iOS, где на коммит-Enter isComposing уже false (образец в commands.ts)
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === "Enter") {
			e.preventDefault();
			void addTask();
		} else if (e.key === "Escape") {
			// не отдаём Escape наружу — он закрыл бы попап/модал вокруг вида
			e.preventDefault();
			e.stopPropagation();
			newTask = "";
		}
	}
</script>

<div class="gtd-inbox">
	<div class="gtd-inbox-header">
		<span class="gtd-inbox-count" aria-label="Количество задач">
			{filtered ? `${shown.length} / ${tasks.length}` : tasks.length}
		</span>
		<input class="gtd-inbox-filter" type="search" placeholder="Фильтр…" bind:value={query} />
		<NamespaceSwitcher
			active={activeNamespace}
			namespaces={liveNamespaces}
			onSelect={setActiveNamespace}
		/>
	</div>
	<div class="gtd-inbox-new">
		<input
			class="gtd-inbox-new-input"
			type="text"
			placeholder="Новая задача…"
			bind:value={newTask}
			onkeydown={onNewTaskKeydown}
		/>
		{#if nlHint !== null}
			<div class="gtd-nl-hint" aria-label="Распознанная дата">{nlHint}</div>
		{/if}
	</div>
	{#if shown.length === 0}
		<div class="gtd-inbox-empty">
			{filtered ? "Ничего не найдено" : "Входящие пусты"}{nsLabel !== null && !filtered
				? ` · ${nsLabel}`
				: ""}
		</div>
	{:else}
		<VirtualList
			items={shown}
			threshold={settings.virtualizeThreshold}
			keyOf={(task) => task.key}
		>
			{#snippet row(task)}
				<TaskCard
					{task}
					{dispatcher}
					{app}
					{settings}
					today={$today}
					{dnd}
					dragPayload={{ taskKey: task.key, sourceViewType: VIEW_TYPES.inbox }}
					{menuPorts}
				/>
			{/snippet}
		</VirtualList>
	{/if}
</div>

<style>
	.gtd-inbox {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-inbox-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-inbox-count {
		flex: none;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		background: var(--background-secondary);
		border-radius: var(--radius-s, 4px);
		padding: 1px 8px;
	}
	.gtd-inbox-filter {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-inbox-new {
		flex: none;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-inbox-new-input {
		width: 100%;
	}
	.gtd-nl-hint {
		margin-top: 3px;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-inbox-empty {
		padding: 24px 10px;
		text-align: center;
		color: var(--text-muted);
	}
</style>
