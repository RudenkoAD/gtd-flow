import type { Component } from "svelte";
import type GtdFlowPlugin from "../../main";
import type { IntentDispatcher } from "../../services/WritebackService";
import { taskMenuPortsFromPlugin } from "../common/taskMenu";
import type { DndPort } from "../dnd/types";
import { GtdView } from "../GtdView";
import { VIEW_META } from "../registry";
import Inbox from "./Inbox.svelte";

/**
 * Входящие. Компоненту передаётся узкий контекст (store, dispatcher, настройки,
 * app) вместо всего plugin — тестируемость и переносимость по ТЗ §0.
 */
export class InboxView extends GtdView {
	// getViewType() вызывается конструктором View до присвоения this.meta (см. GtdView).
	protected static override staticMeta = VIEW_META.inbox;

	protected override component(): Component<Record<string, unknown>> {
		return Inbox as unknown as Component<Record<string, unknown>>;
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
			settingsRevision: plugin.settingsRevision.store,
			app: plugin.app,
			dnd: plugin.dnd ?? null,
			menuPorts: taskMenuPortsFromPlugin(plugin),
			// структурный порт InboxWritePort — совместим с VaultAdapter
			vault: plugin.vaultAdapter,
		};
	}
}
