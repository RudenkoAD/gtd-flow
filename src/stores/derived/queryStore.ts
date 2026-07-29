/**
 * Мемоизированный per-view запрос поверх TaskStore (ТЗ §2):
 * пересчёт ТОЛЬКО при смене ключа (epoch, today, specHash), дебаунс по trailing edge.
 * Первое значение отдаётся синхронно при подписке — подписчику нужен снэпшот сразу.
 */
import { readable, type Readable } from "svelte/store";
import type { CalendarField } from "../../core/model/projections";
import type { IsoDate, Task } from "../../core/model/Task";
import { evaluate as defaultEvaluate, type QueryContext } from "../../core/query/QueryEngine";
import { defaultInboxConfig, type InboxConfig, type QuerySpec } from "../../core/query/querySpec";
import type { TaskStore } from "../taskStore";
import { specHash } from "./specHash";

export type EvaluateFn = (spec: QuerySpec, ctx: QueryContext) => Task[];

export interface QueryDeps {
	/** Биты настроек для inbox-формулы §1 (остальные запросы их не читают). */
	settingsBits: InboxConfig | (() => InboxConfig);
	/** Ревизия сохранённых настроек. Нужна при in-place мутации объекта settings:
	 * включается в memo-key даже если индекс ещё не менялся. */
	settingsRevision$?: Readable<number>;
	/** Инжекция вычислителя — только для тестов (подсчёт пересчётов). */
	evaluate?: EvaluateFn;
}

export function createQueryStore(
	taskStore: TaskStore,
	spec: QuerySpec,
	deps: QueryDeps,
	debounceMs = 50,
): Readable<Task[]> {
	const evalFn = deps.evaluate ?? defaultEvaluate;
	const hash = specHash(spec);
	// Мемо-ключ живёт ВНЕ start/stop подписки: отписка всех и переподписка
	// при неизменных (epoch, today, ns) не вызывает пересчёт.
	let lastKey: string | null = null;
	let lastResult: Task[] = [];

	const compute = (epoch: number, today: IsoDate, settingsRevision: number): Task[] => {
		const key = epoch + "|" + today + "|" + hash + "|" + settingsRevision;
		if (key === lastKey) return lastResult;
		const index = taskStore.index();
		lastResult = evalFn(spec, {
			tasks: index.all(),
			today,
			// не отдаём метод голым — resolveDep потерял бы this
			resolveDep: (id) => index.resolveDep(id),
			settingsBits:
				typeof deps.settingsBits === "function" ? deps.settingsBits() : deps.settingsBits,
		});
		lastKey = key;
		return lastResult;
	};

	return readable<Task[]>([], (set) => {
		let epochNow = 0;
		let todayNow: IsoDate = "";
		let settingsRevisionNow = 0;
		// подписки ниже стреляют синхронно текущими значениями — это не «изменение»
		let primed = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const schedule = (): void => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				set(compute(epochNow, todayNow, settingsRevisionNow));
			}, debounceMs);
		};

		const unsubEpoch = taskStore.epoch.subscribe((e) => {
			epochNow = e;
			if (primed) schedule();
		});
		const unsubToday = taskStore.today.subscribe((t) => {
			todayNow = t;
			if (primed) schedule();
		});
		const unsubSettings =
			deps.settingsRevision$?.subscribe((revision) => {
				settingsRevisionNow = revision;
				if (primed) schedule();
			}) ?? null;
		primed = true;
		set(compute(epochNow, todayNow, settingsRevisionNow));

		return () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			unsubEpoch();
			unsubToday();
			if (unsubSettings !== null) unsubSettings();
		};
	});
}

// ---------------------------------------------------------------------------
// Готовые фабрики per-view. Запросам без inbox-логики settingsBits не нужны —
// подставляем инертный дефолт, чтобы не тащить настройки через все виды.
// ---------------------------------------------------------------------------

export function inboxStore(
	taskStore: TaskStore,
	inboxConfig: InboxConfig | (() => InboxConfig),
	debounceMs = 50,
	settingsRevision$?: Readable<number>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "inbox" },
		{ settingsBits: inboxConfig, settingsRevision$ },
		debounceMs,
	);
}

export function ticklerStore(
	taskStore: TaskStore,
	debounceMs = 50,
	settingsRevision$?: Readable<number>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "tickler" },
		{ settingsBits: defaultInboxConfig(), settingsRevision$ },
		debounceMs,
	);
}

export function calendarRangeStore(
	taskStore: TaskStore,
	fromIso: IsoDate,
	toIso: IsoDate,
	placement: readonly CalendarField[],
	debounceMs = 50,
	settingsRevision$?: Readable<number>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "calendar-range", fromIso, toIso, placement },
		{ settingsBits: defaultInboxConfig(), settingsRevision$ },
		debounceMs,
	);
}

export function projectMembersStore(
	taskStore: TaskStore,
	path: string,
	debounceMs = 50,
): Readable<Task[]> {
	// project-members не фильтруется по scope: членство задаёт сам файл проекта.
	// (доска/проект отфильтрованы на этапе выбора). См. QueryEngine.evaluate.
	return createQueryStore(
		taskStore,
		{ kind: "project-members", path },
		{ settingsBits: defaultInboxConfig() },
		debounceMs,
	);
}

export function templatesStore(
	taskStore: TaskStore,
	debounceMs = 50,
	settingsRevision$?: Readable<number>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "all-templates" },
		{ settingsBits: defaultInboxConfig(), settingsRevision$ },
		debounceMs,
	);
}
