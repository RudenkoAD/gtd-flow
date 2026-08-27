/**
 * MCP-сторона файлового моста внешней синхронизации (§11 CalDAV-заказа, P1).
 *
 * Standalone MCP-процесс не имеет CalDAV-клиента и не должен его заводить
 * (§3.2) — вместо этого он читает/пишет тот же device-local файловый протокол,
 * что определён в ../sync/bridgeProtocol, и ждёт, пока ЖИВОЙ Obsidian с
 * работающим плагином не исполнит запрос и не оставит терминальный ответ.
 *
 * dispatch ≠ success (§11): просто записать запрос недостаточно — инструмент
 * обязан дождаться response-файла (или истечения таймаута) и вернуть именно
 * терминальный исход, иначе агент решит, что синхронизация прошла, хотя
 * плагин мог быть не запущен вовсе.
 *
 * Никакие секреты/сеть сюда не попадают: по файлам ходят только opaque-запрос
 * и уже санитизированный ExternalSyncReport. Разбор ответов и status-артефакта
 * fail-closed — повреждённый/чужой файл трактуется как отсутствие результата,
 * а не как повод угадать его форму; сырое содержимое файла никогда не попадает
 * в текст ошибки.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	BRIDGE_FORMAT_VERSION,
	BRIDGE_STATUS_FILE,
	bridgeRequestPath,
	bridgeResponsePath,
	vaultSyncGate,
	type BridgeSyncRequest,
	type BridgeSyncResponse,
} from "../sync/bridgeProtocol";
import {
	EXTERNAL_SYNC_ERROR_CODES,
	type ExternalSubscriptionReport,
	type ExternalSubscriptionSyncStatus,
	type ExternalSyncErrorCode,
	type ExternalSyncReport,
} from "../sync/externalSyncStatus";

export interface BridgeToolsDeps {
	vaultRoot: string;
	/** Инъекция времени для тестов; иначе Date.now. */
	now?: () => number;
	/** Инъекция задержки опроса для тестов; иначе реальный setTimeout. */
	sleep?: (ms: number) => Promise<void>;
}

export type ReadExternalSyncStatusResult =
	| { available: false; reason: "no-status" | "invalid-status" }
	| { available: true; deviceId: string; updatedAt: number; report: ExternalSyncReport };

export interface SyncViaBridgeResult {
	outcome: "completed" | "plugin-unavailable" | "timeout";
	report?: ExternalSyncReport;
	vaultSync?: { proceed: boolean; reason: "ok" | "forced-partial" | "partial" | "error" };
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 500;

const REPORT_STATUSES = new Set<ExternalSyncReport["status"]>(["ok", "partial", "error"]);
const SUBSCRIPTION_STATUSES = new Set<ExternalSubscriptionSyncStatus>([
	"ok",
	"unchanged",
	"error",
	"skipped",
]);
const ERROR_CODES = new Set<string>(EXTERNAL_SYNC_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed разбор терминального отчёта прохода: null — файл не доверяем. */
function parseExternalSyncReport(raw: unknown): ExternalSyncReport | null {
	if (!isRecord(raw)) return null;
	const status = raw["status"];
	if (typeof status !== "string" || !REPORT_STATUSES.has(status as ExternalSyncReport["status"]))
		return null;
	const startedAt = raw["startedAt"];
	const finishedAt = raw["finishedAt"];
	const changedMirrors = raw["changedMirrors"];
	const subscriptionsRaw = raw["subscriptions"];
	if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
	if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt)) return null;
	if (typeof changedMirrors !== "number" || !Number.isFinite(changedMirrors)) return null;
	if (!Array.isArray(subscriptionsRaw)) return null;

	const subscriptions: ExternalSubscriptionReport[] = [];
	for (const item of subscriptionsRaw) {
		if (!isRecord(item)) return null;
		const id = item["id"];
		const subStatus = item["status"];
		const lastSuccessAt = item["lastSuccessAt"];
		const errorCode = item["errorCode"];
		if (typeof id !== "string" || id === "") return null;
		if (
			typeof subStatus !== "string" ||
			!SUBSCRIPTION_STATUSES.has(subStatus as ExternalSubscriptionSyncStatus)
		)
			return null;
		if (
			lastSuccessAt !== null &&
			(typeof lastSuccessAt !== "number" || !Number.isFinite(lastSuccessAt))
		)
			return null;
		if (errorCode !== null && (typeof errorCode !== "string" || !ERROR_CODES.has(errorCode)))
			return null;
		subscriptions.push({
			id,
			status: subStatus as ExternalSubscriptionSyncStatus,
			lastSuccessAt,
			errorCode: errorCode as ExternalSyncErrorCode | null,
		});
	}
	return {
		status: status as ExternalSyncReport["status"],
		startedAt,
		finishedAt,
		changedMirrors,
		subscriptions,
	};
}

/** Fail-closed разбор status-артефакта (§11). */
function parseBridgeStatusArtifact(
	raw: unknown,
): { deviceId: string; updatedAt: number; report: ExternalSyncReport } | null {
	if (!isRecord(raw)) return null;
	if (raw["formatVersion"] !== BRIDGE_FORMAT_VERSION) return null;
	const deviceId = raw["deviceId"];
	const updatedAt = raw["updatedAt"];
	if (typeof deviceId !== "string" || deviceId === "") return null;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
	const report = parseExternalSyncReport(raw["report"]);
	if (report === null) return null;
	return { deviceId, updatedAt, report };
}

/** Fail-closed разбор ответа плагина; requestId должен совпасть с нашим запросом. */
function parseBridgeSyncResponse(raw: unknown, requestId: string): BridgeSyncResponse | null {
	if (!isRecord(raw)) return null;
	if (raw["formatVersion"] !== BRIDGE_FORMAT_VERSION) return null;
	if (raw["requestId"] !== requestId) return null;
	const deviceId = raw["deviceId"];
	const finishedAt = raw["finishedAt"];
	if (typeof deviceId !== "string" || deviceId === "") return null;
	if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt)) return null;
	const report = parseExternalSyncReport(raw["report"]);
	if (report === null) return null;
	return { formatVersion: BRIDGE_FORMAT_VERSION, requestId, deviceId, finishedAt, report };
}

/** Vault-относительный путь протокола (прямые слэши) → абсолютный путь ФС. */
function absolutePath(vaultRoot: string, relPosix: string): string {
	return path.join(vaultRoot, ...relPosix.split("/"));
}

function currentTime(deps: BridgeToolsDeps): number {
	return (deps.now ?? Date.now)();
}

function wait(deps: BridgeToolsDeps, ms: number): Promise<void> {
	return (deps.sleep ?? defaultSleep)(ms);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function makeRequestId(deps: BridgeToolsDeps): string {
	const time = Math.max(0, Math.trunc(currentTime(deps))).toString(36);
	const random = randomBytes(4).toString("hex");
	return `req-${time}-${random}`;
}

/**
 * Прочитать status-артефакт плагина этой машины. Отсутствие файла означает,
 * что плагин на этом устройстве ещё ни разу не проходил синхронизацию — цели
 * для запроса (deviceId) взять неоткуда. Повреждённый/непрочитанный файл
 * трактуется так же fail-closed, как и отсутствующий: содержимое файла в
 * ошибку не попадает никогда.
 */
export async function readExternalSyncStatus(
	deps: BridgeToolsDeps,
): Promise<ReadExternalSyncStatusResult> {
	const statusPath = absolutePath(deps.vaultRoot, BRIDGE_STATUS_FILE);
	let text: string;
	try {
		text = await fs.readFile(statusPath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return { available: false, reason: "no-status" };
		}
		return { available: false, reason: "invalid-status" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { available: false, reason: "invalid-status" };
	}
	const artifact = parseBridgeStatusArtifact(parsed);
	if (artifact === null) return { available: false, reason: "invalid-status" };
	return { available: true, ...artifact };
}

async function tryReadResponse(
	responsePath: string,
	requestId: string,
): Promise<BridgeSyncResponse | null> {
	let text: string;
	try {
		text = await fs.readFile(responsePath, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return parseBridgeSyncResponse(parsed, requestId);
}

/**
 * Запустить проход внешней синхронизации в живом Obsidian через файловый мост
 * и ДОЖДАТЬСЯ терминального отчёта (§11: dispatch ≠ success).
 *
 * 1. Без действующего status-артефакта (плагин на этой машине ни разу не
 *    прогонялся) запрос не пишется вовсе — адресовать его некому.
 * 2. Иначе пишем opaque-запрос, адресованный deviceId ЭТОЙ машины (защита от
 *    репликации на чужое устройство, §5.1/D7).
 * 3. Опрашиваем response-файл каждые 500мс до истечения таймаута; успешный
 *    ответ удаляется best-effort и решение по vault-sync считается через
 *    vaultSyncGate.
 * 4. По таймауту наш запрос удаляется best-effort (TTL и так его исключит,
 *    но не оставлять его — гигиена, чтобы более поздний запуск плагина не
 *    исполнил протухший запрос).
 */
export async function syncExternalCalendarsViaBridge(
	deps: BridgeToolsDeps,
	options: { timeoutMs?: number; forcePartial?: boolean } = {},
): Promise<SyncViaBridgeResult> {
	const status = await readExternalSyncStatus(deps);
	if (!status.available) return { outcome: "plugin-unavailable" };

	const timeoutMs = clamp(
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		MIN_TIMEOUT_MS,
		MAX_TIMEOUT_MS,
	);
	const forcePartial = options.forcePartial ?? false;

	const requestId = makeRequestId(deps);
	const requestPath = absolutePath(deps.vaultRoot, bridgeRequestPath(requestId));
	const responsePath = absolutePath(deps.vaultRoot, bridgeResponsePath(requestId));
	const request: BridgeSyncRequest = {
		formatVersion: BRIDGE_FORMAT_VERSION,
		requestId,
		targetDeviceId: status.deviceId,
		requestedAt: currentTime(deps),
	};
	await fs.mkdir(path.dirname(requestPath), { recursive: true });
	await fs.writeFile(requestPath, JSON.stringify(request), "utf8");

	const deadline = currentTime(deps) + timeoutMs;
	for (;;) {
		const response = await tryReadResponse(responsePath, requestId);
		if (response !== null) {
			await fs.rm(responsePath, { force: true }).catch(() => undefined);
			return {
				outcome: "completed",
				report: response.report,
				vaultSync: vaultSyncGate(response.report, forcePartial),
			};
		}
		if (currentTime(deps) >= deadline) {
			await fs.rm(requestPath, { force: true }).catch(() => undefined);
			return { outcome: "timeout" };
		}
		await wait(deps, POLL_INTERVAL_MS);
	}
}
