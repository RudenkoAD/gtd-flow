import type { ViewStateResult } from "obsidian";
import type { Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import type GtdFlowPlugin from "../../main";
import type { QuickAddKind } from "../../settings/Settings";
import type { IntentDispatcher } from "../../services/WritebackService";
import { taskMenuPortsFromPlugin } from "../common/taskMenu";
import { reportAsync } from "../common/runAction";
import type { DndPort } from "../dnd/types";
import { GtdView } from "../GtdView";
import { VIEW_META } from "../registry";
import Calendar from "./Calendar.svelte";
import { sanitizeCalendarState, type CalendarPersistedState } from "./calendarLogic";

/**
 * Календарь. Компоненту передаётся узкий контекст вместо всего plugin (ТЗ §0);
 * viewState (режим, якорная дата) — JSON-сериализуемое (ТЗ §4).
 */
export class CalendarView extends GtdView {
	// getViewType() вызывается конструктором View до присвоения this.meta (см. GtdView).
	protected static override staticMeta = VIEW_META.calendar;

	/** setState приходит ПОСЛЕ onOpen/mount — состояние доносится через store. */
	private readonly persisted: Writable<CalendarPersistedState> = writable({});
	private lastState: CalendarPersistedState = {};

	protected override component(): Component<Record<string, unknown>> {
		return Calendar as unknown as Component<Record<string, unknown>>;
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
			settingsRevision: plugin.settingsRevision.store,
			app: plugin.app,
			dnd: plugin.dnd ?? null,
			menuPorts: taskMenuPortsFromPlugin(plugin),
			// структурный порт CalendarWritePort — совместим с VaultAdapter
			vault: plugin.vaultAdapter,
			dayStatus: plugin.dayStatus,
			persisted: { subscribe: this.persisted.subscribe },
			persist: (s: CalendarPersistedState) => {
				this.lastState = s;
				this.app.workspace.requestSaveLayout();
			},
			// липкое положение переключателя «Задача | Событие» — снимок настройки на
			// монтировании + сохранение в настройки плагина при каждой смене (переживает
			// перезапуск, общее для всех вкладок календаря)
			quickAddKind: plugin.settings.lastQuickAddKind,
			persistQuickAddKind: (kind: QuickAddKind) => {
				plugin.settings.lastQuickAddKind = kind;
				reportAsync("сохранение режима быстрого ввода", () => plugin.saveSettings());
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
