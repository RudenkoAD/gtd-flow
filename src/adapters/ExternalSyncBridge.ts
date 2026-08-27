/**
 * ExternalSyncBridge — ПЛАГИН-сторона файлового протокола моста внешней
 * синхронизации (§11 CalDAV-заказа, P1; см. модульный докблок
 * src/sync/bridgeProtocol.ts). Живёт в основном процессе Obsidian и общается
 * со standalone MCP-процессом ТОЛЬКО через device-local каталог
 * `.obsidian/plugins/gtd-flow/local/`.
 *
 * Модуль ЧИСТЫЙ: ни obsidian, ни node не импортируются. Файловый доступ
 * приходит узким портом `BridgeFsPort` — main.ts маппит его на
 * `app.vault.adapter` (dot-путь, как и остальной `.obsidian/**`, см.
 * VaultAdapter). Это позволяет тестировать мост на голом node/vitest поверх
 * fake-реализации порта.
 *
 * Инвариант защиты от репликации vault-sync (§5.1/D7): запрос, адресованный
 * ЧУЖОМУ deviceId, НИКОГДА не удаляется и не исполняется этим процессом —
 * файл может ещё доехать (через vault sync) до устройства, которому он
 * реально предназначен. Трогать чужие файлы значило бы разрушить протокол
 * для другой машины.
 */
import {
	BRIDGE_FORMAT_VERSION,
	BRIDGE_LOCAL_DIR,
	BRIDGE_REQUEST_DIR,
	BRIDGE_RESPONSE_DIR,
	BRIDGE_RESPONSE_TTL_MS,
	BRIDGE_STATUS_FILE,
	bridgeRequestRefusal,
	bridgeResponsePath,
	parseBridgeSyncRequest,
} from "../sync/bridgeProtocol";
import type {
	BridgeStatusArtifact,
	BridgeSyncRequest,
	BridgeSyncResponse,
} from "../sync/bridgeProtocol";
import type { ExternalSyncReport } from "../sync/externalSyncStatus";

/** Узкий срез Obsidian DataAdapter (app.vault.adapter) для dot-путей. */
export interface BridgeFsPort {
	/** Бросает, если файла нет. */
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Форма DataAdapter.list: files — ПОЛНЫЕ пути. */
	list(dirPath: string): Promise<{ files: string[]; folders: string[] }>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export interface ExternalSyncBridgeDeps {
	fs: BridgeFsPort;
	deviceId: string;
	/** Запустить полный проход и дождаться терминального отчёта. */
	syncAll: () => Promise<ExternalSyncReport>;
	now?: () => number;
	onWarning?: (message: string) => void;
}

const SYNC_FILE_NAME_RE = /^sync-.*\.json$/u;

function fileBaseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Минимальная fail-closed форма ответа, нужная только для уборки (§11 п.5):
 * deviceId — чей ответ, finishedAt — для сравнения с TTL. Полный отчёт внутри
 * не перепроверяется — этот файл пишет только сам мост.
 */
function parseResponseEnvelope(raw: unknown): { deviceId: string; finishedAt: number } | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	if (record["formatVersion"] !== BRIDGE_FORMAT_VERSION) return null;
	const deviceId = record["deviceId"];
	const finishedAt = record["finishedAt"];
	if (typeof deviceId !== "string" || deviceId === "") return null;
	if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt)) return null;
	return { deviceId, finishedAt };
}

export class ExternalSyncBridge {
	private readonly fs: BridgeFsPort;
	private readonly deviceId: string;
	private readonly syncAll: () => Promise<ExternalSyncReport>;
	private readonly now: () => number;
	private readonly onWarning: ((message: string) => void) | undefined;

	constructor(deps: ExternalSyncBridgeDeps) {
		this.fs = deps.fs;
		this.deviceId = deps.deviceId;
		this.syncAll = deps.syncAll;
		this.now = deps.now ?? (() => Date.now());
		this.onWarning = deps.onWarning;
	}

	/**
	 * Записать status-артефакт (вызывается из SyncDeps.onReport и при старте).
	 * Идемпотентно (перезаписывает целиком), ошибки — в onWarning, никогда не
	 * бросает.
	 */
	async publishStatus(report: ExternalSyncReport): Promise<void> {
		try {
			await this.tryMkdir(BRIDGE_LOCAL_DIR);
			const artifact: BridgeStatusArtifact = {
				formatVersion: BRIDGE_FORMAT_VERSION,
				deviceId: this.deviceId,
				updatedAt: this.now(),
				report,
			};
			await this.fs.write(BRIDGE_STATUS_FILE, serializeJson(artifact));
		} catch {
			this.warn("bridge status artifact could not be published");
		}
	}

	/**
	 * Один проход обработки каталога запросов (§11 п.11 + D7):
	 *  1. исполнить адресованные нам свежие запросы (по одному, СТРОГО
	 *     последовательно — никаких параллельных syncAll-штормов);
	 *  2. записать ответы, вычистить чужие файлы НЕ трогая их вовсе;
	 *  3. просроченные СВОИ запросы — удалить без исполнения;
	 *  4. вычистить свои старые ответы (BRIDGE_RESPONSE_TTL_MS).
	 * Ошибки — в onWarning; никогда не бросает. Возвращает число реально
	 * исполненных (успешных syncAll) запросов.
	 */
	async processRequests(): Promise<number> {
		await this.tryMkdir(BRIDGE_LOCAL_DIR);
		await this.tryMkdir(BRIDGE_REQUEST_DIR);
		await this.tryMkdir(BRIDGE_RESPONSE_DIR);

		const requestFiles = await this.listMatching(BRIDGE_REQUEST_DIR);
		const executable: Array<{ file: string; request: BridgeSyncRequest }> = [];

		for (const file of requestFiles) {
			const request = await this.readRequest(file);
			if (request === null) continue;

			const refusal = bridgeRequestRefusal(request, this.deviceId, this.now());
			if (refusal === "foreign-device") {
				// Защита от репликации (§5.1/D7): чужой файл не трогаем вообще —
				// vault sync может ещё доставить его на предназначенное устройство.
				continue;
			}
			if (refusal === "expired") {
				await this.tryRemove(file);
				continue;
			}
			executable.push({ file, request });
		}

		let executed = 0;
		for (const { file, request } of executable) {
			if (await this.executeRequest(file, request)) executed += 1;
		}

		await this.cleanupResponses();
		return executed;
	}

	/** read+JSON.parse и разбор формы запроса; при провале — файл удаляется. */
	private async readRequest(file: string): Promise<BridgeSyncRequest | null> {
		let parsed: unknown;
		try {
			const raw = await this.fs.read(file);
			parsed = JSON.parse(raw);
		} catch {
			this.warn(`bridge request file could not be read: ${fileBaseName(file)}`);
			await this.tryRemove(file);
			return null;
		}
		const request = parseBridgeSyncRequest(parsed);
		if (request === null) {
			this.warn(`bridge request file has an invalid shape: ${fileBaseName(file)}`);
			await this.tryRemove(file);
			return null;
		}
		return request;
	}

	/**
	 * Исполнить один запрос: await syncAll(), записать ответ, удалить файл
	 * запроса. syncAll отклонён -> предупреждение, ответ НЕ пишется, запрос всё
	 * равно удаляется (MCP-сторона сама словит таймаут по bridgeResponsePath).
	 * Возвращает true, только если syncAll реально выполнился.
	 */
	private async executeRequest(file: string, request: BridgeSyncRequest): Promise<boolean> {
		let report: ExternalSyncReport;
		try {
			report = await this.syncAll();
		} catch {
			this.warn(`bridge sync failed for request ${request.requestId}`);
			await this.tryRemove(file);
			return false;
		}

		const response: BridgeSyncResponse = {
			formatVersion: BRIDGE_FORMAT_VERSION,
			requestId: request.requestId,
			deviceId: this.deviceId,
			finishedAt: this.now(),
			report,
		};
		try {
			await this.fs.write(bridgeResponsePath(request.requestId), serializeJson(response));
		} catch {
			this.warn(`bridge response could not be written for request ${request.requestId}`);
		}
		await this.tryRemove(file);
		return true;
	}

	/** Вычистить свои ответы старше BRIDGE_RESPONSE_TTL_MS; чужие не трогать. */
	private async cleanupResponses(): Promise<void> {
		const files = await this.listMatching(BRIDGE_RESPONSE_DIR);
		const now = this.now();

		for (const file of files) {
			let parsed: unknown;
			try {
				const raw = await this.fs.read(file);
				parsed = JSON.parse(raw);
			} catch {
				await this.tryRemove(file);
				continue;
			}
			const envelope = parseResponseEnvelope(parsed);
			if (envelope === null) {
				await this.tryRemove(file);
				continue;
			}
			if (envelope.deviceId !== this.deviceId) continue; // чужой ответ — не наш к уборке
			if (now - envelope.finishedAt > BRIDGE_RESPONSE_TTL_MS) await this.tryRemove(file);
		}
	}

	private async listMatching(dir: string): Promise<string[]> {
		try {
			const listed = await this.fs.list(dir);
			return listed.files.filter((file) => SYNC_FILE_NAME_RE.test(fileBaseName(file))).sort();
		} catch {
			this.warn(`bridge could not list directory: ${dir}`);
			return [];
		}
	}

	private async tryMkdir(path: string): Promise<void> {
		try {
			await this.fs.mkdir(path);
		} catch {
			// каталог уже существует или создание не требуется — не фатально
		}
	}

	private async tryRemove(path: string): Promise<void> {
		try {
			await this.fs.remove(path);
		} catch {
			this.warn(`bridge could not remove file: ${fileBaseName(path)}`);
		}
	}

	private warn(message: string): void {
		try {
			this.onWarning?.(message);
		} catch {
			// наблюдатель не имеет права ронять мост
		}
	}
}

function randomBase36(length: number): string {
	let out = "";
	while (out.length < length) out += Math.random().toString(36).slice(2);
	return out.slice(0, length);
}

/**
 * Стабильный deviceId установки. `app.appId` — предпочтительный источник
 * (обычно доступен); иначе — персистентный fallback через переданное
 * хранилище (генерируется и записывается один раз); без fallbackStore —
 * генерируется заново каждый вызов (непостоянно, но лучше, чем ничего).
 */
export function bridgeDeviceIdOf(
	app: unknown,
	fallbackStore?: { get(): string | null; set(id: string): void },
): string {
	if (typeof app === "object" && app !== null) {
		const appId = (app as { appId?: unknown }).appId;
		if (typeof appId === "string" && appId !== "") return appId;
	}

	const existing = fallbackStore?.get();
	if (typeof existing === "string" && existing !== "") return existing;

	const generated = `dev-${randomBase36(12)}`;
	fallbackStore?.set(generated);
	return generated;
}
