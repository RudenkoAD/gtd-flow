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
import type { ExternalCalendarSub } from "../settings/Settings";
import { buildMirrorFile } from "./mirrorBuilder";
import { mirrorWindow, parseIcs } from "./icsParse";

/** Итог синхронизации одной подписки (пишется в статус). */
export type SyncResult = { ok: true; at: number } | { ok: false; error: string };

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
	/** Актуальный список подписок (читается на каждый проход из настроек). */
	subscriptions: () => readonly ExternalCalendarSub[];
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
export function mirrorPath(sub: ExternalCalendarSub, inboxFile: string): string {
	const file = `${EXTERNAL_DIR}/${safeMirrorFileName(sub.name)}-${subIdSlug(sub.id)}.md`;
	return underInboxParent(inboxFile, file);
}

/** Pre-stable-id releases used this name-only form.  It is only used to
 * recognise a safe one-time migration candidate, never to delete an arbitrary
 * user-created `gtd-external` note. */
function legacyMirrorPath(sub: ExternalCalendarSub, inboxFile: string): string {
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
	// статус — короткая строка в настройках; длинные тела ответов не тащим
	return msg.length > 200 ? msg.slice(0, 197) + "…" : msg;
}

/** Убрать все \r (для сравнения диска и генерируемого контента без CRLF-шума). */
function stripCr(s: string): string {
	return s.replace(/\r/g, "");
}

interface SyncContext {
	sub: ExternalCalendarSub;
	generation: number;
	inboxFile: string;
}

export class SyncService {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	private activeSyncAll: Promise<void> | null = null;
	private disposed = false;
	/** Any settings/path mutation bumps this fence.  A stale async operation can
	 * finish, but cannot write or report success after the fence moved. */
	private configGeneration = 0;
	/** Deleted ids stay fenced even if their old object remains temporarily in a
	 * settings array while the vault trash operation awaits. */
	private readonly tombstones = new Set<string>();
	private readonly inFlight = new Map<string, { generation: number; promise: Promise<void> }>();
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

	/** Синхронизировать ВСЕ подписки (команда палитры / кнопка «Синхронизировать сейчас»).
	 *  Перекрывающиеся вызовы разделяют ОДИН и тот же Promise: второй вызывающий
	 *  действительно ждёт результат, а не получает ложный «no-op». */
	async syncAll(): Promise<void> {
		if (this.disposed) return;
		if (this.activeSyncAll !== null) return this.activeSyncAll;
		// One shared run drains configuration generations: if settings change
		// while an old snapshot is syncing, callers keep awaiting this same
		// promise until a fresh current-generation pass has also completed.
		const run = this.runAllUntilCurrentConfiguration();
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
	 *  Гонки с тиком/повторным кликом снимает per-sub гейт внутри syncOne. */
	async syncById(id: string): Promise<void> {
		const sub = this.deps.subscriptions().find((s) => s.id === id);
		if (sub !== undefined && !this.tombstones.has(id)) await this.syncOne({ ...sub });
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
	async deleteMirror(sub: ExternalCalendarSub): Promise<void> {
		const path = mirrorPath(sub, this.deps.inboxFile());
		await this.deletePath(path);
		if (this.knownMirrorPaths.get(sub.id) === path) this.knownMirrorPaths.delete(sub.id);
	}

	/** Remove a subscription safely: tombstone and abort before touching the
	 * mirror, so a delayed fetch cannot recreate it during the UI's delete flow. */
	async removeSubscription(sub: ExternalCalendarSub): Promise<void> {
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

		const discovered = await this.deps.vault.listManagedMirrors?.();
		if (!this.isConfigurationCurrent(generation)) return;
		if (discovered !== undefined) {
			for (const mirror of discovered) {
				if (!this.isConfigurationCurrent(generation)) return;
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

	private async runAll(): Promise<void> {
		const subs = this.deps.subscriptions().map((sub) => ({ ...sub }));
		const requested = Math.floor(
			this.deps.maxConcurrentFeeds?.() ?? DEFAULT_MAX_CONCURRENT_FEEDS,
		);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(8, requested))
			: DEFAULT_MAX_CONCURRENT_FEEDS;
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (!this.disposed) {
				const sub = subs[cursor++];
				if (sub === undefined) return;
				await this.syncOne(sub);
			}
		};
		await Promise.allSettled(
			Array.from({ length: Math.min(limit, subs.length) }, () => worker()),
		);
	}

	/** Complete at least one pass for the latest stable configuration. */
	private async runAllUntilCurrentConfiguration(): Promise<void> {
		while (!this.disposed) {
			const generation = this.configGeneration;
			await this.runAll();
			if (generation === this.configGeneration) return;
		}
	}

	private syncOne(sub: ExternalCalendarSub): Promise<void> {
		if (this.disposed || this.tombstones.has(sub.id)) return Promise.resolve();
		const existing = this.inFlight.get(sub.id);
		if (existing !== undefined && existing.generation === this.configGeneration)
			return existing.promise;
		const context: SyncContext = {
			sub,
			generation: this.configGeneration,
			inboxFile: this.deps.inboxFile(),
		};
		const promise = this.performSync(context);
		this.inFlight.set(sub.id, { generation: context.generation, promise });
		const clearInFlight = (): void => {
			if (this.inFlight.get(sub.id)?.promise === promise) this.inFlight.delete(sub.id);
		};
		void promise.then(clearInFlight, clearInFlight);
		return promise;
	}

	private async performSync(context: SyncContext): Promise<void> {
		const { sub } = context;
		try {
			const raw = sub.url.trim();
			if (raw === "") throw new Error("не задан адрес ленты");
			// webcal:// — тот же HTTP(S)-ресурс под iCal-схемой «Подписаться» (Apple/Google):
			// нормализуем к https перед сетевым запросом (requestUrl схему webcal не понимает).
			const url = raw.replace(/^webcal:\/\//i, "https://");
			const text = await this.fetchWithDeadline(sub.id, url);
			if (!this.isCurrent(context)) return;
			const occurrences = parseIcs(text, mirrorWindow(this.deps.clock.now()));
			if (!this.isCurrent(context)) return;
			const content = buildMirrorFile(occurrences, {
				name: sub.name,
				subscriptionId: sub.id,
			});
			const path = mirrorPath(sub, context.inboxFile);
			const current = await this.deps.vault.read(path);
			if (!this.isCurrent(context)) return;
			// запись ТОЛЬКО при изменении — не будим Remotely Save на неизменной ленте.
			// Сравниваем без \r: диск мог прийти с CRLF (другой клиент/устройство), а мы
			// всегда пишем LF — иначе бесконечная «перезапись» эквивалентного контента.
			if (current === null || stripCr(current) !== stripCr(content)) {
				await this.deps.vault.write(path, content);
			}
			if (!this.isCurrent(context)) {
				await this.cleanupStaleWrite(sub.id, path);
				return;
			}
			this.knownMirrorPaths.set(sub.id, path);
			this.deps.onResult(sub.id, { ok: true, at: this.deps.clock.now().getTime() });
		} catch (e) {
			if (!this.isCurrent(context)) return;
			this.deps.onResult(sub.id, { ok: false, error: errMessage(e) });
		}
	}

	private isCurrent(context: SyncContext): boolean {
		if (
			this.disposed ||
			this.tombstones.has(context.sub.id) ||
			context.generation !== this.configGeneration
		)
			return false;
		const current = this.deps.subscriptions().find((sub) => sub.id === context.sub.id);
		return (
			current !== undefined &&
			current.name === context.sub.name &&
			current.url === context.sub.url
		);
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
					reject(new Error(`calendar feed timed out after ${requestedTimeout}ms`));
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
