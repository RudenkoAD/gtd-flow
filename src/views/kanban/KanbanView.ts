import type { ViewStateResult } from "obsidian";
import type { Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import type GtdFlowPlugin from "../../main";
import type { BoardService } from "../../services/BoardService";
import type { IntentDispatcher } from "../../services/WritebackService";
import type { DndPort } from "../dnd/types";
import { GtdView } from "../GtdView";
import Kanban from "./Kanban.svelte";
import type { KanbanPersistedState } from "./kanbanLogic";

/**
 * Kanban. Компоненту передаётся узкий контекст вместо всего plugin (ТЗ §0);
 * viewState (выбранная доска, свёрнутые колонки) — JSON-сериализуемое (ТЗ §4).
 */
export class KanbanView extends GtdView {
	/** setState приходит ПОСЛЕ onOpen/mount — состояние доносится через store. */
	private readonly persisted: Writable<KanbanPersistedState> = writable({});
	private lastState: KanbanPersistedState = {};

	protected override component(): Component<any> {
		return Kanban as unknown as Component<any>;
	}

	protected override props(): Record<string, unknown> {
		// dnd/boards появляются на плагине при интеграции этапа 4 в main.ts
		const plugin = this.plugin as GtdFlowPlugin & {
			dispatcher: IntentDispatcher;
			dnd?: DndPort;
			boards?: BoardService;
		};
		return {
			taskStore: plugin.taskStore,
			dispatcher: plugin.dispatcher,
			settings: plugin.settings,
			app: plugin.app,
			boards: plugin.boards ?? null,
			dnd: plugin.dnd ?? null,
			persisted: { subscribe: this.persisted.subscribe },
			persist: (s: KanbanPersistedState) => {
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
function sanitizeState(state: unknown): KanbanPersistedState | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
	const s = state as Record<string, unknown>;
	const next: KanbanPersistedState = {};
	if (typeof s["boardPath"] === "string") next.boardPath = s["boardPath"];
	const rawCollapsed = s["collapsed"];
	if (typeof rawCollapsed === "object" && rawCollapsed !== null && !Array.isArray(rawCollapsed)) {
		const collapsed: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(rawCollapsed as Record<string, unknown>)) {
			if (typeof v === "boolean") collapsed[k] = v;
		}
		next.collapsed = collapsed;
	}
	return next;
}
