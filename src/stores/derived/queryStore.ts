/**
 * Мемоизированный per-view запрос поверх TaskStore (ТЗ §2):
 * пересчёт ТОЛЬКО при смене ключа (epoch, today, specHash), дебаунс по trailing edge.
 * Первое значение отдаётся синхронно при подписке — подписчику нужен снэпшот сразу.
 */
import { readable, type Readable } from "svelte/store";
import type { CalendarField } from "../../core/model/projections";
import type { IsoDate, Task } from "../../core/model/Task";
import type { NamespaceFilter } from "../../core/namespace/namespace";
import { evaluate as defaultEvaluate, type QueryContext } from "../../core/query/QueryEngine";
import { defaultInboxConfig, type InboxConfig, type QuerySpec } from "../../core/query/querySpec";
import type { TaskStore } from "../taskStore";
import { specHash } from "./specHash";

export type EvaluateFn = (spec: QuerySpec, ctx: QueryContext) => Task[];

export interface QueryDeps {
	/** Биты настроек для inbox-формулы §1 (остальные запросы их не читают). */
	settingsBits: InboxConfig;
	/**
	 * Реактивный источник активного пространства (per-namespace виды). Отдельный
	 * store, а НЕ epoch: смена активного пространства настроек эпоху индекса не
	 * бампает (см. память проекта), поэтому пере-рендер идёт своей подпиской.
	 * Опционален и прозрачен: без него (или при пустом defs) фильтра нет —
	 * обратная совместимость. Инвалидирует мемо-ключ отдельной осью nsKey.
	 */
	namespace$?: Readable<NamespaceFilter>;
	/** Инжекция вычислителя — только для тестов (подсчёт пересчётов). */
	evaluate?: EvaluateFn;
}

/** Стабильный ключ фильтра пространства для мемоизации (active + список корней). */
function nsKeyOf(filter: NamespaceFilter | undefined): string {
	if (filter === undefined) return "";
	return JSON.stringify([filter.active, filter.defs.map((d) => [d.name, d.root])]);
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

	const compute = (epoch: number, today: IsoDate, ns: NamespaceFilter | undefined): Task[] => {
		const key = epoch + "|" + today + "|" + hash + "|" + nsKeyOf(ns);
		if (key === lastKey) return lastResult;
		const index = taskStore.index();
		lastResult = evalFn(spec, {
			tasks: index.all(),
			today,
			// не отдаём метод голым — resolveDep потерял бы this
			resolveDep: (id) => index.resolveDep(id),
			settingsBits: deps.settingsBits,
			namespace: ns,
		});
		lastKey = key;
		return lastResult;
	};

	return readable<Task[]>([], (set) => {
		let epochNow = 0;
		let todayNow: IsoDate = "";
		let nsNow: NamespaceFilter | undefined = undefined;
		// подписки ниже стреляют синхронно текущими значениями — это не «изменение»
		let primed = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const schedule = (): void => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				set(compute(epochNow, todayNow, nsNow));
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
		const unsubNs =
			deps.namespace$?.subscribe((f) => {
				nsNow = f;
				if (primed) schedule();
			}) ?? null;
		primed = true;
		set(compute(epochNow, todayNow, nsNow));

		return () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			unsubEpoch();
			unsubToday();
			if (unsubNs !== null) unsubNs();
		};
	});
}

// ---------------------------------------------------------------------------
// Готовые фабрики per-view. Запросам без inbox-логики settingsBits не нужны —
// подставляем инертный дефолт, чтобы не тащить настройки через все виды.
// ---------------------------------------------------------------------------

export function inboxStore(
	taskStore: TaskStore,
	inboxConfig: InboxConfig,
	debounceMs = 50,
	namespace$?: Readable<NamespaceFilter>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "inbox" },
		{ settingsBits: inboxConfig, namespace$ },
		debounceMs,
	);
}

export function ticklerStore(
	taskStore: TaskStore,
	debounceMs = 50,
	namespace$?: Readable<NamespaceFilter>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "tickler" },
		{ settingsBits: defaultInboxConfig(), namespace$ },
		debounceMs,
	);
}

export function calendarRangeStore(
	taskStore: TaskStore,
	fromIso: IsoDate,
	toIso: IsoDate,
	placement: readonly CalendarField[],
	debounceMs = 50,
	namespace$?: Readable<NamespaceFilter>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "calendar-range", fromIso, toIso, placement },
		{ settingsBits: defaultInboxConfig(), namespace$ },
		debounceMs,
	);
}

export function projectMembersStore(
	taskStore: TaskStore,
	path: string,
	debounceMs = 50,
): Readable<Task[]> {
	// project-members НЕ режется пространством: файл проекта уже ns-консистентен
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
	namespace$?: Readable<NamespaceFilter>,
): Readable<Task[]> {
	return createQueryStore(
		taskStore,
		{ kind: "all-templates" },
		{ settingsBits: defaultInboxConfig(), namespace$ },
		debounceMs,
	);
}
