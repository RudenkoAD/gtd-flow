/**
 * Файловый протокол моста внешней синхронизации (§11 CalDAV-заказа, P1).
 *
 * Живой плагин (desktop) и standalone MCP-процесс общаются через
 * device-local каталог ПЛАГИНА: `.obsidian/plugins/gtd-flow/local/`.
 * Учётные данные и CalDAV-клиент НИКОГДА не пересекают эту границу — по
 * файлам ходят только санитизированные ExternalSyncReport и opaque-запросы.
 *
 * Отклонение от черновика плана (задокументировано): инструменты
 * sync_external_calendars/external_sync_status живут в СУЩЕСТВУЮЩЕМ
 * MCP-сервере. §3.2 запрещает делать его вторым CalDAV-КЛИЕНТОМ — файловый
 * протокол этого не делает: сервер не видит ни сети, ни секретов.
 *
 * Защита от репликации vault-sync на чужое устройство (§5.1/D7):
 * - каждый запрос АДРЕСУЕТСЯ конкретному deviceId (его MCP берёт из
 *   status-артефакта ЭТОЙ машины); чужое устройство запросы игнорирует;
 * - TTL: просроченные запросы не исполняются и вычищаются;
 * - status/response несут deviceId исполнителя.
 *
 * Модуль ЧИСТЫЙ (без obsidian и node): его импортируют и плагин, и MCP.
 */
import type { ExternalSyncReport } from "./externalSyncStatus";

export const BRIDGE_FORMAT_VERSION = 1;

/** Каталоги/файлы относительно корня хранилища. */
export const BRIDGE_LOCAL_DIR = ".obsidian/plugins/gtd-flow/local";
export const BRIDGE_STATUS_FILE = `${BRIDGE_LOCAL_DIR}/external-sync-status.json`;
export const BRIDGE_REQUEST_DIR = `${BRIDGE_LOCAL_DIR}/requests`;
export const BRIDGE_RESPONSE_DIR = `${BRIDGE_LOCAL_DIR}/responses`;

/** Запрос старше этого срока не исполняется (защита от повтора/репликации). */
export const BRIDGE_REQUEST_TTL_MS = 120_000;
/** Ответы старше этого срока подлежат уборке. */
export const BRIDGE_RESPONSE_TTL_MS = 10 * 60_000;

export interface BridgeStatusArtifact {
	formatVersion: number;
	/** Стабильный id установки Obsidian, исполнившей последний проход. */
	deviceId: string;
	updatedAt: number;
	report: ExternalSyncReport;
}

export interface BridgeSyncRequest {
	formatVersion: number;
	requestId: string;
	/** Исполнять имеет право ТОЛЬКО устройство с этим id. */
	targetDeviceId: string;
	requestedAt: number;
}

export interface BridgeSyncResponse {
	formatVersion: number;
	requestId: string;
	deviceId: string;
	finishedAt: number;
	report: ExternalSyncReport;
}

export function bridgeRequestPath(requestId: string): string {
	return `${BRIDGE_REQUEST_DIR}/sync-${requestId}.json`;
}

export function bridgeResponsePath(requestId: string): string {
	return `${BRIDGE_RESPONSE_DIR}/sync-${requestId}.json`;
}

const REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{3,63}$/u;

export function isBridgeRequestId(value: unknown): value is string {
	return typeof value === "string" && REQUEST_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed разбор запроса: null — файл игнорируется (и подлежит уборке). */
export function parseBridgeSyncRequest(raw: unknown): BridgeSyncRequest | null {
	if (!isRecord(raw)) return null;
	if (raw["formatVersion"] !== BRIDGE_FORMAT_VERSION) return null;
	const requestId = raw["requestId"];
	const targetDeviceId = raw["targetDeviceId"];
	const requestedAt = raw["requestedAt"];
	if (!isBridgeRequestId(requestId)) return null;
	if (typeof targetDeviceId !== "string" || targetDeviceId === "") return null;
	if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return null;
	return {
		formatVersion: BRIDGE_FORMAT_VERSION,
		requestId,
		targetDeviceId,
		requestedAt,
	};
}

/**
 * Может ли ЭТО устройство исполнить запрос сейчас. Возвращает причину отказа
 * (для диагностики) либо null — исполнять можно.
 */
export function bridgeRequestRefusal(
	request: BridgeSyncRequest,
	deviceId: string,
	nowMs: number,
): "foreign-device" | "expired" | null {
	if (request.targetDeviceId !== deviceId) return "foreign-device";
	if (nowMs - request.requestedAt > BRIDGE_REQUEST_TTL_MS) return "expired";
	if (request.requestedAt - nowMs > BRIDGE_REQUEST_TTL_MS) return "expired"; // часы из будущего
	return null;
}

/**
 * Гейт §11 на последующую vault-sync оркестрацию: по умолчанию продолжать
 * можно ТОЛЬКО при "ok"; partial — лишь с явным force-флагом (и никогда
 * молча: отчёт сохраняет упавшие подписки/коды); error не продолжает никогда.
 */
export function vaultSyncGate(
	report: ExternalSyncReport,
	forcePartial: boolean,
): { proceed: boolean; reason: "ok" | "forced-partial" | "partial" | "error" } {
	if (report.status === "ok") return { proceed: true, reason: "ok" };
	if (report.status === "partial")
		return forcePartial
			? { proceed: true, reason: "forced-partial" }
			: { proceed: false, reason: "partial" };
	return { proceed: false, reason: "error" };
}
