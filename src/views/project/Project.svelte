<script lang="ts">
	import { Menu, Notice, Platform, type App } from "obsidian";
	import type { Readable } from "svelte/store";
	import { SvelteFlowProvider } from "@xyflow/svelte";
	import type { ProjectStatus, Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import type { TaskStore } from "../../stores/taskStore";
	import { openTaskInFile } from "../common/openTask";
	import { displayText } from "../common/cardFormat";
	import { buildTaskMenu, type TaskMenuPorts } from "../common/taskMenu";
	import ProjectGraph from "./ProjectGraph.svelte";
	import type { ProjectPort } from "../../services/ProjectService";
	// Общий переключатель пространств из views/common (создаётся параллельной зоной;
	// гейт-фаза срастит реальный компонент). Контракт props — см. использование ниже.
	import NamespaceSwitcher from "../common/NamespaceSwitcher.svelte";
	import { namespaceLabel } from "../common/namespaceSwitcher";
	import {
		NS_CONVENTION,
		nsTargetPath,
		type NamespaceDef,
	} from "../../core/namespace/namespace";
	import { NamePromptModal } from "../projects/NamePromptModal";
	import { newProjectPath, projectDir } from "../projects/projectsOverviewLogic";
	import {
		depthList,
		pickProjectPath,
		sortProjectSummaries,
		stateColorClass,
		type ProjectPersistedState,
	} from "./projectGraphLogic";

	let {
		taskStore,
		dispatcher,
		app,
		projects,
		settings,
		activeNamespace$,
		namespaces,
		setActiveNamespace,
		menuPorts = null,
		persisted,
		persist,
		openOverview = null,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		app: App;
		/** null до интеграции сервиса проектов в main.ts (plugin.projects). */
		projects: ProjectPort | null;
		settings: GtdFlowSettings;
		/** Реактивный источник активного пространства (plugin.activeNamespace$). */
		activeNamespace$: Readable<string>;
		/** Определения пространств (settings.namespaces); пусто ⇒ switcher скрыт. */
		namespaces: readonly NamespaceDef[];
		/** Переключатель активного пространства (plugin.setActiveNamespace). */
		setActiveNamespace: (name: string) => void;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Состояние из workspace-раскладки; приходит ПОСЛЕ монтирования. */
		persisted: Readable<ProjectPersistedState>;
		persist: (s: ProjectPersistedState) => void;
		/** Открыть вид «Проекты» (обзор). null — когда кнопка выхода не нужна. */
		openOverview?: (() => void) | null;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf)
	// svelte-ignore state_referenced_locally
	const epoch = taskStore.epoch;
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;
	// Активное пространство — как epoch: снимок стора; подписка ($activeNs) пере-запускает
	// discovery на переключение (смена активного эпоху НЕ бампает).
	// svelte-ignore state_referenced_locally
	const activeNs = activeNamespace$;
	// switcher виден только при настроенных пространствах; метка активного для
	// пустых состояний (DEFAULT_NS → «Общее»).
	const hasNamespaces = $derived(namespaces.length >= 1);
	const activeLabel = $derived(namespaceLabel($activeNs));

	// ТЗ §7: на телефоне Svelte Flow не монтируется вообще — read-only список
	const isPhone = Platform.isPhone;

	let selectedPath = $state<string | null>(null);

	// восстановление из viewState (setState приходит после onOpen — поэтому store)
	$effect(() =>
		persisted.subscribe((s) => {
			if (s.projectPath !== undefined) selectedPath = s.projectPath;
		}),
	);

	const summaries = $derived.by(() => {
		void $epoch; // проекты живут в индексе — пересканируем на каждую его смену
		void $activeNs; // и на смену активного: discoverProjects фильтрует по пространству
		return projects === null ? [] : sortProjectSummaries(projects.discoverProjects());
	});
	const shownPath = $derived(pickProjectPath(summaries, selectedPath));
	const shown = $derived(summaries.find((s) => s.path === shownPath) ?? null);

	const STATUS_LABELS: Record<ProjectStatus, string> = {
		active: "активен",
		"on-hold": "на паузе",
		done: "завершён",
		archived: "в архиве",
	};
	const STATUS_ORDER: ProjectStatus[] = ["active", "on-hold", "done", "archived"];

	function onSelectProject(e: Event): void {
		selectedPath = (e.currentTarget as HTMLSelectElement).value;
		persist({ ...(selectedPath !== null ? { projectPath: selectedPath } : {}) });
	}

	/** «＋ Создать проект» из пустого состояния: имя → скаффолд → выбрать новый
	 *  путь (граф появится, как только discovery увидит файл по флагу — на epoch). */
	function createProject(): void {
		const port = projects;
		if (port === null) return;
		new NamePromptModal(app, "Новый проект", "Создать", (name) => {
			const existing = summaries.map((s) => s.path);
			// Каталог нового проекта — активного пространства: <root>/Проекты для
			// именованного, иначе (Общее / без пространств) — рядом с существующими.
			const dir = nsTargetPath(
				$activeNs,
				namespaces,
				NS_CONVENTION.projectsDir,
				projectDir(existing),
			);
			const path = newProjectPath(
				existing,
				name,
				(p) => app.vault.getFileByPath(p) !== null,
				dir,
			);
			if (path === null) {
				new Notice("GTD Flow: недопустимое имя проекта");
				return;
			}
			void (async () => {
				try {
					const res = await port.createProject(path, name);
					if (!res.ok) {
						new Notice(`GTD Flow: проект не создан: ${res.reason ?? "ошибка"}`);
						return;
					}
					selectedPath = res.path ?? path;
					persist({ projectPath: selectedPath });
				} catch (err) {
					new Notice(`GTD Flow: проект не создан: ${String(err)}`);
				}
			})();
		}).open();
	}

	function openStatusMenu(e: MouseEvent): void {
		if (projects === null || shownPath === null || shown === null) return;
		const menu = new Menu();
		for (const status of STATUS_ORDER) {
			menu.addItem((item) =>
				item
					.setTitle(STATUS_LABELS[status])
					.setChecked(shown.status === status)
					.onClick(() => {
						if (shown.status !== status) void projects.setProjectStatus(shownPath, status);
					}),
			);
		}
		menu.showAtMouseEvent(e);
	}

	// --- мобильный fallback: список по глубине, set-status тапом ---

	const mobileGroups = $derived.by(() => {
		if (!isPhone || projects === null || shownPath === null) return [];
		void $epoch;
		const model = projects.model(shownPath);
		return model === null ? [] : depthList(model);
	});

	async function toggleStatus(task: Task): Promise<void> {
		const isDone = task.statusChar === "x" || task.statusChar === "X";
		const res = await dispatcher.dispatch(
			isDone
				? { type: "set-status", key: task.key, statusChar: " " }
				: { type: "set-status", key: task.key, statusChar: "x", date: $today },
		);
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	/** Паритет без drag на телефоне (ТЗ §8): общее меню задачи из списка. */
	function openItemMenu(e: MouseEvent, task: Task): void {
		buildTaskMenu({ task, app, dispatcher, settings, today: $today, ports: menuPorts })
			.showAtMouseEvent(e);
	}
</script>

<div class="gtd-project">
	<div class="gtd-project-header">
		{#if openOverview !== null}
			<button
				class="gtd-project-overview"
				onclick={openOverview}
				title="К списку проектов"
				aria-label="К списку проектов"
			>
				↑
			</button>
		{/if}
		{#if hasNamespaces}
			<!-- Глобальный переключатель пространства; виден только при настроенных пространствах -->
			<NamespaceSwitcher active={activeNamespace$} {namespaces} setActive={setActiveNamespace} />
		{/if}
		<select
			class="dropdown gtd-project-select"
			aria-label="Проект"
			disabled={summaries.length === 0}
			value={shownPath ?? ""}
			onchange={onSelectProject}
		>
			{#each summaries as s (s.path)}
				<option value={s.path}>
					{s.name}{s.status !== "active" ? ` · ${STATUS_LABELS[s.status]}` : ""}
				</option>
			{/each}
		</select>
		{#if shown !== null}
			<button class="gtd-project-status" onclick={openStatusMenu} title="Статус проекта">
				{STATUS_LABELS[shown.status]} ▾
			</button>
			{#if shown.complete}
				<span
					class="gtd-project-badge is-complete"
					title="Все задачи выполнены/отменены — завершите проект явно"
				>
					✓ всё выполнено
				</span>
			{/if}
			{#if shown.stalled}
				<span
					class="gtd-project-badge is-stalled"
					title="Есть невыполненные задачи, но ни одной готовой или в работе"
				>
					💤 стагнация
				</span>
			{/if}
		{/if}
	</div>

	{#if projects === null}
		<div class="gtd-project-empty">Вид проектов не подключён (сервис недоступен)</div>
	{:else if shownPath === null}
		<div class="gtd-project-empty">
			<p>{hasNamespaces ? `В пространстве «${activeLabel}» проектов нет.` : "Проектов не найдено."}</p>
			<button class="mod-cta" onclick={createProject}>＋ Создать проект</button>
		</div>
	{:else if isPhone}
		<!-- read-only список по глубине зависимостей; рисование рёбер — только десктоп -->
		<div class="gtd-project-mlist">
			{#each mobileGroups as group (group.depth)}
				<div class="gtd-project-mgroup">
					<div class="gtd-project-mdepth">Уровень {group.depth}</div>
					{#each group.nodes as n (n.task.key)}
						<div class="gtd-project-mitem {stateColorClass(n.state)}" class:is-ghost={n.ghost}>
							<input
								type="checkbox"
								checked={n.state === "done"}
								disabled={n.ghost}
								aria-label="Выполнено"
								onclick={(e) => {
									e.preventDefault();
									if (!n.ghost) void toggleStatus(n.task);
								}}
							/>
							<button
								class="gtd-project-mdesc"
								class:is-struck={n.state === "done" || n.state === "cancelled"}
								onclick={() => void openTaskInFile(app, n.task)}
							>
								{displayText(n.task)}
							</button>
							<span class="gtd-project-mstate">{n.state}</span>
							{#if !n.ghost}
								<button
									class="gtd-project-mmore"
									aria-label="Меню задачи"
									onclick={(e) => openItemMenu(e, n.task)}
								>
									⋯
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{:else}
		{#key shownPath}
			<SvelteFlowProvider>
				<ProjectGraph path={shownPath} port={projects} {dispatcher} {taskStore} {app} {menuPorts} />
			</SvelteFlowProvider>
		{/key}
	{/if}
</div>

<style>
	.gtd-project {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-project-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-project-overview {
		flex: none;
		font-size: var(--font-ui-smaller, 0.85em);
		padding: 2px 8px;
		line-height: 1;
	}
	.gtd-project-select {
		max-width: 50%;
	}
	.gtd-project-status {
		font-size: var(--font-ui-smaller, 0.85em);
		padding: 2px 8px;
	}
	.gtd-project-badge {
		font-size: var(--font-ui-smaller, 0.85em);
		border-radius: var(--radius-s, 4px);
		padding: 1px 6px;
	}
	.gtd-project-badge.is-complete {
		color: var(--color-green, #4caf50);
		background: var(--background-secondary);
	}
	.gtd-project-badge.is-stalled {
		color: var(--text-warning, var(--text-muted));
		background: var(--background-secondary);
	}
	.gtd-project-empty {
		padding: 24px 12px;
		text-align: center;
		color: var(--text-muted);
	}
	.gtd-project-empty p {
		margin: 0 0 12px;
	}
	/* мобильный список */
	.gtd-project-mlist {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 8px 10px;
	}
	.gtd-project-mdepth {
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
		margin: 10px 0 4px;
	}
	.gtd-project-mitem {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-left: 3px solid var(--background-modifier-border);
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-project-mitem.gtd-node-ready {
		border-left-color: var(--interactive-accent);
	}
	.gtd-project-mitem.gtd-node-done {
		border-left-color: var(--color-green, #4caf50);
	}
	.gtd-project-mitem.gtd-node-deferred {
		border-left-color: var(--color-blue, #2196f3);
	}
	.gtd-project-mitem.gtd-node-waiting {
		border-left-color: var(--color-yellow, #e5b567);
	}
	.gtd-project-mitem.gtd-node-doing {
		border-left-color: var(--color-purple, #9c27b0);
	}
	.gtd-project-mitem.is-ghost {
		opacity: 0.7;
	}
	.gtd-project-mdesc {
		flex: 1 1 auto;
		text-align: left;
		background: transparent;
		border: none;
		box-shadow: none;
		padding: 0;
		color: var(--text-normal);
		cursor: pointer;
		overflow-wrap: anywhere;
	}
	.gtd-project-mdesc.is-struck {
		color: var(--text-muted);
		text-decoration: line-through;
	}
	.gtd-project-mstate {
		flex: none;
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
	}
	.gtd-project-mmore {
		flex: none;
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0 6px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-project-mmore:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
</style>
