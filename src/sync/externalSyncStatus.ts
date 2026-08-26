/**
 * Санитизированный статус внешней синхронизации (§5.2/§10 CalDAV-заказа).
 *
 * Единственный словарь ошибок, который разрешено персистить/показывать/отдавать
 * автоматизации. Сырые тексты исключений (URL, тела ответов, заголовки) НЕ
 * имеют права попадать ни в data.json, ни в Notice, ни в консоль для
 * CalDAV-путей — только код из этого замкнутого списка плюс статическая
 * подсказка. Модуль чистый: без obsidian и без node-специфики, им пользуются
 * settings/SyncService/MCP-контракты.
 */

export const EXTERNAL_SYNC_ERROR_CODES = [
	"credential_missing",
	"authentication_failed",
	"forbidden",
	"discovery_failed",
	"collection_missing",
	"scope_missing",
	"rate_limited",
	"network_error",
	"timeout",
	"invalid_xml",
	"invalid_calendar_data",
	"response_too_large",
	"unsupported_server",
	"unknown",
] as const;

export type ExternalSyncErrorCode = (typeof EXTERNAL_SYNC_ERROR_CODES)[number];

/**
 * Статус одной подписки в терминальном отчёте прохода.
 *
 * "skipped" — расширение относительно §10 заказа (там ok|unchanged|error):
 * зафиксированное отклонение. Проход обязан отчитаться о КАЖДОЙ подписке, а
 * подписка может быть законно не тронута: снята fence'ом поколения
 * конфигурации, выключена, в draft-состоянии privacy "unconfigured" или её
 * вид ещё не поддерживается. Молчание вместо статуса — ровно та путаница
 * «dispatch ≠ success», которую §10 запрещает.
 */
export type ExternalSubscriptionSyncStatus = "ok" | "unchanged" | "error" | "skipped";

export interface ExternalSubscriptionReport {
	id: string;
	status: ExternalSubscriptionSyncStatus;
	/** Epoch-мс последнего успешного завершения (включая прошлые проходы). */
	lastSuccessAt: number | null;
	errorCode: ExternalSyncErrorCode | null;
}

/** Терминальный отчёт целого прохода (§10). Никаких сырых строк/URL/имён. */
export interface ExternalSyncReport {
	status: "ok" | "partial" | "error";
	startedAt: number;
	finishedAt: number;
	changedMirrors: number;
	subscriptions: readonly ExternalSubscriptionReport[];
}

/**
 * Коды, которые НЕЛЬЗЯ персистить в общий data.json: они описывают состояние
 * ЭТОГО устройства (наличие/валидность локального секрета) и не должны
 * затирать durable-статус успешной синхронизации другого устройства (§5.1).
 * Живут только в runtime-статусе текущего процесса Obsidian.
 */
export const DEVICE_LOCAL_ERROR_CODES: ReadonlySet<ExternalSyncErrorCode> = new Set([
	"credential_missing",
	"authentication_failed",
] as const);

/**
 * Типизированная ошибка синхронизации: единственный способ пронести причину
 * через границы стадий. `message` обязан быть безопасным (код/статическая
 * фраза) — CalDAV-код не имеет права класть сюда URL, тела ответов или
 * заголовки; для legacy-ICS допускается прежний сырой текст, но он идёт
 * ТОЛЬКО в console-диагностику, никогда в data.json/Notice.
 */
export class ExternalSyncError extends Error {
	constructor(
		readonly code: ExternalSyncErrorCode,
		message?: string,
	) {
		super(message ?? code);
		this.name = "ExternalSyncError";
	}
}

/**
 * Runtime-состояние подписки для UI (§9: семь различимых состояний; общий
 * "partial" выводится из ExternalSyncReport). Не персистится.
 */
export type ExternalRuntimeState =
	"neverAttempted" | "syncing" | "okUnchanged" | "okChanged" | "error";

export interface ExternalRuntimeStatus {
	state: ExternalRuntimeState;
	errorCode: ExternalSyncErrorCode | null;
	/** Epoch-мс начала последней попытки в этом процессе; null — попыток не было. */
	lastAttemptAt: number | null;
}

export const NEVER_ATTEMPTED_STATUS: ExternalRuntimeStatus = Object.freeze({
	state: "neverAttempted",
	errorCode: null,
	lastAttemptAt: null,
});
