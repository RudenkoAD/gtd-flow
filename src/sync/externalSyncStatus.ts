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
