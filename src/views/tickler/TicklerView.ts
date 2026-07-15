import type { Component } from "svelte";
import type GtdFlowPlugin from "../../main";
import type { IntentDispatcher } from "../../services/WritebackService";
import type { DndPort } from "../dnd/types";
import { GtdView } from "../GtdView";
import Tickler from "./Tickler.svelte";

/**
 * Отложенные. Компоненту передаётся узкий контекст (store, dispatcher,
 * настройки, app) вместо всего plugin — тестируемость и переносимость по ТЗ §0.
 */
export class TicklerView extends GtdView {
	protected override component(): Component<any> {
		return Tickler as unknown as Component<any>;
	}

	protected override props(): Record<string, unknown> {
		// dispatcher/dnd появляются на плагине при связке этапов 3–4 в main.ts
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
		};
	}
}
