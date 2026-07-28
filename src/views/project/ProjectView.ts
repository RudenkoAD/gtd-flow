import type { ViewStateResult } from "obsidian";
import type { Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import type GtdFlowPlugin from "../../main";
import type { IntentDispatcher } from "../../services/WritebackService";
import { reportAsync } from "../common/runAction";
import { taskMenuPortsFromPlugin } from "../common/taskMenu";
import { GtdView } from "../GtdView";
import { VIEW_META } from "../registry";
import Project from "./Project.svelte";
import type { ProjectPersistedState } from "./projectGraphLogic";
import type { ProjectPort } from "../../services/ProjectService";

/**
 * Вид проекта (граф DAG на Svelte Flow, ТЗ §7). Компоненту передаётся узкий
 * контекст вместо всего plugin (ТЗ §0); viewState {projectPath} —
 * JSON-сериализуемое (ТЗ §4). Паттерн — KanbanView.
 */
export class ProjectView extends GtdView {
	// getViewType() вызывается конструктором View до присвоения this.meta (см. GtdView).
	protected static override staticMeta = VIEW_META.project;

	/** setState приходит ПОСЛЕ onOpen/mount — состояние доносится через store. */
	private readonly persisted: Writable<ProjectPersistedState> = writable({});
	private lastState: ProjectPersistedState = {};

	protected override component(): Component<Record<string, unknown>> {
		return Project as unknown as Component<Record<string, unknown>>;
	}

	protected override props(): Record<string, unknown> {
		// projects появляется на плагине при интеграции этапа 7 в main.ts (агент сервиса)
		const plugin = this.plugin as GtdFlowPlugin & {
			dispatcher: IntentDispatcher;
			projects?: ProjectPort;
		};
		return {
			taskStore: plugin.taskStore,
			dispatcher: plugin.dispatcher,
			app: plugin.app,
			projects: plugin.projects ?? null,
			settings: plugin.settings,
			settingsRevision: plugin.settingsRevision.store,
			// ЛОКАЛЬНОЕ пространство вида (per-tab): реактивный источник, список
			// определений и локальный сеттер — для NamespaceSwitcher в шапке, фильтра
			// discovery проектов и ns-цели нового проекта. Смена активного эпоху
			// индекса не бампает — вид пере-рендерится подпиской на localNamespace$.
			activeNamespace$: { subscribe: this.localNamespace$.subscribe },
			namespaces: plugin.settings.namespaces,
			setActiveNamespace: (name: string) => this.setLocalNamespace(name),
			menuPorts: taskMenuPortsFromPlugin(plugin),
			// Выход из графа проекта в обзор «Проекты» (симметрично openProject там).
			openOverview: () =>
				reportAsync("открытие обзора проектов", () => plugin.activateView("projects")),
			persisted: { subscribe: this.persisted.subscribe },
			persist: (s: ProjectPersistedState) => {
				this.lastState = s;
				this.app.workspace.requestSaveLayout();
			},
		};
	}

	override getState(): Record<string, unknown> {
		// nsName (базовый) + выбранный проект в один JSON-объект viewState
		return { ...this.namespaceState(), ...this.lastState };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = sanitizeState(state);
		if (next !== null) {
			this.lastState = next;
			this.persisted.set(next);
		}
		// базовый setState восстанавливает nsName и зовёт ItemView.setState
		await super.setState(state, result);
	}
}

/** Раскладка могла прийти чужая/битая (setViewState зовут и другие плагины). */
function sanitizeState(state: unknown): ProjectPersistedState | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
	const s = state as Record<string, unknown>;
	const next: ProjectPersistedState = {};
	if (typeof s["projectPath"] === "string") next.projectPath = s["projectPath"];
	return next;
}
