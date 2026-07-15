import type { ViewStateResult } from "obsidian";
import type { Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import type GtdFlowPlugin from "../../main";
import type { IntentDispatcher } from "../../services/WritebackService";
import { taskMenuPortsFromPlugin } from "../common/taskMenu";
import type { DndPort } from "../dnd/types";
import { GtdView } from "../GtdView";
import Calendar from "./Calendar.svelte";
import { sanitizeCalendarState, type CalendarPersistedState } from "./calendarLogic";

/**
 * Календарь. Компоненту передаётся узкий контекст вместо всего plugin (ТЗ §0);
 * viewState (режим, якорная дата) — JSON-сериализуемое (ТЗ §4).
 */
export class CalendarView extends GtdView {
	/** setState приходит ПОСЛЕ onOpen/mount — состояние доносится через store. */
	private readonly persisted: Writable<CalendarPersistedState> = writable({});
	private lastState: CalendarPersistedState = {};

	protected override component(): Component<any> {
		return Calendar as unknown as Component<any>;
	}

	protected override props(): Record<string, unknown> {
		// dnd появляется на плагине при интеграции этапа 4 в main.ts
		const plugin = this.plugin as GtdFlowPlugin & {
			dispatcher: IntentDispatcher;
			dnd?: DndPort;
		};
		return {
			taskStore: plugin.taskStore,
			dispatcher: plugin.dispatcher,
			settings: plugin.settings,
			app: plugin.app,
			dnd: plugin.dnd ?? null,
			menuPorts: taskMenuPortsFromPlugin(plugin),
			// структурный порт CalendarWritePort — совместим с VaultAdapter
			vault: plugin.vaultAdapter,
			persisted: { subscribe: this.persisted.subscribe },
			persist: (s: CalendarPersistedState) => {
				this.lastState = s;
				this.app.workspace.requestSaveLayout();
			},
		};
	}

	override getState(): Record<string, unknown> {
		return { ...this.lastState };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = sanitizeCalendarState(state);
		if (next !== null) {
			this.lastState = next;
			this.persisted.set(next);
		}
		await super.setState(state, result);
	}
}
