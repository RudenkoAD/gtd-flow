import type { ViewStateResult } from "obsidian";
import type { Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import type GtdFlowPlugin from "../../main";
import type { IntentDispatcher } from "../../services/WritebackService";
import { taskMenuPortsFromPlugin } from "../common/taskMenu";
import { GtdView } from "../GtdView";
import Project from "./Project.svelte";
import type { ProjectPersistedState } from "./projectGraphLogic";
import type { ProjectPort } from "../../services/ProjectService";

/**
 * Вид проекта (граф DAG на Svelte Flow, ТЗ §7). Компоненту передаётся узкий
 * контекст вместо всего plugin (ТЗ §0); viewState {projectPath} —
 * JSON-сериализуемое (ТЗ §4). Паттерн — KanbanView.
 */
export class ProjectView extends GtdView {
	/** setState приходит ПОСЛЕ onOpen/mount — состояние доносится через store. */
	private readonly persisted: Writable<ProjectPersistedState> = writable({});
	private lastState: ProjectPersistedState = {};

	protected override component(): Component<any> {
		return Project as unknown as Component<any>;
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
			menuPorts: taskMenuPortsFromPlugin(plugin),
			persisted: { subscribe: this.persisted.subscribe },
			persist: (s: ProjectPersistedState) => {
				this.lastState = s;
				this.app.workspace.requestSaveLayout();
			},
		};
	}

	override getState(): Record<string, unknown> {
		return { ...this.lastState };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = sanitizeState(state);
		if (next !== null) {
			this.lastState = next;
			this.persisted.set(next);
		}
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
