import type { Component } from "svelte";
import type GtdFlowPlugin from "../../main";
import type { ProjectPort } from "../../services/ProjectService";
import { GtdView } from "../GtdView";
import { VIEW_META, VIEW_TYPES } from "../registry";
import ProjectsOverview from "./ProjectsOverview.svelte";

/**
 * Обзор проектов (ТЗ фидбек §7): список проектов со статусом и прогрессом,
 * клик по строке открывает граф проекта. Компоненту передаётся узкий контекст
 * вместо всего plugin (ТЗ §0). Паттерн props — RecurringView.
 */
export class ProjectsOverviewView extends GtdView {
	// getViewType() вызывается конструктором View до присвоения this.meta (см. GtdView) —
	// без staticMeta вид падает на Obsidian ≥1.12.
	protected static override staticMeta = VIEW_META.projects;

	protected override component(): Component<any> {
		return ProjectsOverview as unknown as Component<any>;
	}

	protected override props(): Record<string, unknown> {
		const plugin = this.plugin as GtdFlowPlugin & { projects?: ProjectPort };
		return {
			taskStore: plugin.taskStore,
			projects: plugin.projects ?? null,
			app: plugin.app,
			// Пространства (namespaces): реактивный источник активного, список
			// определений и сеттер — для NamespaceSwitcher в шапке и ns-цели нового
			// проекта. Смена активного не бампает эпоху индекса — вид пере-рендерится
			// подпиской на activeNamespace$ (см. память проекта), как на epoch.
			activeNamespace$: plugin.activeNamespace$,
			namespaces: plugin.settings.namespaces,
			setActiveNamespace: (name: string) => plugin.setActiveNamespace(name),
			openProject: (projectPath: string) => void this.openProjectGraph(projectPath),
		};
	}

	/**
	 * Открыть граф выбранного проекта. plugin.activateView("project") открыл бы вид
	 * БЕЗ projectPath — поэтому переиспользуем существующий leaf вида проекта
	 * (setViewState с state {projectPath}) либо заводим новую вкладку с тем же
	 * состоянием. ProjectView.setState донесёт projectPath до графа.
	 */
	private async openProjectGraph(projectPath: string): Promise<void> {
		const { workspace } = this.app;
		const type = VIEW_TYPES.project;
		const leaf = workspace.getLeavesOfType(type)[0] ?? workspace.getLeaf("tab");
		await leaf.setViewState({ type, active: true, state: { projectPath } });
		await workspace.revealLeaf(leaf);
	}
}
