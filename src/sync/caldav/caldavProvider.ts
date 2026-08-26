/**
 * Провайдер вхождений CalDAV (§7 CalDAV-заказа): единственная реализация
 * ExternalOccurrenceProvider (см. src/sync/SyncService.ts). Оркестрирует
 * протокольный слой (discovery + REPORT calendar-query, ./protocol.ts) и
 * разбор ленты (../icsParse.ts); сам не знает ни XML, ни Authorization —
 * это знает protocol.ts, за структурными портами (httpPort.ts, credentials).
 *
 * Обязанности этого модуля (и НИЧЬИ больше):
 * - резолв href коллекции: кэш credential.collections[collectionKey], иначе
 *   discovery — с мемоизацией НА ПРОХОД (см. beginPass) и разделением
 *   discovery-потока между коллекциями ОДНОГО аккаунта (§6.1: одна PROPFIND-
 *   цепочка на аккаунт, а не на подписку — конкурентные load() присоединяются
 *   к уже начатому промису);
 * - единый дедлайн ВСЕГО потока (discovery+REPORT) — берётся из opts.deadlineAt
 *   ОДИН раз и передаётся неизменным в оба протокольных вызова (§6.3: без
 *   сброса между шагами);
 * - агрегатный бюджет разбора ленты ПО КОЛЛЕКЦИИ (§6.4): по-документные
 *   бюджеты parseIcs не композируются (каждый вызов видит бюджет заново),
 *   поэтому здесь ведутся суммарные счётчики (символы/строки/время) и
 *   КАЖДОМУ вызову parseIcs передаётся decremented остаток;
 * - fail-closed политика (§12): один битый embedded-документ роняет ВСЮ
 *   коллекцию (invalid_calendar_data) — частичная публикация зеркала здесь
 *   запрещена (удержание старого зеркала при ошибке — забота вызывающей
 *   стороны, не этого модуля);
 * - гигиена ошибок: наружу уходит либо ExternalSyncError как есть, либо
 *   ExternalSyncError("unknown", <статичная фраза>) — сырые href/логины/тела
 *   ответов сюда никогда не попадают (то же соблюдает protocol.ts).
 *
 * Этот модуль НЕ проецирует приватность (busy/details) и НЕ дедуплицирует
 * вхождения — обе заботы выше по стеку (mirrorBuilder и namespaced id).
 *
 * Ноль импортов obsidian и node-builtin: тестируется в node фейковыми http- и
 * credential-портами (см. caldavProvider.test.ts).
 */
import type { CalDavSourceRef, ExternalOccurrenceProvider } from "../SyncService";
import {
	discoverCalendars,
	queryCalendarData,
	type CalDavAccountConfig,
	type CalDavFlowOptions,
	type DiscoveredCalendar,
} from "./protocol";
import type { CalDavCredential, CalDavCredentialPort, CalDavHttpPort } from "./httpPort";
import { ExternalSyncError } from "../externalSyncStatus";
import { parseIcs, type MirrorOccurrence, type MirrorWindow } from "../icsParse";

/** Потолок суммарного времени разбора ВСЕХ документов одной коллекции (мс). */
const DEFAULT_MAX_AGGREGATE_ELAPSED_MS = 5_000;
/** Потолок суммарных строк-зеркал со ВСЕХ документов одной коллекции. */
const DEFAULT_MAX_AGGREGATE_ROWS = 30_000;
/** Потолок суммарной длины (код-юниты) ВСЕХ calendar-data документов коллекции. */
const DEFAULT_MAX_AGGREGATE_CHARS = 10 * 1024 * 1024;

/** Переопределение агрегатных бюджетов разбора (тесты; прод держится дефолтов). */
export interface CalDavProviderLimits {
	maxAggregateChars?: number;
	maxAggregateRows?: number;
	maxAggregateElapsedMs?: number;
}

export interface CalDavProviderDeps {
	http: CalDavHttpPort;
	credentials: CalDavCredentialPort;
	/** Внедряемые часы (тесты замораживают время); по умолчанию Date.now. */
	now?: () => number;
	limits?: CalDavProviderLimits;
}

function checkAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new ExternalSyncError("timeout", "caldav flow aborted");
}

/**
 * Реализация ExternalOccurrenceProvider поверх CalDAV-протокола (см. заголовок
 * файла). Один экземпляр рассчитан на весь жизненный цикл SyncService —
 * per-pass состояние (мемо discovery) сбрасывается явным beginPass().
 */
export class CalDavProvider implements ExternalOccurrenceProvider {
	private readonly http: CalDavHttpPort;
	private readonly credentials: CalDavCredentialPort;
	private readonly now: () => number;
	private readonly maxAggregateChars: number;
	private readonly maxAggregateRows: number;
	private readonly maxAggregateElapsedMs: number;

	/** accountId → discovery-промис, разделяемый ВСЕМИ коллекциями этого
	 *  аккаунта в текущем проходе (§6.1). Промис кладётся в мемо ДО await —
	 *  конкурентные load() успевают присоединиться к тому же промису. */
	private discoveryMemo = new Map<string, Promise<readonly DiscoveredCalendar[]>>();

	constructor(deps: CalDavProviderDeps) {
		this.http = deps.http;
		this.credentials = deps.credentials;
		this.now = deps.now ?? Date.now;
		this.maxAggregateChars = deps.limits?.maxAggregateChars ?? DEFAULT_MAX_AGGREGATE_CHARS;
		this.maxAggregateRows = deps.limits?.maxAggregateRows ?? DEFAULT_MAX_AGGREGATE_ROWS;
		this.maxAggregateElapsedMs =
			deps.limits?.maxAggregateElapsedMs ?? DEFAULT_MAX_AGGREGATE_ELAPSED_MS;
	}

	/** Начало прохода: сброс мемо discovery. Отклонённый промис прошлого
	 *  прохода и так уже эвакуирован (см. discoverForAccount) — новый Map
	 *  здесь просто гарантирует чистое состояние сразу для ВСЕХ аккаунтов. */
	beginPass(): void {
		this.discoveryMemo = new Map();
	}

	async load(
		source: CalDavSourceRef,
		window: MirrorWindow,
		opts: { deadlineAt: number; signal: AbortSignal },
	): Promise<readonly MirrorOccurrence[]> {
		try {
			checkAborted(opts.signal);

			const credential = this.credentials.get(source.account.id);
			if (credential === null)
				throw new ExternalSyncError(
					"credential_missing",
					"no local credential for account",
				);

			const accountConfig: CalDavAccountConfig = {
				id: source.account.id,
				serverOrigin: source.account.serverOrigin,
			};
			// Единый дедлайн всего потока (§6.3): один объект опций для discovery
			// И query — без пересборки/сброса между шагами.
			const flowOptions: CalDavFlowOptions = { deadlineAt: opts.deadlineAt, now: this.now };

			const href = await this.resolveCollectionHref(
				accountConfig,
				credential,
				source.sub.collectionKey,
				flowOptions,
			);
			checkAborted(opts.signal);

			const docs = await queryCalendarData(
				accountConfig,
				credential,
				href,
				window,
				this.http,
				flowOptions,
			);

			return await this.parseAggregate(docs, window, opts.signal);
		} catch (error) {
			if (error instanceof ExternalSyncError) throw error;
			throw new ExternalSyncError("unknown", "caldav sync failed unexpectedly");
		}
	}

	/** Кэш из credential.collections — иначе разделяемое per-account discovery. */
	private async resolveCollectionHref(
		accountConfig: CalDavAccountConfig,
		credential: CalDavCredential,
		collectionKey: string,
		flowOptions: CalDavFlowOptions,
	): Promise<string> {
		const cached = credential.collections?.[collectionKey];
		if (cached !== undefined) return cached;

		const calendars = await this.discoverForAccount(accountConfig, credential, flowOptions);
		const found = calendars.find((calendar) => calendar.collectionKey === collectionKey);
		if (found === undefined)
			throw new ExternalSyncError("collection_missing", "collection not found on account");
		return found.href;
	}

	/** Одна discovery-цепочка на аккаунт за проход. Отклонённый промис ТУТ ЖЕ
	 *  эвакуируется из мемо — следующий вызов (в т.ч. в этом же проходе, если
	 *  он приходит ПОСЛЕ уже осевшего отказа) получает свежую попытку; но
	 *  конкурентные вызовы, УЖЕ держащие ссылку на отклонённый промис, видят
	 *  один и тот же отказ (это тот же промис, мемо тут ни при чём). */
	private discoverForAccount(
		accountConfig: CalDavAccountConfig,
		credential: CalDavCredential,
		flowOptions: CalDavFlowOptions,
	): Promise<readonly DiscoveredCalendar[]> {
		const accountId = accountConfig.id;
		const existing = this.discoveryMemo.get(accountId);
		if (existing !== undefined) return existing;

		const promise = discoverCalendars(accountConfig, credential, this.http, flowOptions);
		this.discoveryMemo.set(accountId, promise);
		promise.catch(() => {
			if (this.discoveryMemo.get(accountId) === promise) this.discoveryMemo.delete(accountId);
		});
		return promise;
	}

	/**
	 * Разобрать документы ОДНОЙ коллекции по отдельности (НИКОГДА не
	 * конкатенировать — ical.js молча портит склеенные VCALENDAR) под общим
	 * агрегатным бюджетом (§6.4): по-документные бюджеты parseIcs не
	 * складываются, поэтому здесь ведутся суммарные счётчики и КАЖДОМУ вызову
	 * передаётся остаток. Любой сбой parseIcs (включая IcsBudgetError и сырую
	 * ошибку формата) → invalid_calendar_data ЦЕЛОЙ коллекции (§12: частичная
	 * публикация запрещена).
	 */
	private async parseAggregate(
		docs: readonly string[],
		window: MirrorWindow,
		signal: AbortSignal,
	): Promise<MirrorOccurrence[]> {
		const flowStartMs = this.now();
		let charsSoFar = 0;
		let rowsSoFar = 0;
		const out: MirrorOccurrence[] = [];

		for (const doc of docs) {
			checkAborted(signal);

			charsSoFar += doc.length;
			if (charsSoFar > this.maxAggregateChars)
				throw new ExternalSyncError(
					"response_too_large",
					"calendar data exceeds size budget",
				);

			const elapsedSoFar = this.now() - flowStartMs;
			const perCallBudget = {
				maxElapsedMs: Math.max(1, this.maxAggregateElapsedMs - elapsedSoFar),
				maxTotalRows: Math.max(1, this.maxAggregateRows - rowsSoFar),
			};

			let occurrences: MirrorOccurrence[];
			try {
				occurrences = parseIcs(doc, window, { budget: perCallBudget, nowMs: this.now });
			} catch {
				throw new ExternalSyncError(
					"invalid_calendar_data",
					"calendar data could not be parsed",
				);
			}

			rowsSoFar += occurrences.length;
			if (rowsSoFar > this.maxAggregateRows)
				throw new ExternalSyncError(
					"response_too_large",
					"calendar data exceeds row budget",
				);

			out.push(...occurrences);
		}

		return out;
	}
}
