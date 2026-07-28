import type { ViewStateResult } from "obsidian";
import type { Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import type GtdFlowPlugin from "../../main";
import { normalizeActiveNamespace } from "../../core/namespace/namespace";
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

	/**
	 * Календарь — единственный вид, где локальное пространство может быть ALL_NS
	 * («Все»): переопределяем нормализацию, разрешая этот sentinel (allowAll).
	 */
	protected override normalizeNs(name: string): string {
		return normalizeActiveNamespace(name, this.plugin.settings.namespaces, true);
	}

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
			// ЛОКАЛЬНОЕ пространство вида (per-tab) + его переключатель; allowAll —
			// только у календаря (вкладка «Все»). Глобальный дефолт нужен как цель
			// быстрого ввода в режиме «Все» — читается из settings.activeNamespace.
			activeNamespace: { subscribe: this.localNamespace$.subscribe },
			namespaces: plugin.settings.namespaces,
			setActiveNamespace: (name: string) => this.setLocalNamespace(name),
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
		// nsName (базовый) + режим/якорь календаря в один JSON-объект viewState
		return { ...this.namespaceState(), ...this.lastState };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = sanitizeCalendarState(state);
		if (next !== null) {
			this.lastState = next;
			this.persisted.set(next);
		}
		// базовый setState восстанавливает nsName и зовёт ItemView.setState
		await super.setState(state, result);
	}
}
