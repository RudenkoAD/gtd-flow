/**
 * SyncService — оркестрация зеркалирования внешних календарей (§внешние
 * календари): по таймеру (и по требованию) для каждой подписки
 *   fetch(URL) → parseIcs → buildMirrorFile → запись в файл-зеркало, ТОЛЬКО если
 *   текст изменился (иначе не дёргаем sync-клиент хранилища впустую).
 *
 * Ноль импортов obsidian: сеть и хранилище приходят структурными портами
 * (requestUrl/vault подставляет main.ts) — сервис тестируется в node с
 * фейковыми портами. Ошибки сети/разбора НЕ роняют плагин: они ловятся и
 * пишутся в статус подписки (onResult), таймер продолжает жить.
 */
import type { ActiveCalendarSub, CalDavAccount, CalDavCalendarSub } from "../settings/Settings";
import { projectOccurrences, type MirrorPrivacyMode } from "./caldav/projection";
import { buildMirrorFile } from "./mirrorBuilder";
import {
	IcsBudgetError,
	mirrorWindow,
	parseIcs,
	type MirrorOccurrence,
	type MirrorWindow,
} from "./icsParse";
import {
	ExternalSyncError,
	NEVER_ATTEMPTED_STATUS,
	type ExternalRuntimeStatus,
	type ExternalSubscriptionReport,
	type ExternalSyncErrorCode,
	type ExternalSyncReport,
} from "./externalSyncStatus";

/** Минимум, от которого детерминирован путь зеркала: стабильный id + имя. */
export interface MirrorPathSource {
	id: string;
	name: string;
}

/** Одна caldav-подписка вместе с её аккаунтом (резолвится из настроек). */
export interface CalDavSourceRef {
	sub: CalDavCalendarSub;
	account: CalDavAccount;
}

/**
 * Порт провайдера вхождений внешнего источника (§7 CalDAV-заказа).
 * Реализация (CalDavProvider) живёт в src/sync/caldav и получает http и
 * credential-порты; SyncService не знает ни XML, ни Authorization, ни
 * SecretStorage. Отсутствие провайдера в deps — caldav-подписки skipped.
 */
export interface ExternalOccurrenceProvider {
	/** Начало прохода: сброс per-pass мемоизации (discovery по аккаунту
	 *  выполняется максимум один раз на проход и разделяется коллекциями). */
	beginPass(): void;
	/** Загрузить вхождения одной коллекции. Ошибки — ТОЛЬКО ExternalSyncError
	 *  с безопасным сообщением; сырые URL/тела сюда не попадают. */
	load(
		source: CalDavSourceRef,
		window: MirrorWindow,
		opts: { deadlineAt: number; signal: AbortSignal },
	): Promise<readonly MirrorOccurrence[]>;
}

/**
 * Итог синхронизации одной подписки (пишется в статус).
 * `detail` — сырой текст ТОЛЬКО для console-диагностики: main обязан
 * персистить исключительно `code` (см. applySyncResult), а detail никогда не
 * попадает в data.json/Notice/UI.
 */
export type SyncResult =
	{ ok: true; at: number } | { ok: false; code: ExternalSyncErrorCode; detail: string };

/** Порт хранилища: чтение и создание-или-перезапись файла целиком. */
export interface SyncVaultPort {
	/** Текущее содержимое файла или null, если файла нет. */
	read(path: string): Promise<string | null>;
	/** Создать (с родительскими папками) или перезаписать файл целиком. */
	write(path: string, content: string): Promise<void>;
	/** Удалить осиротевшее зеркало (при удалении/переименовании подписки).
	 *  Опционально (старые обёртки/тесты без удаления его не задают); предпочтительно —
	 *  в системную корзину (vault.trash), чтобы случайные правки восстанавливались.
	 *  Идемпотентно: нет файла — тихо ничего. */
	delete?(path: string): Promise<void>;
	/** All generated external mirrors known to the host.  Supplying this enables
	 * startup reconciliation after a subscription storage location changed while
	 * the plugin was not running. */
	listManagedMirrors?(): Promise<readonly ManagedMirror[]>;
}

/** Minimal metadata needed for lifecycle reconciliation; content is never read here. */
export interface ManagedMirror {
	path: string;
	subscriptionId: string | null;
}

export interface SyncClock {
	now(): Date;
}

export interface SyncDeps {
	/** Сетевой fetch ленты (обёртка над obsidian requestUrl — НЕ fetch: CORS). */
	fetch: (url: string, signal?: AbortSignal) => Promise<string>;
	vault: SyncVaultPort;
	clock: SyncClock;
	/** Актуальный список АКТИВНЫХ подписок (ics/caldav; читается на каждый
	 *  проход из настроек). Инертные InvalidCalendarSub сюда не попадают —
	 *  их id приходят через inertSubscriptionIds. */
	subscriptions: () => readonly ActiveCalendarSub[];
	/** Реестр CalDAV-аккаунтов (identity-fence и провайдер этапов 4-5 читают
	 *  отсюда; секретов здесь нет по построению). */
	accounts?: () => readonly CalDavAccount[];
	/** Id инертных (повреждённых) записей подписок: их зеркала нельзя трогать
	 *  orphan-очисткой, пока запись существует в настройках. */
	inertSubscriptionIds?: () => readonly string[];
	/** Провайдер caldav-вхождений; отсутствует на этапах до композиции —
	 *  caldav-подписки тогда получают отчёт "skipped". */
	caldavProvider?: ExternalOccurrenceProvider;
	/** Существует ли активный (не архивный) GTD-scope с данным id — гейт
	 *  scope_missing (§4.2): неизвестный/архивный scope блокирует обновление. */
	scopeExists?: (scopeId: string) => boolean;
	/** Дедлайн ПОЛНОГО caldav-потока одной подписки (discovery+REPORT вместе,
	 *  §6.3: без сброса по шагам); default 120 c. */
	caldavFlowTimeoutMs?: () => number;
	/** Unified inbox determines the sibling folder for generated mirrors. */
	inboxFile: () => string;
	/** Интервал поллинга в минутах (min 1); читается при планировании. */
	intervalMin: () => number;
	/** Deadline одного сетевого запроса.  Адаптер может проигнорировать signal, но
	 * сервис всё равно завершит проход по тайм-ауту и оградит запись generation-fence. */
	feedTimeoutMs?: () => number;
	/** Max parallel feeds in a whole-vault pass. */
	maxConcurrentFeeds?: () => number;
	/** Обновление статуса подписки (lastSyncAt/lastError) — main персистит. */
	onResult: (id: string, result: SyncResult) => void;
	/** Non-fatal lifecycle diagnostics (for example an orphan removed at startup). */
	onLifecycleWarning?: (message: string) => void;
}

/** Подкаталог файлов-зеркал рядом с настроенным единым inbox. */
const EXTERNAL_DIR = "External";
export const DEFAULT_SYNC_FEED_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_FEEDS = 3;
const CONFIG_RECONCILE_DEBOUNCE_MS = 300;
/** Дедлайн ПОЛНОГО caldav-потока подписки (discovery+REPORT вместе, §6.3). */
const DEFAULT_CALDAV_FLOW_TIMEOUT_MS = 120_000;

/**
 * Безопасное имя файла из имени подписки: недопустимые для файловой системы
 * символы → «_», без ведущих точек и хвостовых точек/пробелов; пусто → "calendar".
 */
export function safeMirrorFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "");
	return cleaned === "" ? "calendar" : cleaned;
}

/**
 * Короткий стабильный слаг из id подписки для имени файла-зеркала. Делает путь
 * уникальным ПО ПОСТРОЕНИЮ: две подписки с ОДИНАКОВЫМ именем получают разные файлы
 * (иначе они делили бы один файл-зеркало и вечно перезаписывали друг друга).
 * Берём 6 base36-символов детерминированного FNV-хэша ПОЛНОГО id, а не «первые 6
 * символов» самого id: генератор id (`ext-<время36>-<rand>`) держит уникальную
 * энтропию в ХВОСТЕ, поэтому первые 6 символов у подписок, добавленных подряд,
 * совпадают. Хэш свободен от структуры id и стабилен (тот же id → тот же файл).
 */
export function subIdSlug(id: string): string {
	let h = 0x811c9dc5 >>> 0;
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
	return (h % 2176782336).toString(36).padStart(6, "0"); // 36^6 = 2176782336 → ровно 6 символов
}

/**
 * Path for a generated mirror: `<inbox parent>/External/<name>-<slug>.md`.
 * <slug> из id (см. subIdSlug) снимает коллизии одинаковых имён; переименование
 * подписки меняет часть-имя предсказуемо (slug стабилен — привязан к id).
 */
export function mirrorPath(sub: MirrorPathSource, inboxFile: string): string {
	const file = `${EXTERNAL_DIR}/${safeMirrorFileName(sub.name)}-${subIdSlug(sub.id)}.md`;
	return underInboxParent(inboxFile, file);
}

/** Pre-stable-id releases used this name-only form.  It is only used to
 * recognise a safe one-time migration candidate, never to delete an arbitrary
 * user-created `gtd-external` note. */
function legacyMirrorPath(sub: MirrorPathSource, inboxFile: string): string {
	return underInboxParent(inboxFile, `${EXTERNAL_DIR}/${safeMirrorFileName(sub.name)}.md`);
}

function underInboxParent(inboxFile: string, child: string): string {
	const normalized = inboxFile.trim().replace(/^\/+|\/+$/gu, "");
	const slash = normalized.lastIndexOf("/");
	const parent = slash === -1 ? "" : normalized.slice(0, slash);
	return parent === "" ? child : `${parent}/${child}`;
}

function errMessage(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	// console-диагностика — короткая строка; длинные тела ответов не тащим
	return msg.length > 200 ? msg.slice(0, 197) + "…" : msg;
}

/** Классификация нетипизированных исключений legacy-ICS-пути. */
function classifyCode(e: unknown): ExternalSyncErrorCode {
	if (e instanceof ExternalSyncError) return e.code;
	if (e instanceof IcsBudgetError) return "invalid_calendar_data";
	return "unknown";
}

/** Убрать все \r (для сравнения диска и генерируемого контента без CRLF-шума). */
function stripCr(s: string): string {
	return s.replace(/\r/g, "");
}

interface SyncContext {
	sub: ActiveCalendarSub;
	generation: number;
	inboxFile: string;
}

/** Внутренний итог одной подписки в проходе; агрегируется в ExternalSyncReport. */
interface SubOutcome extends ExternalSubscriptionReport {
	changed: boolean;
}

function emptyReport(at: number): ExternalSyncReport {
	return { status: "ok", startedAt: at, finishedAt: at, changedMirrors: 0, subscriptions: [] };
}

/** Агрегация §10: error — все затронутые подписки упали; partial — часть. */
function buildReport(
	startedAt: number,
	finishedAt: number,
	outcomes: SubOutcome[],
): ExternalSyncReport {
	const attempted = outcomes.filter((o) => o.status !== "skipped");
	const failed = attempted.filter((o) => o.status === "error");
	const status =
		failed.length === 0 ? "ok" : failed.length === attempted.length ? "error" : "partial";
	return {
		status,
		startedAt,
		finishedAt,
		changedMirrors: outcomes.filter((o) => o.changed).length,
		subscriptions: outcomes.map(({ changed: _changed, ...report }) => report),
	};
}

export class SyncService {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	private activeSyncAll: Promise<ExternalSyncReport> | null = null;
	private disposed = false;
	/** Runtime-статусы подписок ЭТОГО процесса (§9 UI-состояния; не персистятся).
	 *  Сюда попадают и device-local коды (credential_missing), которым запрещён
	 *  путь в общий data.json. */
	private readonly runtime = new Map<string, ExternalRuntimeStatus>();
	/** Any settings/path mutation bumps this fence.  A stale async operation can
	 * finish, but cannot write or report success after the fence moved. */
	private configGeneration = 0;
	/** Deleted ids stay fenced even if their old object remains temporarily in a
	 * settings array while the vault trash operation awaits. */
	private readonly tombstones = new Set<string>();
	private readonly inFlight = new Map<
		string,
		{ generation: number; promise: Promise<SubOutcome> }
	>();
	private readonly aborters = new Map<string, AbortController>();
	/** Fallback reconciliation for hosts that cannot enumerate managed mirrors. */
	private readonly knownMirrorPaths = new Map<string, string>();

	constructor(private readonly deps: SyncDeps) {}

	/** Запустить периодический поллинг + начальную синхронизацию (после layout-ready). */
	start(): void {
		if (this.disposed) return;
		this.schedule();
		void this.reconcileAndSync();
	}

	/** Пересобрать таймер под текущий интервал (SettingsTab зовёт при правке интервала). */
	restart(): void {
		if (this.disposed) return;
		this.schedule();
	}

	/** Остановить таймер (onunload). */
	dispose(): void {
		this.disposed = true;
		this.configGeneration++;
		this.clearTimer();
		this.clearReconcileTimer();
		for (const controller of this.aborters.values()) controller.abort();
		this.aborters.clear();
	}

	/** Санитизированный runtime-статус подписки для UI/автоматизации: только
	 *  состояние + код, никаких сырых строк. */
	runtimeStatus(id: string): ExternalRuntimeStatus {
		return this.runtime.get(id) ?? NEVER_ATTEMPTED_STATUS;
	}

	/** Синхронизировать ВСЕ подписки (команда палитры / кнопка «Синхронизировать сейчас»).
	 *  Перекрывающиеся вызовы разделяют ОДИН и тот же Promise: второй вызывающий
	 *  действительно ждёт результат, а не получает ложный «no-op».
	 *  Возвращает ТЕРМИНАЛЬНЫЙ отчёт (§10): отчёт описывает финальный проход
	 *  последнего стабильного поколения конфигурации — dispatch не есть успех. */
	async syncAll(): Promise<ExternalSyncReport> {
		if (this.disposed) return emptyReport(this.deps.clock.now().getTime());
		if (this.activeSyncAll !== null) return this.activeSyncAll;
		const startedAt = this.deps.clock.now().getTime();
		// One shared run drains configuration generations: if settings change
		// while an old snapshot is syncing, callers keep awaiting this same
		// promise until a fresh current-generation pass has also completed.
		const run = this.runAllUntilCurrentConfiguration().then((outcomes) =>
			buildReport(startedAt, this.deps.clock.now().getTime(), outcomes),
		);
		this.activeSyncAll = run;
		const clearActive = (): void => {
			if (this.activeSyncAll === run) this.activeSyncAll = null;
		};
		// `finally()` would create a second rejected promise when `run` rejects.
		// Observe both settlements explicitly so cleanup itself cannot leak one.
		void run.then(clearActive, clearActive);
		return run;
	}

	/** Синхронизировать ОДНУ подписку по id (кнопка per-подписка в настройках).
	 *  Гонки с тиком/повторным кликом снимает per-sub гейт внутри syncOne.
	 *  Возвращает терминальную запись отчёта; null — подписка неизвестна/удалена. */
	async syncById(id: string): Promise<ExternalSubscriptionReport | null> {
		const sub = this.deps.subscriptions().find((s) => s.id === id);
		if (sub === undefined || this.tombstones.has(id)) return null;
		const { changed: _changed, ...report } = await this.syncOne({ ...sub });
		return report;
	}

	/** Call after any setting that can change a mirror target or feed identity.
	 * It fences already-awaited work immediately, then coalesces rapid text edits
	 * into one reconcile + refresh pass. */
	configurationChanged(): void {
		if (this.disposed) return;
		this.configGeneration++;
		for (const controller of this.aborters.values()) controller.abort();
		this.scheduleConfigurationReconcile();
	}

	/**
	 * Удалить файл-зеркало подписки (осиротевшее при удалении подписки или её
	 * переименовании — путь детерминирован от id+имени, см. mirrorPath). Через порт
	 * vault.delete (предпочтительно в корзину); порт без delete или отсутствие файла —
	 * тихо ничего. Дёргает SettingsTab (кнопка удаления и смена имени).
	 */
	async deleteMirror(sub: MirrorPathSource): Promise<void> {
		const path = mirrorPath(sub, this.deps.inboxFile());
		await this.deletePath(path);
		if (this.knownMirrorPaths.get(sub.id) === path) this.knownMirrorPaths.delete(sub.id);
	}

	/** Remove a subscription safely: tombstone and abort before touching the
	 * mirror, so a delayed fetch cannot recreate it during the UI's delete flow. */
	async removeSubscription(sub: MirrorPathSource): Promise<void> {
		this.tombstones.add(sub.id);
		this.configGeneration++;
		this.aborters.get(sub.id)?.abort();
		try {
			await this.deleteMirror(sub);
		} catch (e) {
			// The UI keeps the subscription when trashing failed, so do not leave it
			// permanently disabled.  The generation fence still invalidated the old
			// operation; a later explicit sync starts a fresh safe one.
			this.tombstones.delete(sub.id);
			throw e;
		}
	}

	/** Undo a completed removal only when its settings persistence failed.  This
	 * is deliberately separate from configurationChanged(): while removal is in
	 * flight the subscription still exists in settings, so clearing tombstones
	 * there would let its delayed fetch recreate the mirror. */
	rollbackSubscriptionRemoval(id: string): void {
		if (this.disposed || !this.tombstones.delete(id)) return;
		// The restored settings are now authoritative.  Fence any work begun
		// before rollback, then reconcile and refresh the restored subscription.
		this.configurationChanged();
	}

	/** Startup and settings-change reconciliation.  Mirrors with a stable marker
	 * are moved (trash old path) or removed when their subscription no longer
	 * exists.  Legacy name-only files are only recognised when they exactly match
	 * the current subscription's historical path. */
	async reconcileMirrors(): Promise<void> {
		if (this.disposed) return;
		const generation = this.configGeneration;
		const inboxFile = this.deps.inboxFile();
		const subs = this.deps.subscriptions().map((sub) => ({ ...sub }));
		const active = new Map(subs.map((sub) => [sub.id, sub]));
		const desired = new Map(subs.map((sub) => [sub.id, mirrorPath(sub, inboxFile)]));

		const inert = new Set(this.deps.inertSubscriptionIds?.() ?? []);

		const discovered = await this.deps.vault.listManagedMirrors?.();
		if (!this.isConfigurationCurrent(generation)) return;
		if (discovered !== undefined) {
			for (const mirror of discovered) {
				if (!this.isConfigurationCurrent(generation)) return;
				// Зеркало инертной (повреждённой) записи не трогаем: пока запись
				// существует в настройках, её данные не подлежат orphan-очистке.
				if (mirror.subscriptionId !== null && inert.has(mirror.subscriptionId)) {
					this.warn(
						`External calendar mirror for invalid subscription record ${mirror.subscriptionId} left unchanged`,
					);
					continue;
				}
				const sub =
					mirror.subscriptionId === null ? undefined : active.get(mirror.subscriptionId);
				if (sub === undefined) {
					const legacy = subs.find(
						(candidate) =>
							mirror.subscriptionId === null &&
							(mirror.path === mirrorPath(candidate, inboxFile) ||
								mirror.path === legacyMirrorPath(candidate, inboxFile)),
					);
					if (legacy !== undefined) {
						const target = desired.get(legacy.id)!;
						if (mirror.path === target) {
							// Current pre-marker path: keep it until the following sync rewrites
							// the same file with gtd-external-id, avoiding a needless gap.
							this.knownMirrorPaths.set(legacy.id, target);
							this.warn(
								`Will add stable id to legacy external calendar mirror for subscription ${legacy.id}`,
							);
						} else {
							await this.deletePath(mirror.path);
							this.warn(
								`Migrated legacy external calendar mirror for subscription ${legacy.id}`,
							);
						}
					} else if (mirror.subscriptionId !== null) {
						await this.deletePath(mirror.path);
						this.warn(
							`Removed orphaned external calendar mirror for subscription ${mirror.subscriptionId}`,
						);
					} else {
						this.warn(
							`Found an unidentifiable legacy external calendar mirror at ${mirror.path}; left unchanged`,
						);
					}
					continue;
				}
				const target = desired.get(sub.id)!;
				if (mirror.path !== target) {
					await this.deletePath(mirror.path);
					this.warn(`Relocated external calendar mirror for subscription ${sub.id}`);
				} else {
					this.knownMirrorPaths.set(sub.id, target);
				}
			}
			return;
		}

		// Older hosts cannot enumerate mirrors.  We still clean every path written
		// during this process lifetime, which covers live setting changes.
		for (const [id, path] of this.knownMirrorPaths) {
			if (!this.isConfigurationCurrent(generation)) return;
			const target = desired.get(id);
			if (target === undefined || target !== path) {
				await this.deletePath(path);
				this.knownMirrorPaths.delete(id);
			}
		}
	}

	private async runAll(): Promise<SubOutcome[]> {
		// Один сброс per-account discovery-мемоизации на КАЖДЫЙ проход (§6.3):
		// сиблинг-коллекции одного аккаунта делят один discovery внутри прохода,
		// а конкурентный лимит прохода не размывается между проходами.
		this.deps.caldavProvider?.beginPass();
		const subs = this.deps.subscriptions().map((sub) => ({ ...sub }));
		const requested = Math.floor(
			this.deps.maxConcurrentFeeds?.() ?? DEFAULT_MAX_CONCURRENT_FEEDS,
		);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(8, requested))
			: DEFAULT_MAX_CONCURRENT_FEEDS;
		let cursor = 0;
		const outcomes: SubOutcome[] = [];
		const worker = async (): Promise<void> => {
			while (!this.disposed) {
				const sub = subs[cursor++];
				if (sub === undefined) return;
				outcomes.push(await this.syncOne(sub));
			}
		};
		await Promise.allSettled(
			Array.from({ length: Math.min(limit, subs.length) }, () => worker()),
		);
		return outcomes;
	}

	/** Complete at least one pass for the latest stable configuration. Отчёт
	 * строится по ФИНАЛЬНОМУ проходу: устаревшие поколения дренируются молча. */
	private async runAllUntilCurrentConfiguration(): Promise<SubOutcome[]> {
		while (!this.disposed) {
			const generation = this.configGeneration;
			const outcomes = await this.runAll();
			if (generation === this.configGeneration) return outcomes;
		}
		return [];
	}

	private skippedOutcome(sub: ActiveCalendarSub): SubOutcome {
		return {
			id: sub.id,
			status: "skipped",
			lastSuccessAt: sub.lastSyncAt,
			errorCode: null,
			changed: false,
		};
	}

	private syncOne(sub: ActiveCalendarSub): Promise<SubOutcome> {
		if (this.disposed || this.tombstones.has(sub.id))
			return Promise.resolve(this.skippedOutcome(sub));
		const existing = this.inFlight.get(sub.id);
		if (existing !== undefined && existing.generation === this.configGeneration)
			return existing.promise;
		const context: SyncContext = {
			sub,
			generation: this.configGeneration,
			inboxFile: this.deps.inboxFile(),
		};
		// «syncing» выставляется только при реальном запуске; skipped-исход
		// возвращает прежнее состояние, чтобы не затирать последний результат.
		const previous = this.runtime.get(sub.id) ?? null;
		this.runtime.set(sub.id, {
			state: "syncing",
			errorCode: null,
			lastAttemptAt: this.deps.clock.now().getTime(),
		});
		const promise = this.performSync(context).then((outcome) => {
			this.applyRuntimeOutcome(sub.id, outcome, previous);
			return outcome;
		});
		this.inFlight.set(sub.id, { generation: context.generation, promise });
		const clearInFlight = (): void => {
			if (this.inFlight.get(sub.id)?.promise === promise) this.inFlight.delete(sub.id);
		};
		void promise.then(clearInFlight, clearInFlight);
		return promise;
	}

	private applyRuntimeOutcome(
		id: string,
		outcome: SubOutcome,
		previous: ExternalRuntimeStatus | null,
	): void {
		const current = this.runtime.get(id);
		const lastAttemptAt = current?.lastAttemptAt ?? this.deps.clock.now().getTime();
		if (outcome.status === "skipped") {
			// Пропуск (fence/провайдер ещё не поддержан) не является попыткой:
			// вернуть прежнее наблюдаемое состояние.
			if (previous === null) this.runtime.delete(id);
			else this.runtime.set(id, previous);
			return;
		}
		if (outcome.status === "error") {
			this.runtime.set(id, { state: "error", errorCode: outcome.errorCode, lastAttemptAt });
			return;
		}
		this.runtime.set(id, {
			state: outcome.status === "ok" ? "okChanged" : "okUnchanged",
			errorCode: null,
			lastAttemptAt,
		});
	}

	private async performSync(context: SyncContext): Promise<SubOutcome> {
		const { sub } = context;
		if (sub.kind === "caldav") return this.performCaldavSync({ ...context, sub });
		try {
			const raw = sub.url.trim();
			if (raw === "") throw new ExternalSyncError("unknown", "не задан адрес ленты");
			// webcal:// — тот же HTTP(S)-ресурс под iCal-схемой «Подписаться» (Apple/Google):
			// нормализуем к https перед сетевым запросом (requestUrl схему webcal не понимает).
			const url = raw.replace(/^webcal:\/\//i, "https://");
			const text = await this.fetchWithDeadline(sub.id, url).catch((e: unknown) => {
				throw e instanceof ExternalSyncError
					? e
					: new ExternalSyncError("network_error", errMessage(e));
			});
			if (!this.isCurrent(context)) return this.skippedOutcome(sub);
			let occurrences;
			try {
				occurrences = parseIcs(text, mirrorWindow(this.deps.clock.now()));
			} catch (e) {
				throw new ExternalSyncError("invalid_calendar_data", errMessage(e));
			}
			if (!this.isCurrent(context)) return this.skippedOutcome(sub);
			const content = buildMirrorFile(occurrences, {
				name: sub.name,
				subscriptionId: sub.id,
			});
			return await this.writeMirrorAndReport(context, content);
		} catch (e) {
			return this.handleSyncFailure(context, e);
		}
	}

	/**
	 * CalDAV-ветвь performSync (§7 CalDAV-заказа). Гейты §4.2/§4.3 fail-closed
	 * ДО любой сети: провайдер не собран/подписка draft-disabled/redaction ещё
	 * не зачищена → skipped БЕЗ попытки (не считается ошибкой, см. §10). Каждая
	 * последующая причина (scope_missing, отсутствующий аккаунт, сбой
	 * провайдера) бросается ВНУТРИ try — тот же классификатор/отчёт, что и у
	 * ics-ветки (handleSyncFailure), персистит код и сохраняет зеркало (без записи).
	 */
	private async performCaldavSync(
		context: SyncContext & { sub: CalDavCalendarSub },
	): Promise<SubOutcome> {
		const { sub } = context;
		const provider = this.deps.caldavProvider;
		// Провайдер появляется в композиции на этапе 4/5; до него caldav-подписка
		// не делает ни сетевых запросов, ни записей.
		if (provider === undefined) return this.skippedOutcome(sub);
		// Draft/выключенные/зафенсированные redaction-состояния никогда не
		// синкаются — ни по таймеру, ни по syncAll(), оба идут через performSync.
		if (
			sub.enabled === false ||
			sub.privacy === "unconfigured" ||
			sub.pendingRedaction === true
		)
			return this.skippedOutcome(sub);
		// sub.privacy сужен к MirrorPrivacyMode копированием в локальную const:
		// "unconfigured" уже отсечён гейтом выше.
		const privacy: MirrorPrivacyMode = sub.privacy === "busy" ? "busy" : "details";
		try {
			if (
				sub.scopeId !== null &&
				(this.deps.scopeExists === undefined || !this.deps.scopeExists(sub.scopeId))
			) {
				// Неизвестный/архивный scope блокирует обновление зеркала (§4.2):
				// никогда не расскоупливаем молча — существующее зеркало остаётся.
				throw new ExternalSyncError("scope_missing", "scope missing");
			}
			const account = this.deps.accounts?.().find((a) => a.id === sub.accountId);
			if (account === undefined) {
				throw new ExternalSyncError("unknown", "account record missing");
			}

			// Один AbortController на ВЕСЬ caldav-поток (discovery+REPORT вместе):
			// configurationChanged()/dispose()/removeSubscription() обходят
			// this.aborters и абортят его целиком (та же конвенция, что и у
			// fetchWithDeadline — регистрация при старте, снятие в finally, только
			// если контроллер всё ещё «наш»).
			const controller = new AbortController();
			this.aborters.set(sub.id, controller);
			let occurrences: readonly MirrorOccurrence[];
			try {
				const requested = Math.floor(
					this.deps.caldavFlowTimeoutMs?.() ?? DEFAULT_CALDAV_FLOW_TIMEOUT_MS,
				);
				const flowTimeoutMs = Number.isFinite(requested)
					? Math.max(1, Math.min(600_000, requested))
					: DEFAULT_CALDAV_FLOW_TIMEOUT_MS;
				const deadlineAt = this.deps.clock.now().getTime() + flowTimeoutMs;
				occurrences = await provider
					.load({ sub, account }, mirrorWindow(this.deps.clock.now()), {
						deadlineAt,
						signal: controller.signal,
					})
					.catch((e: unknown) => {
						throw e instanceof ExternalSyncError
							? e
							: new ExternalSyncError("unknown", errMessage(e));
					});
			} finally {
				if (this.aborters.get(sub.id) === controller) this.aborters.delete(sub.id);
			}

			if (!this.isCurrent(context)) return this.skippedOutcome(sub);

			const projected = projectOccurrences(occurrences, privacy);
			const content = buildMirrorFile(projected, {
				name: sub.name,
				subscriptionId: sub.id,
				idNamespace: `${sub.accountId} ${sub.collectionKey}`,
				scopeId: sub.scopeId,
			});
			return await this.writeMirrorAndReport(context, content);
		} catch (e) {
			return this.handleSyncFailure(context, e);
		}
	}

	/**
	 * Общий хвост записи (после успешного получения контента, оба вида
	 * источника): запись ТОЛЬКО при изменении, generation-fence вокруг чтения/
	 * записи, cleanupStaleWrite при устаревании прямо на границе записи, учёт
	 * known-путей и onResult ok. Наблюдаемое поведение ics-ветки не меняется —
	 * это дословно прежний хвост performSync.
	 */
	private async writeMirrorAndReport(context: SyncContext, content: string): Promise<SubOutcome> {
		const { sub } = context;
		const path = mirrorPath(sub, context.inboxFile);
		const current = await this.deps.vault.read(path);
		if (!this.isCurrent(context)) return this.skippedOutcome(sub);
		// запись ТОЛЬКО при изменении — не будим Remotely Save на неизменной ленте.
		// Сравниваем без \r: диск мог прийти с CRLF (другой клиент/устройство), а мы
		// всегда пишем LF — иначе бесконечная «перезапись» эквивалентного контента.
		const changed = current === null || stripCr(current) !== stripCr(content);
		if (changed) {
			await this.deps.vault.write(path, content);
		}
		if (!this.isCurrent(context)) {
			await this.cleanupStaleWrite(sub.id, path);
			return this.skippedOutcome(sub);
		}
		this.knownMirrorPaths.set(sub.id, path);
		const at = this.deps.clock.now().getTime();
		this.deps.onResult(sub.id, { ok: true, at });
		return {
			id: sub.id,
			status: changed ? "ok" : "unchanged",
			lastSuccessAt: at,
			errorCode: null,
			changed,
		};
	}

	/** Общая классификация/отчёт об ошибке (оба вида источника): сырой текст —
	 *  только в console-диагностику, персист и UI видят исключительно код. */
	private handleSyncFailure(context: SyncContext, e: unknown): SubOutcome {
		const { sub } = context;
		if (!this.isCurrent(context)) return this.skippedOutcome(sub);
		const error =
			e instanceof ExternalSyncError
				? e
				: new ExternalSyncError(classifyCode(e), errMessage(e));
		this.warn(
			`external sync failed for subscription ${sub.id} [${error.code}]: ${error.message}`,
		);
		this.deps.onResult(sub.id, { ok: false, code: error.code, detail: error.message });
		return {
			id: sub.id,
			status: "error",
			lastSuccessAt: sub.lastSyncAt,
			errorCode: error.code,
			changed: false,
		};
	}

	private isCurrent(context: SyncContext): boolean {
		if (
			this.disposed ||
			this.tombstones.has(context.sub.id) ||
			context.generation !== this.configGeneration
		)
			return false;
		const current = this.deps.subscriptions().find((sub) => sub.id === context.sub.id);
		if (current === undefined || current.name !== context.sub.name) return false;
		// Identity-fence по виду источника. Для ics — прежнее сравнение url.
		// Для caldav сравнивается полный config-fingerprint (accountId,
		// collectionKey, privacy, scopeId, enabled): любое его изменение
		// обесценивает in-flight работу (этап 4 использует это при провайдере).
		if (context.sub.kind === "caldav") {
			return (
				current.kind === "caldav" &&
				current.accountId === context.sub.accountId &&
				current.collectionKey === context.sub.collectionKey &&
				current.privacy === context.sub.privacy &&
				current.scopeId === context.sub.scopeId &&
				current.enabled === context.sub.enabled
			);
		}
		return current.kind !== "caldav" && current.url === context.sub.url;
	}

	private isConfigurationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.configGeneration;
	}

	private async fetchWithDeadline(id: string, url: string): Promise<string> {
		const controller = new AbortController();
		this.aborters.set(id, controller);
		const requested = Promise.resolve().then(() => this.deps.fetch(url, controller.signal));
		const timeoutCandidate = Math.floor(
			this.deps.feedTimeoutMs?.() ?? DEFAULT_SYNC_FEED_TIMEOUT_MS,
		);
		const requestedTimeout = Number.isFinite(timeoutCandidate)
			? Math.max(1, Math.min(5 * 60_000, timeoutCandidate))
			: DEFAULT_SYNC_FEED_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | null = null;
		try {
			return await new Promise<string>((resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(
						new ExternalSyncError(
							"timeout",
							`calendar feed timed out after ${requestedTimeout}ms`,
						),
					);
				}, requestedTimeout);
				requested.then(resolve, reject);
			});
		} finally {
			if (timer !== null) clearTimeout(timer);
			if (this.aborters.get(id) === controller) this.aborters.delete(id);
		}
	}

	private async cleanupStaleWrite(id: string, path: string): Promise<void> {
		const current = this.deps.subscriptions().find((sub) => sub.id === id);
		if (current === undefined || this.tombstones.has(id)) {
			await this.deletePath(path);
			return;
		}
		const desired = mirrorPath(current, this.deps.inboxFile());
		if (desired !== path) await this.deletePath(path);
	}

	private async deletePath(path: string): Promise<void> {
		if (this.deps.vault.delete !== undefined) await this.deps.vault.delete(path);
	}

	private scheduleConfigurationReconcile(): void {
		this.clearReconcileTimer();
		this.reconcileTimer = setTimeout(() => {
			this.reconcileTimer = null;
			void this.reconcileAndSync();
		}, CONFIG_RECONCILE_DEBOUNCE_MS);
	}

	/** Lifecycle fire-and-forget boundary: both phases report and fulfil. */
	private async reconcileAndSync(): Promise<void> {
		try {
			await this.reconcileMirrors();
		} catch (e) {
			this.warn(`Could not reconcile external calendar mirrors: ${errMessage(e)}`);
		}
		try {
			await this.syncAll();
		} catch (e) {
			this.warn(`Could not sync external calendars: ${errMessage(e)}`);
		}
	}

	private clearReconcileTimer(): void {
		if (this.reconcileTimer !== null) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = null;
		}
	}

	private warn(message: string): void {
		try {
			this.deps.onLifecycleWarning?.(message);
		} catch {
			// Diagnostics are observers; they must not create a rejected
			// fire-and-forget lifecycle promise themselves.
		}
	}

	private schedule(): void {
		this.clearTimer();
		const min = Math.max(1, Math.floor(this.deps.intervalMin() || 1));
		this.timer = setTimeout(() => {
			void this.syncAndReschedule();
		}, min * 60_000);
	}

	private async syncAndReschedule(): Promise<void> {
		try {
			await this.syncAll();
		} catch (e) {
			this.warn(`Could not sync external calendars: ${errMessage(e)}`);
		}
		if (this.disposed) return;
		try {
			this.schedule();
		} catch (e) {
			this.warn(`Could not reschedule external calendar sync: ${errMessage(e)}`);
		}
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
