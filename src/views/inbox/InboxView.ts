import type { Component } from "svelte";
import type GtdFlowPlugin from "../../main";
import type { IntentDispatcher } from "../../services/WritebackService";
import { GtdView } from "../GtdView";
import Inbox from "./Inbox.svelte";

/**
 * Входящие. Компоненту передаётся узкий контекст (store, dispatcher, настройки,
 * app) вместо всего plugin — тестируемость и переносимость по ТЗ §0.
 */
export class InboxView extends GtdView {
	protected override component(): Component<any> {
		return Inbox as unknown as Component<any>;
	}

	protected override props(): Record<string, unknown> {
		// поле dispatcher появляется на плагине при связке этапа 3 в main.ts
		const plugin = this.plugin as GtdFlowPlugin & { dispatcher: IntentDispatcher };
		return {
			taskStore: plugin.taskStore,
			dispatcher: plugin.dispatcher,
			settings: plugin.settings,
			app: plugin.app,
		};
	}
}
