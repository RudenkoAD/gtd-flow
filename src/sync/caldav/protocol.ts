/**
 * Протокольный слой CalDAV-клиента (§6 CalDAV-заказа): discovery коллекций
 * (principal → calendar-home-set → листинг Depth:1) и REPORT calendar-query
 * за окно времени. Модуль полностью чист: сеть приходит структурным портом
 * CalDavHttpPort (см. httpPort.ts), ответы разбираются безопасным
 * namespace-aware парсером (xml.ts) — ни obsidian, ни node-builtin здесь не
 * импортируются, base64 для Basic-заголовка реализован вручную поверх
 * TextEncoder (без Buffer/btoa — платформонезависимо, §14.1).
 *
 * Инварианты (§6.3):
 * - единый дедлайн на весь проход (options.deadlineAt), без сброса по шагам:
 *   перед КАЖДЫМ запросом остаток пересчитывается от now(), исчерпание —
 *   ExternalSyncError("timeout"); повтора запросов НЕТ — следующий плановый
 *   проход синхронизации и есть единственный retry;
 * - каждый href резолвится ТОЛЬКО против URL текущего ответа и обязан
 *   остаться на account.serverOrigin — иначе network_error, запрос не уходит;
 * - сообщения ошибок — код плюс статическая английская фраза; URL, href,
 *   логин, токен и тело ответа сервера в message никогда не попадают.
 */
import type { CalDavCredential, CalDavHttpPort, CalDavHttpResponse } from "./httpPort";
import {
	CALDAV_NS,
	DAV_NS,
	childrenOf,
	firstChild,
	parseXml,
	type XmlBudget,
	type XmlElement,
} from "./xml";
import { ExternalSyncError } from "../externalSyncStatus";

/** Один сконфигурированный CalDAV-аккаунт: только исходный origin сервера. */
export interface CalDavAccountConfig {
	id: string;
	/** Origin без пути, например "https://caldav.example". */
	serverOrigin: string;
}

/** Одна обнаруженная календарная коллекция (§6.1). */
export interface DiscoveredCalendar {
	/** Непрозрачный стабильный ключ (см. collectionKeyFor) — НЕ href. */
	collectionKey: string;
	/** Абсолютный same-origin URL коллекции. */
	href: string;
	/** Может быть "", если сервер не вернул displayname. */
	displayName: string;
	/** Стабильное серверное свойство (DAV:resource-id), если сервер его отдаёт. */
	stableId: string | null;
	/** Только для UI. */
	color: string | null;
}

/** Параметры одного прохода discovery/query (§6.3). */
export interface CalDavFlowOptions {
	/** Абсолютный epoch-мс дедлайн ВСЕГО прохода — без сброса по шагам. */
	deadlineAt: number;
	/** Внедряемые часы (тесты); по умолчанию Date.now. */
	now?: () => number;
	/** Потолок ОДНОГО запроса. */
	perRequestTimeoutMs?: number;
	xmlBudget?: XmlBudget;
	/** Максимум документов calendar-data за один REPORT. */
	maxCalendarDataDocs?: number;
	/** Максимум суммарных символов calendar-data за один REPORT. */
	maxCumulativeCalendarDataChars?: number;
}

const DEFAULT_PER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CALENDAR_DATA_DOCS = 2000;
const DEFAULT_MAX_CUMULATIVE_CALENDAR_DATA_CHARS = 10 * 1024 * 1024;

const APPLE_ICAL_NS = "http://apple.com/ns/ical/";

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 поверх Uint8Array БЕЗ Buffer/btoa — платформонезависимо (§14.1). */
function base64Encode(bytes: Uint8Array): string {
	let result = "";
	let i = 0;
	for (; i + 3 <= bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1] ?? 0;
		const b2 = bytes[i + 2] ?? 0;
		const chunk = (b0 << 16) | (b1 << 8) | b2;
		result += BASE64_CHARS.charAt((chunk >> 18) & 0x3f);
		result += BASE64_CHARS.charAt((chunk >> 12) & 0x3f);
		result += BASE64_CHARS.charAt((chunk >> 6) & 0x3f);
		result += BASE64_CHARS.charAt(chunk & 0x3f);
	}
	const remaining = bytes.length - i;
	if (remaining === 1) {
		const b0 = bytes[i] ?? 0;
		const chunk = b0 << 16;
		result += BASE64_CHARS.charAt((chunk >> 18) & 0x3f);
		result += BASE64_CHARS.charAt((chunk >> 12) & 0x3f);
		result += "==";
	} else if (remaining === 2) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1] ?? 0;
		const chunk = (b0 << 16) | (b1 << 8);
		result += BASE64_CHARS.charAt((chunk >> 18) & 0x3f);
		result += BASE64_CHARS.charAt((chunk >> 12) & 0x3f);
		result += BASE64_CHARS.charAt((chunk >> 6) & 0x3f);
		result += "=";
	}
	return result;
}

/** "Basic " + base64(utf8(username + ":" + token)). */
export function basicAuthHeader(username: string, token: string): string {
	const bytes = new TextEncoder().encode(`${username}:${token}`);
	return `Basic ${base64Encode(bytes)}`;
}

/** FNV-1a (32-бит) над UTF-16 code units строки, начиная с заданного seed. */
function fnv1a(text: string, seed: number): number {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * Детерминированный непрозрачный ключ коллекции: предпочитает stableId,
 * иначе — канонизированный путь href. Двойной проход FNV-1a (второй проход
 * зависит от результата первого) снижает риск тривиальных коллизий; кодируется
 * в base36 с префиксом "ck-". НИКОГДА не зависит от displayName.
 */
export function collectionKeyFor(stableId: string | null, hrefPath: string): string {
	const source = stableId !== null && stableId !== "" ? `id:${stableId}` : `path:${hrefPath}`;
	const first = fnv1a(source, 0x811c9dc5);
	const second = fnv1a(`${first.toString(36)}:${source}`, 0x9e3779b9);
	return `ck-${first.toString(36)}${second.toString(36)}`;
}

interface FlowContext {
	account: CalDavAccountConfig;
	credential: CalDavCredential;
	http: CalDavHttpPort;
	now: () => number;
	deadlineAt: number;
	perRequestTimeoutMs: number;
	xmlBudget: XmlBudget | undefined;
}

function createFlowContext(
	account: CalDavAccountConfig,
	credential: CalDavCredential,
	http: CalDavHttpPort,
	options: CalDavFlowOptions,
): FlowContext {
	return {
		account,
		credential,
		http,
		now: options.now ?? Date.now,
		deadlineAt: options.deadlineAt,
		perRequestTimeoutMs: options.perRequestTimeoutMs ?? DEFAULT_PER_REQUEST_TIMEOUT_MS,
		xmlBudget: options.xmlBudget,
	};
}

/** Резолвит href ТОЛЬКО против URL текущего ответа; кросс-origin — network_error. */
function resolveSameOrigin(href: string, baseUrl: string, accountOrigin: string): string {
	let resolved: URL;
	try {
		resolved = new URL(href, baseUrl);
	} catch {
		throw new ExternalSyncError("network_error", "malformed href");
	}
	if (resolved.origin !== accountOrigin) {
		throw new ExternalSyncError("network_error", "cross-origin href rejected");
	}
	return resolved.toString();
}

/** Статусы non-207 → закрытый список кодов (§6.3); никакого retry. */
function mapStatusError(status: number, context: "discovery" | "query"): ExternalSyncError {
	if (status === 401)
		return new ExternalSyncError("authentication_failed", "authentication failed");
	if (status === 403) return new ExternalSyncError("forbidden", "access forbidden");
	if (status === 404)
		return new ExternalSyncError(
			context === "discovery" ? "discovery_failed" : "collection_missing",
			"resource not found",
		);
	if (status === 429) return new ExternalSyncError("rate_limited", "rate limited");
	if (status === 405 || status === 501)
		return new ExternalSyncError("unsupported_server", "method not supported");
	return new ExternalSyncError("network_error", "unexpected response status");
}

/** Один сетевой вызов: дедлайн проверяется/пересчитывается ДО каждого запроса. */
async function performRequest(
	ctx: FlowContext,
	method: "PROPFIND" | "REPORT",
	url: string,
	extraHeaders: Readonly<Record<string, string>>,
	body: string,
): Promise<{ response: CalDavHttpResponse; baseUrl: string }> {
	const remaining = ctx.deadlineAt - ctx.now();
	if (remaining <= 0) throw new ExternalSyncError("timeout", "caldav flow deadline exceeded");
	const deadlineMs = Math.min(ctx.perRequestTimeoutMs, remaining);
	const headers: Record<string, string> = {
		Authorization: basicAuthHeader(ctx.credential.username, ctx.credential.token),
		"Content-Type": "application/xml; charset=utf-8",
		...extraHeaders,
	};
	const response = await ctx.http({ url, method, headers, body, deadlineMs });
	return { response, baseUrl: url };
}

function isSuccessStatus(propstat: XmlElement): boolean {
	const status = firstChild(propstat, DAV_NS, "status");
	return status !== null && status.text.includes("200");
}

/** prop-элементы всех propstat-блоков этого response с DAV:status "200". */
function successfulProps(responseEl: XmlElement): XmlElement[] {
	const props: XmlElement[] = [];
	for (const propstat of childrenOf(responseEl, DAV_NS, "propstat")) {
		if (!isSuccessStatus(propstat)) continue;
		const prop = firstChild(propstat, DAV_NS, "prop");
		if (prop !== null) props.push(prop);
	}
	return props;
}

function firstProp(props: readonly XmlElement[], uri: string, local: string): XmlElement | null {
	for (const prop of props) {
		const found = firstChild(prop, uri, local);
		if (found !== null) return found;
	}
	return null;
}

/** Единственное href-значение свойства (current-user-principal/calendar-home-set). */
function extractPropHref(
	root: XmlElement,
	uri: string,
	local: string,
	baseUrl: string,
	ctx: FlowContext,
): string | null {
	for (const responseEl of childrenOf(root, DAV_NS, "response")) {
		const target = firstProp(successfulProps(responseEl), uri, local);
		if (target === null) continue;
		const hrefEl = firstChild(target, DAV_NS, "href");
		const text = (hrefEl?.text ?? target.text).trim();
		if (text) return resolveSameOrigin(text, baseUrl, ctx.account.serverOrigin);
	}
	return null;
}

function extractResourceId(props: readonly XmlElement[]): string | null {
	const resourceIdEl = firstProp(props, DAV_NS, "resource-id");
	if (resourceIdEl === null) return null;
	const hrefEl = firstChild(resourceIdEl, DAV_NS, "href");
	const text = (hrefEl?.text ?? resourceIdEl.text).trim();
	return text ? text : null;
}

const CURRENT_USER_PRINCIPAL_BODY =
	'<?xml version="1.0" encoding="utf-8"?>\n' +
	'<D:propfind xmlns:D="DAV:">\n' +
	"  <D:prop>\n" +
	"    <D:current-user-principal/>\n" +
	"  </D:prop>\n" +
	"</D:propfind>";

const CALENDAR_HOME_SET_BODY =
	'<?xml version="1.0" encoding="utf-8"?>\n' +
	`<D:propfind xmlns:D="DAV:" xmlns:C="${CALDAV_NS}">\n` +
	"  <D:prop>\n" +
	"    <C:calendar-home-set/>\n" +
	"  </D:prop>\n" +
	"</D:propfind>";

const HOME_LISTING_BODY =
	'<?xml version="1.0" encoding="utf-8"?>\n' +
	`<D:propfind xmlns:D="DAV:" xmlns:C="${CALDAV_NS}" xmlns:IC="${APPLE_ICAL_NS}">\n` +
	"  <D:prop>\n" +
	"    <D:resourcetype/>\n" +
	"    <D:displayname/>\n" +
	"    <D:resource-id/>\n" +
	"    <IC:calendar-color/>\n" +
	"  </D:prop>\n" +
	"</D:propfind>";

/** PROPFIND, ожидающий 207; иные статусы → mapStatusError (без спец-fallback). */
async function propfind(
	ctx: FlowContext,
	url: string,
	depth: "0" | "1",
	body: string,
	context: "discovery" | "query",
): Promise<{ root: XmlElement; baseUrl: string }> {
	const { response, baseUrl } = await performRequest(
		ctx,
		"PROPFIND",
		url,
		{ Depth: depth },
		body,
	);
	if (response.status !== 207) throw mapStatusError(response.status, context);
	return { root: parseXml(response.text, ctx.xmlBudget), baseUrl };
}

/**
 * Шаг 1 (§6.1.1-6): PROPFIND Depth:0 к origin за current-user-principal.
 * 404/405/501 ИЛИ отсутствие href в успешном ответе → fallback на
 * credential.principalPath (если задан), иначе unsupported_server. Прочие
 * не-207 статусы маппятся обычным образом немедленно.
 */
async function discoverPrincipalUrl(ctx: FlowContext): Promise<string> {
	const step1Url = `${ctx.account.serverOrigin}/`;
	const { response, baseUrl } = await performRequest(
		ctx,
		"PROPFIND",
		step1Url,
		{ Depth: "0" },
		CURRENT_USER_PRINCIPAL_BODY,
	);

	let href: string | null = null;
	if (response.status === 207) {
		const root = parseXml(response.text, ctx.xmlBudget);
		href = extractPropHref(root, DAV_NS, "current-user-principal", baseUrl, ctx);
	} else if (response.status !== 404 && response.status !== 405 && response.status !== 501) {
		throw mapStatusError(response.status, "discovery");
	}

	if (href !== null) return href;
	if (ctx.credential.principalPath) {
		return resolveSameOrigin(ctx.credential.principalPath, step1Url, ctx.account.serverOrigin);
	}
	throw new ExternalSyncError("unsupported_server", "missing current-user-principal");
}

/** Шаг 2 (§6.1.7-8): PROPFIND Depth:0 к principal за calendar-home-set. */
async function discoverHomeUrl(ctx: FlowContext, principalUrl: string): Promise<string> {
	const { root, baseUrl } = await propfind(
		ctx,
		principalUrl,
		"0",
		CALENDAR_HOME_SET_BODY,
		"discovery",
	);
	const href = extractPropHref(root, CALDAV_NS, "calendar-home-set", baseUrl, ctx);
	if (href === null)
		throw new ExternalSyncError("unsupported_server", "missing calendar-home-set");
	return href;
}

/**
 * Полный discovery (§6.1): principal → calendar-home-set → листинг Depth:1,
 * отфильтрованный до CALDAV:calendar-детей (сама home-коллекция и не-calendar
 * соседи — например addressbook — исключены).
 */
export async function discoverCalendars(
	account: CalDavAccountConfig,
	credential: CalDavCredential,
	http: CalDavHttpPort,
	options: CalDavFlowOptions,
): Promise<readonly DiscoveredCalendar[]> {
	const ctx = createFlowContext(account, credential, http, options);

	const principalUrl = await discoverPrincipalUrl(ctx);
	const homeUrl = await discoverHomeUrl(ctx, principalUrl);
	const { root, baseUrl } = await propfind(ctx, homeUrl, "1", HOME_LISTING_BODY, "discovery");

	const calendars: DiscoveredCalendar[] = [];
	for (const responseEl of childrenOf(root, DAV_NS, "response")) {
		const hrefEl = firstChild(responseEl, DAV_NS, "href");
		const hrefText = hrefEl?.text.trim();
		if (!hrefText) continue;
		const href = resolveSameOrigin(hrefText, baseUrl, ctx.account.serverOrigin);
		if (href === homeUrl) continue; // сама home-коллекция

		const props = successfulProps(responseEl);
		const resourcetype = firstProp(props, DAV_NS, "resourcetype");
		if (resourcetype === null) continue; // нет успешного propstat с resourcetype
		const isCalendar = childrenOf(resourcetype, CALDAV_NS, "calendar").length > 0;
		if (!isCalendar) continue;

		const displayNameEl = firstProp(props, DAV_NS, "displayname");
		const displayName = displayNameEl?.text.trim() ?? "";
		const stableId = extractResourceId(props);
		const colorEl = firstProp(props, APPLE_ICAL_NS, "calendar-color");
		const colorText = colorEl?.text.trim();
		const color = colorText ? colorText : null;

		calendars.push({
			collectionKey: collectionKeyFor(stableId, new URL(href).pathname),
			href,
			displayName,
			stableId,
			color,
		});
	}
	return calendars;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** Date → UTC "YYYYMMDDTHHMMSSZ" (RFC 5545 UTC form) для CALDAV:time-range. */
function formatUtcStamp(date: Date): string {
	return (
		String(date.getUTCFullYear()) +
		pad2(date.getUTCMonth() + 1) +
		pad2(date.getUTCDate()) +
		"T" +
		pad2(date.getUTCHours()) +
		pad2(date.getUTCMinutes()) +
		pad2(date.getUTCSeconds()) +
		"Z"
	);
}

function buildCalendarQueryBody(start: Date, end: Date): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>\n' +
		`<C:calendar-query xmlns:D="DAV:" xmlns:C="${CALDAV_NS}">\n` +
		"  <D:prop>\n" +
		"    <D:getetag/>\n" +
		"    <C:calendar-data/>\n" +
		"  </D:prop>\n" +
		"  <C:filter>\n" +
		'    <C:comp-filter name="VCALENDAR">\n' +
		'      <C:comp-filter name="VEVENT">\n' +
		`        <C:time-range start="${formatUtcStamp(start)}" end="${formatUtcStamp(end)}"/>\n` +
		"      </C:comp-filter>\n" +
		"    </C:comp-filter>\n" +
		"  </C:filter>\n" +
		"</C:calendar-query>"
	);
}

/**
 * REPORT calendar-query за окно [window.start, window.end) (§6.2). Возвращает
 * сырые документы calendar-data как есть — их парсинг per-document остаётся
 * вызывающей стороне. Пустой calendar-data при успешном propstat — неоднозначный
 * частичный ответ, fail-closed → invalid_calendar_data.
 */
export async function queryCalendarData(
	account: CalDavAccountConfig,
	credential: CalDavCredential,
	collectionHref: string,
	window: { start: Date; end: Date },
	http: CalDavHttpPort,
	options: CalDavFlowOptions,
): Promise<readonly string[]> {
	const ctx = createFlowContext(account, credential, http, options);
	const maxDocs = options.maxCalendarDataDocs ?? DEFAULT_MAX_CALENDAR_DATA_DOCS;
	const maxChars =
		options.maxCumulativeCalendarDataChars ?? DEFAULT_MAX_CUMULATIVE_CALENDAR_DATA_CHARS;

	const requestUrl = resolveSameOrigin(
		collectionHref,
		`${ctx.account.serverOrigin}/`,
		ctx.account.serverOrigin,
	);
	const body = buildCalendarQueryBody(window.start, window.end);
	const { response } = await performRequest(ctx, "REPORT", requestUrl, { Depth: "1" }, body);
	if (response.status !== 207) throw mapStatusError(response.status, "query");
	const root = parseXml(response.text, ctx.xmlBudget);

	const docs: string[] = [];
	let cumulativeChars = 0;
	for (const responseEl of childrenOf(root, DAV_NS, "response")) {
		const dataEl = firstProp(successfulProps(responseEl), CALDAV_NS, "calendar-data");
		if (dataEl === null) continue; // нет calendar-data в успешном propstat — пропуск
		if (dataEl.text === "")
			throw new ExternalSyncError(
				"invalid_calendar_data",
				"empty calendar-data in successful propstat",
			);

		docs.push(dataEl.text);
		cumulativeChars += dataEl.text.length;
		if (docs.length > maxDocs || cumulativeChars > maxChars)
			throw new ExternalSyncError(
				"response_too_large",
				"calendar-data response exceeds budget",
			);
	}
	return docs;
}
