import type { Component } from "svelte";
import type GtdFlowPlugin from "../../main";
import type { CardPort } from "../../services/CardService";
import type { RecurrencePort } from "../../services/RecurrenceService";
import { GtdView } from "../GtdView";
import { VIEW_META } from "../registry";
import Recurring from "./Recurring.svelte";

/**
 * Регулярные. Компоненту передаётся узкий контекст вместо всего plugin (ТЗ §0).
 * Действия идут через RecurrencePort, не через IntentDispatcher: единственный
 * «пишущий создатель строк» — RecurrenceService (ТЗ §8).
 */
export class RecurringView extends GtdView {
	// getViewType() вызывается конструктором View до присвоения this.meta (см. GtdView).
	protected static override staticMeta = VIEW_META.recurring;

	protected override component(): Component<Record<string, unknown>> {
		return Recurring as unknown as Component<Record<string, unknown>>;
	}

	protected override props(): Record<string, unknown> {
		// recurrence появляется на плагине при интеграции этапа 6 в main.ts,
		// cards — при связке CardService (этап 8); без них — read-only/без пункта
		const plugin = this.plugin as GtdFlowPlugin & {
			recurrence?: RecurrencePort;
			cards?: CardPort;
		};
		return {
			taskStore: plugin.taskStore,
			dispatcher: plugin.dispatcher,
			settings: plugin.settings,
			settingsRevision: plugin.settingsRevision.store,
			app: plugin.app,
			recurrence: plugin.recurrence ?? null,
			cards: plugin.cards ?? null,
			// структурный порт TemplateVaultPort — совместим с VaultAdapter
			vault: plugin.vaultAdapter,
			// ЛОКАЛЬНОЕ пространство вида (per-tab) + его переключатель (см. GtdView).
			activeNamespace: { subscribe: this.localNamespace$.subscribe },
			namespaces: plugin.settings.namespaces,
			setActiveNamespace: (name: string) => this.setLocalNamespace(name),
		};
	}
}
