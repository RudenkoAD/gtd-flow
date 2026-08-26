/**
 * Узловой HTTP-адаптер CalDAV-порта (§6.3 CalDAV-заказа) — единственная
 * реализация CalDavHttpPort с настоящим сетевым вводом-выводом. node:http и
 * node:https подключаются ЛЕНИВО, внутри выполнения запроса: верхнеуровневый
 * value-import уронил бы плагин на мобильных платформах, где Node
 * недоступен (см. scripts/check-packaged-plugin.mjs и прецедент
 * DesktopOpenRouterOAuth.ts). Типы этих модулей импортировать наверху можно —
 * `import type` стирается компилятором и в бандл не попадает.
 *
 * Инварианты (не смягчать без пересмотра CalDAV-заказа):
 * - редирект на ДРУГОЙ origin никогда не выполняется: цель редиректа не
 *   получает ни одного сетевого обращения — иначе Authorization утёк бы на
 *   чужой сервер даже без общего заголовка;
 * - same-origin редиректы следуются, но не больше 3 хопов суммарно на вызов
 *   порта; 303 переключает метод на GET и роняет тело, 301/302/307/308
 *   сохраняют метод и тело (CalDAV-серверы используют их для канонизации
 *   пути PROPFIND/REPORT);
 * - deadlineMs — жёсткий предел на ВСЮ цепочку редиректов, а не на один хоп;
 *   AbortSignal обрывает запрос раньше, включая уже-отменённый сигнал;
 * - тело ответа обрезано по байтам (по умолчанию 16 МиБ) fail-closed;
 * - ни одна ошибка адаптера не несёт в сообщении URL, заголовки или тело —
 *   только код ExternalSyncError и статическая фраза (§5.2 заказа);
 * - ни одного повтора попытки: один хоп — ровно один сетевой запрос.
 */
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { ExternalSyncError } from "../externalSyncStatus";
import type { CalDavHttpPort, CalDavHttpRequest, CalDavHttpResponse } from "./httpPort";

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MIN_DEADLINE_MS = 1;
const MAX_DEADLINE_MS = 300_000;
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface NodeHttpAdapterOptions {
	/** Байтовый предел тела ответа. По умолчанию 16 МиБ (§6.3 заказа). */
	maxResponseBytes?: number;
}

/** Собрать production-адаптер CalDavHttpPort поверх node:http(s). */
export function createNodeHttpAdapter(options: NodeHttpAdapterOptions = {}): CalDavHttpPort {
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	return (request) => performRequest(request, maxResponseBytes);
}

interface HopResult {
	status: number;
	headers: Record<string, string>;
	buffer: Buffer;
	locationHeader: string | null;
}

function clampDeadline(deadlineMs: number): number {
	if (!Number.isFinite(deadlineMs)) return MAX_DEADLINE_MS;
	return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, deadlineMs));
}

async function performRequest(
	request: CalDavHttpRequest,
	maxResponseBytes: number,
): Promise<CalDavHttpResponse> {
	if (request.signal?.aborted) {
		throw new ExternalSyncError("timeout", "caldav request aborted");
	}

	let currentUrl: URL;
	try {
		currentUrl = new URL(request.url);
	} catch {
		throw new ExternalSyncError("network_error", "invalid request URL");
	}
	const originalOrigin = currentUrl.origin;

	let method: CalDavHttpRequest["method"] = request.method;
	let body: string | undefined = request.body;

	// `activeRequest` пересоздаётся на каждом хопе; таймер дедлайна и обработчик
	// AbortSignal живут ОДИН раз на весь вызов и обрывают текущий in-flight запрос.
	let activeRequest: ClientRequest | null = null;
	let cancelReason: ExternalSyncError | null = null;

	const setActiveRequest = (req: ClientRequest | null): void => {
		activeRequest = req;
		// Отмена могла случиться, пока запрос ещё создавался (например, во время
		// ленивого import модуля) — тогда destroy() нужно применить прямо сейчас.
		if (req !== null && cancelReason !== null) req.destroy();
	};

	const deadlineTimer = setTimeout(() => {
		cancelReason = new ExternalSyncError("timeout", "caldav request timed out");
		activeRequest?.destroy();
	}, clampDeadline(request.deadlineMs));

	const onAbort = (): void => {
		cancelReason = new ExternalSyncError("timeout", "caldav request aborted");
		activeRequest?.destroy();
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		let hopsFollowed = 0;
		for (;;) {
			if (cancelReason !== null) throw cancelReason;

			let hopResult: HopResult;
			try {
				hopResult = await issueHop(
					currentUrl,
					method,
					request.headers,
					body,
					maxResponseBytes,
					setActiveRequest,
					() => cancelReason,
				);
			} finally {
				setActiveRequest(null);
			}
			if (cancelReason !== null) throw cancelReason;

			if (!REDIRECT_STATUSES.has(hopResult.status) || hopResult.locationHeader === null) {
				return {
					status: hopResult.status,
					headers: hopResult.headers,
					text: hopResult.buffer.toString("utf8"),
				};
			}

			hopsFollowed++;
			if (hopsFollowed > MAX_REDIRECT_HOPS) {
				throw new ExternalSyncError("network_error", "too many redirects");
			}

			let target: URL;
			try {
				target = new URL(hopResult.locationHeader, currentUrl);
			} catch {
				throw new ExternalSyncError("network_error", "invalid redirect location");
			}
			// Инвариант §6.3: цель кросс-origin редиректа не получает НИ ОДНОГО
			// запроса — проверка идёт до того, как currentUrl вообще сдвинется.
			if (target.origin !== originalOrigin) {
				throw new ExternalSyncError("network_error", "cross-origin redirect refused");
			}

			if (hopResult.status === 303) {
				method = "GET";
				body = undefined;
			}
			currentUrl = target;
		}
	} finally {
		clearTimeout(deadlineTimer);
		request.signal?.removeEventListener("abort", onAbort);
	}
}

/** Один сетевой хоп: ровно один запрос, без повторов. */
function issueHop(
	url: URL,
	method: CalDavHttpRequest["method"],
	headers: Readonly<Record<string, string>>,
	body: string | undefined,
	maxResponseBytes: number,
	setActiveRequest: (req: ClientRequest | null) => void,
	getCancelReason: () => ExternalSyncError | null,
): Promise<HopResult> {
	return new Promise((resolve, reject) => {
		void runHop();

		async function runHop(): Promise<void> {
			const cancelledBeforeStart = getCancelReason();
			if (cancelledBeforeStart !== null) {
				reject(cancelledBeforeStart);
				return;
			}

			const options: RequestOptions = {
				method,
				hostname: url.hostname,
				port: url.port === "" ? undefined : Number(url.port),
				path: `${url.pathname}${url.search}`,
				headers: { ...headers },
			};

			let req: ClientRequest;
			try {
				req = await openRequest(url, options, (res) => {
					collectResponse(res, maxResponseBytes, getCancelReason).then(resolve, reject);
				});
			} catch {
				reject(new ExternalSyncError("network_error", "caldav transport unavailable"));
				return;
			}

			setActiveRequest(req);
			req.on("error", (error) => {
				reject(
					getCancelReason() ??
						new ExternalSyncError("network_error", connectionErrorMessage(error)),
				);
			});
			if (body !== undefined) req.write(body, "utf8");
			req.end();
		}
	});
}

/** node:http(s) выбирается по протоколу ЭТОГО хопа (§6.3 п.1). */
async function openRequest(
	url: URL,
	options: RequestOptions,
	onResponse: (res: IncomingMessage) => void,
): Promise<ClientRequest> {
	if (url.protocol === "https:") {
		const nodeHttps = await import("node:https");
		return nodeHttps.request(options, onResponse);
	}
	const nodeHttp = await import("node:http");
	return nodeHttp.request(options, onResponse);
}

function collectResponse(
	res: IncomingMessage,
	maxResponseBytes: number,
	getCancelReason: () => ExternalSyncError | null,
): Promise<HopResult> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;

		const finish = (error?: ExternalSyncError): void => {
			if (settled) return;
			settled = true;
			if (error !== undefined) {
				res.destroy();
				reject(error);
				return;
			}
			resolve({
				status: res.statusCode ?? 0,
				headers: normalizeHeaders(res.headers),
				buffer: Buffer.concat(chunks),
				locationHeader: pickHeader(res.headers, "location"),
			});
		};

		res.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxResponseBytes) {
				finish(new ExternalSyncError("response_too_large", "response exceeds byte cap"));
				return;
			}
			chunks.push(chunk);
		});
		res.on("end", () => finish());
		res.on("error", (error) =>
			finish(
				getCancelReason() ??
					new ExternalSyncError("network_error", connectionErrorMessage(error)),
			),
		);
		res.on("close", () =>
			finish(
				getCancelReason() ??
					new ExternalSyncError(
						"network_error",
						"connection closed before response completed",
					),
			),
		);
	});
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return result;
}

function pickHeader(headers: IncomingMessage["headers"], name: string): string | null {
	const value = headers[name];
	if (value === undefined) return null;
	return Array.isArray(value) ? value.join(", ") : value;
}

/** Никогда не включает URL/host/port: только код ошибки соединения (§5.2 заказа). */
function connectionErrorMessage(error: unknown): string {
	const code =
		error instanceof Error && "code" in error
			? String((error as NodeJS.ErrnoException).code)
			: null;
	return code !== null ? `caldav connection failed (${code})` : "caldav connection failed";
}
