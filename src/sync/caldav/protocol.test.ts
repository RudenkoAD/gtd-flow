import { describe, expect, it } from "vitest";
import {
	basicAuthHeader,
	collectionKeyFor,
	discoverCalendars,
	queryCalendarData,
	type CalDavAccountConfig,
	type CalDavFlowOptions,
} from "./protocol";
import type { CalDavCredential, CalDavHttpPort, CalDavHttpRequest } from "./httpPort";
import { ExternalSyncError, type ExternalSyncErrorCode } from "../externalSyncStatus";

// ---------------------------------------------------------------------------
// Скриптованный фейковый CalDavHttpPort: очередь ожидаемых ответов, каждый
// вызов записывается для последующих проверок.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
	status: number;
	text: string;
	headers?: Record<string, string>;
}

function scriptedHttp(responses: readonly ScriptedResponse[]): {
	http: CalDavHttpPort;
	requests: CalDavHttpRequest[];
} {
	const requests: CalDavHttpRequest[] = [];
	let index = 0;
	const http: CalDavHttpPort = async (request) => {
		requests.push(request);
		const next = responses[index];
		index++;
		if (next === undefined) {
			throw new Error(
				`scriptedHttp: no canned response for request #${index} (${request.method} ${request.url})`,
			);
		}
		return { status: next.status, headers: next.headers ?? {}, text: next.text };
	};
	return { http, requests };
}

function multistatus(inner: string): string {
	return (
		'<?xml version="1.0"?>\n' +
		'<x0:multistatus xmlns:x0="DAV:" xmlns:c9="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">\n' +
		`${inner}\n` +
		"</x0:multistatus>"
	);
}

/** Заменяет CRLF на числовую ссылку на CR + буквальный LF, чтобы XML-нормализация
 *  переводов строк (XML 1.0 §2.11) не съела CR — так реальные CalDAV-серверы
 *  сохраняют CRLF внутри calendar-data. */
function crlfSafe(text: string): string {
	return text.replace(/\r\n/g, "&#13;\n").replace(/\r(?!\n)/g, "&#13;");
}

const ACCOUNT: CalDavAccountConfig = { id: "acc1", serverOrigin: "https://caldav.example" };
const CREDENTIAL: CalDavCredential = { username: "alice", token: "s3cr3t" };
const COLLECTION_HREF = "https://caldav.example/calendars/alice/work/";
const WINDOW = { start: new Date(Date.UTC(2026, 7, 1)), end: new Date(Date.UTC(2026, 8, 1)) };
const NOW = 1_000_000;

function opts(over: Partial<CalDavFlowOptions> = {}): CalDavFlowOptions {
	return { deadlineAt: NOW + 60_000, now: () => NOW, ...over };
}

function assertHygienicMessage(message: string): void {
	expect(message).not.toContain(ACCOUNT.serverOrigin);
	expect(message).not.toContain("caldav.example");
	expect(message).not.toContain(CREDENTIAL.username);
	expect(message).not.toContain(CREDENTIAL.token);
	expect(message.toLowerCase()).not.toContain("http://");
	expect(message.toLowerCase()).not.toContain("https://");
}

// ---------------------------------------------------------------------------
// Discovery-фикстуры (враждебные префиксы: DAV: → x0:, caldav → c9:)
// ---------------------------------------------------------------------------

const STEP1_OK = multistatus(
	"  <x0:response>\n" +
		"    <x0:href>/</x0:href>\n" +
		"    <x0:propstat>\n" +
		"      <x0:prop><x0:current-user-principal><x0:href>/principals/u/</x0:href></x0:current-user-principal></x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>",
);

const STEP2_OK = multistatus(
	"  <x0:response>\n" +
		"    <x0:href>/principals/u/</x0:href>\n" +
		"    <x0:propstat>\n" +
		"      <x0:prop><c9:calendar-home-set><x0:href>https://caldav.example/calendars/alice/</x0:href></c9:calendar-home-set></x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>",
);

const STEP3_OK = multistatus(
	"  <x0:response>\n" +
		"    <x0:href>https://caldav.example/calendars/alice/</x0:href>\n" +
		"    <x0:propstat>\n" +
		"      <x0:prop><x0:resourcetype><x0:collection/></x0:resourcetype></x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>\n" +
		"  <x0:response>\n" +
		"    <x0:href>https://caldav.example/calendars/alice/work/</x0:href>\n" +
		"    <x0:propstat>\n" +
		"      <x0:prop>\n" +
		"        <x0:resourcetype><x0:collection/><c9:calendar/></x0:resourcetype>\n" +
		"        <x0:displayname>Work</x0:displayname>\n" +
		"        <x0:resource-id><x0:href>urn:uuid:work-1</x0:href></x0:resource-id>\n" +
		"        <ic:calendar-color>#FF0000FF</ic:calendar-color>\n" +
		"      </x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>\n" +
		"  <x0:response>\n" +
		"    <x0:href>https://caldav.example/calendars/alice/home/</x0:href>\n" +
		"    <x0:propstat>\n" +
		"      <x0:prop><x0:resourcetype><x0:collection/><c9:calendar/></x0:resourcetype></x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>\n" +
		"  <x0:response>\n" +
		"    <x0:href>https://caldav.example/addressbooks/alice/contacts/</x0:href>\n" +
		"    <x0:propstat>\n" +
		"      <x0:prop><x0:resourcetype><x0:collection/></x0:resourcetype></x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>",
);

const EMPTY_REPORT_OK = multistatus("");

function twoSmallCalendarDataResponses(): string {
	const doc = (n: number): string => `BEGIN:VCALENDAR\r\nUID:doc${n}\r\nEND:VCALENDAR`;
	return [1, 2]
		.map(
			(n) =>
				"  <x0:response>\n" +
				`    <x0:href>https://caldav.example/calendars/alice/work/e${n}.ics</x0:href>\n` +
				"    <x0:propstat>\n" +
				`      <x0:prop><c9:calendar-data>${crlfSafe(doc(n))}</c9:calendar-data></x0:prop>\n` +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>",
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// 1-2: discoverCalendars — happy path, враждебные префиксы, относительные/
// абсолютные href
// ---------------------------------------------------------------------------

describe("discoverCalendars — happy path", () => {
	it("три PROPFIND по порядку, две календарные коллекции, сосед и home исключены", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_OK },
		]);
		const result = await discoverCalendars(ACCOUNT, CREDENTIAL, http, opts());

		expect(requests).toHaveLength(3);
		const [req1, req2, req3] = requests;
		expect(req1?.method).toBe("PROPFIND");
		expect(req1?.headers["Depth"]).toBe("0");
		expect(req1?.headers["Authorization"]).toBe(
			basicAuthHeader(CREDENTIAL.username, CREDENTIAL.token),
		);
		expect(req1?.body).toContain("current-user-principal");

		expect(req2?.method).toBe("PROPFIND");
		expect(req2?.headers["Depth"]).toBe("0");
		expect(req2?.body).toContain("calendar-home-set");

		expect(req3?.method).toBe("PROPFIND");
		expect(req3?.headers["Depth"]).toBe("1");
		expect(req3?.body).toContain("resourcetype");
		expect(req3?.body).toContain("displayname");
		expect(req3?.body).toContain("resource-id");
		expect(req3?.body).toContain("calendar-color");

		expect(result).toHaveLength(2);
		const work = result.find((c) => c.displayName === "Work");
		expect(work).toBeDefined();
		expect(work?.stableId).toBe("urn:uuid:work-1");
		expect(work?.color).toBe("#FF0000FF");
		expect(work?.href).toBe("https://caldav.example/calendars/alice/work/");

		const home = result.find((c) => c.href.endsWith("/home/"));
		expect(home).toBeDefined();
		expect(home?.displayName).toBe("");
		expect(home?.stableId).toBeNull();
		expect(home?.color).toBeNull();
	});

	it("относительный principal href и абсолютный home href резолвятся корректно", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_OK },
		]);
		await discoverCalendars(ACCOUNT, CREDENTIAL, http, opts());
		const [, req2, req3] = requests;
		expect(req2?.url).toBe("https://caldav.example/principals/u/");
		expect(req3?.url).toBe("https://caldav.example/calendars/alice/");
	});

	it("все запросы уходят только на одобренный origin", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_OK },
		]);
		await discoverCalendars(ACCOUNT, CREDENTIAL, http, opts());
		for (const request of requests) {
			expect(request.url.startsWith(ACCOUNT.serverOrigin)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 3: кросс-origin principal href
// ---------------------------------------------------------------------------

describe("discoverCalendars — кросс-origin", () => {
	it("кросс-origin href в current-user-principal → network_error, дальнейших запросов нет", async () => {
		const stepEvil = multistatus(
			"  <x0:response>\n" +
				"    <x0:href>/</x0:href>\n" +
				"    <x0:propstat>\n" +
				"      <x0:prop><x0:current-user-principal><x0:href>https://evil.example/p/</x0:href></x0:current-user-principal></x0:prop>\n" +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>",
		);
		const { http, requests } = scriptedHttp([{ status: 207, text: stepEvil }]);

		let caught: unknown;
		try {
			await discoverCalendars(ACCOUNT, CREDENTIAL, http, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSyncError);
		const error = caught as ExternalSyncError;
		expect(error.code).toBe("network_error");
		assertHygienicMessage(error.message);
		expect(requests).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 4: fallback через credential.principalPath
// ---------------------------------------------------------------------------

describe("discoverCalendars — fallback principalPath", () => {
	it("404 на шаге 1 + principalPath → discovery продолжается с fallback-URL", async () => {
		const credentialWithFallback: CalDavCredential = {
			...CREDENTIAL,
			principalPath: "/principals/users/x/",
		};
		const { http, requests } = scriptedHttp([
			{ status: 404, text: "" },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_OK },
		]);
		const result = await discoverCalendars(ACCOUNT, credentialWithFallback, http, opts());

		expect(requests).toHaveLength(3);
		expect(requests[1]?.url).toBe("https://caldav.example/principals/users/x/");
		expect(result).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 5: отсутствие calendar-home-set
// ---------------------------------------------------------------------------

describe("discoverCalendars — отсутствующий calendar-home-set", () => {
	it("нет calendar-home-set в успешном propstat → unsupported_server", async () => {
		const step2Missing = multistatus(
			"  <x0:response>\n" +
				"    <x0:href>/principals/u/</x0:href>\n" +
				"    <x0:propstat>\n" +
				"      <x0:prop/>\n" +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>",
		);
		const { http } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: step2Missing },
		]);

		let caught: unknown;
		try {
			await discoverCalendars(ACCOUNT, CREDENTIAL, http, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSyncError);
		const error = caught as ExternalSyncError;
		expect(error.code).toBe("unsupported_server");
		assertHygienicMessage(error.message);
	});
});

// ---------------------------------------------------------------------------
// 6: смешанные статусы propstat в листинге Depth:1
// ---------------------------------------------------------------------------

describe("discoverCalendars — смешанные propstat в листинге", () => {
	it("404-propstat с displayname игнорируется; 200-propstat resourcetype всё ещё квалифицирует календарь", async () => {
		const step3Mixed = multistatus(
			"  <x0:response>\n" +
				"    <x0:href>https://caldav.example/calendars/alice/mixed/</x0:href>\n" +
				"    <x0:propstat>\n" +
				"      <x0:prop><x0:displayname>Should Be Ignored</x0:displayname></x0:prop>\n" +
				"      <x0:status>HTTP/1.1 404 Not Found</x0:status>\n" +
				"    </x0:propstat>\n" +
				"    <x0:propstat>\n" +
				"      <x0:prop><x0:resourcetype><x0:collection/><c9:calendar/></x0:resourcetype></x0:prop>\n" +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>",
		);
		const { http } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: step3Mixed },
		]);

		const result = await discoverCalendars(ACCOUNT, CREDENTIAL, http, opts());
		expect(result).toHaveLength(1);
		expect(result[0]?.displayName).toBe("");
	});
});

// ---------------------------------------------------------------------------
// 7: queryCalendarData — happy path
// ---------------------------------------------------------------------------

describe("queryCalendarData — happy path", () => {
	it("REPORT-тело содержит корректный UTC time-range и getetag; CRLF в документах сохранён", async () => {
		const doc1 = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
		const doc2 = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
		const responseXml = multistatus(
			"  <x0:response>\n" +
				"    <x0:href>https://caldav.example/calendars/alice/work/e1.ics</x0:href>\n" +
				"    <x0:propstat>\n" +
				`      <x0:prop><x0:getetag>"etag1"</x0:getetag><c9:calendar-data>${crlfSafe(doc1)}</c9:calendar-data></x0:prop>\n` +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>\n" +
				"  <x0:response>\n" +
				"    <x0:href>https://caldav.example/calendars/alice/work/e2.ics</x0:href>\n" +
				"    <x0:propstat>\n" +
				`      <x0:prop><x0:getetag>"etag2"</x0:getetag><c9:calendar-data>${crlfSafe(doc2)}</c9:calendar-data></x0:prop>\n` +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>",
		);
		const { http, requests } = scriptedHttp([{ status: 207, text: responseXml }]);

		const docs = await queryCalendarData(
			ACCOUNT,
			CREDENTIAL,
			COLLECTION_HREF,
			WINDOW,
			http,
			opts(),
		);

		expect(requests).toHaveLength(1);
		const [req1] = requests;
		expect(req1?.method).toBe("REPORT");
		expect(req1?.headers["Depth"]).toBe("1");
		expect(req1?.body).toContain("20260801T000000Z");
		expect(req1?.body).toContain("20260901T000000Z");
		expect(req1?.body).toContain("getetag");
		expect(req1?.body).toContain("calendar-data");

		expect(docs).toEqual([doc1, doc2]);
	});
});

// ---------------------------------------------------------------------------
// 8: неоднозначный частичный ответ (пустой calendar-data при 200)
// ---------------------------------------------------------------------------

describe("queryCalendarData — неоднозначный частичный ответ", () => {
	it("propstat 200 с пустым calendar-data → invalid_calendar_data", async () => {
		const responseXml = multistatus(
			"  <x0:response>\n" +
				"    <x0:href>https://caldav.example/calendars/alice/work/e1.ics</x0:href>\n" +
				"    <x0:propstat>\n" +
				"      <x0:prop><c9:calendar-data></c9:calendar-data></x0:prop>\n" +
				"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
				"    </x0:propstat>\n" +
				"  </x0:response>",
		);
		const { http } = scriptedHttp([{ status: 207, text: responseXml }]);

		let caught: unknown;
		try {
			await queryCalendarData(ACCOUNT, CREDENTIAL, COLLECTION_HREF, WINDOW, http, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSyncError);
		expect((caught as ExternalSyncError).code).toBe("invalid_calendar_data");
	});
});

// ---------------------------------------------------------------------------
// 9: бюджеты
// ---------------------------------------------------------------------------

describe("queryCalendarData — бюджеты", () => {
	it("maxCalendarDataDocs=1 при 2 документах → response_too_large", async () => {
		const responseXml = multistatus(twoSmallCalendarDataResponses());
		const { http } = scriptedHttp([{ status: 207, text: responseXml }]);

		await expect(
			queryCalendarData(
				ACCOUNT,
				CREDENTIAL,
				COLLECTION_HREF,
				WINDOW,
				http,
				opts({ maxCalendarDataDocs: 1 }),
			),
		).rejects.toMatchObject({ code: "response_too_large" });
	});

	it("превышение суммарного символьного бюджета → response_too_large", async () => {
		const responseXml = multistatus(twoSmallCalendarDataResponses());
		const { http } = scriptedHttp([{ status: 207, text: responseXml }]);

		await expect(
			queryCalendarData(
				ACCOUNT,
				CREDENTIAL,
				COLLECTION_HREF,
				WINDOW,
				http,
				opts({ maxCumulativeCalendarDataChars: 10 }),
			),
		).rejects.toMatchObject({ code: "response_too_large" });
	});
});

// ---------------------------------------------------------------------------
// 10 + 13: маппинг статусов, ровно один запрос (без retry), гигиена сообщений
// ---------------------------------------------------------------------------

describe("queryCalendarData — маппинг статусов и гигиена сообщений", () => {
	const cases: ReadonlyArray<{ status: number; code: ExternalSyncErrorCode }> = [
		{ status: 401, code: "authentication_failed" },
		{ status: 403, code: "forbidden" },
		{ status: 404, code: "collection_missing" },
		{ status: 429, code: "rate_limited" },
		{ status: 500, code: "network_error" },
		{ status: 405, code: "unsupported_server" },
	];

	for (const { status, code } of cases) {
		it(`статус ${status} → ${code}, ровно один запрос, сообщение без чувствительных данных`, async () => {
			const { http, requests } = scriptedHttp([{ status, text: "" }]);

			let caught: unknown;
			try {
				await queryCalendarData(ACCOUNT, CREDENTIAL, COLLECTION_HREF, WINDOW, http, opts());
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			const error = caught as ExternalSyncError;
			expect(error.code).toBe(code);
			assertHygienicMessage(error.message);
			expect(requests).toHaveLength(1);
		});
	}

	it("невалидный XML в 207 → invalid_xml", async () => {
		const { http } = scriptedHttp([{ status: 207, text: "<not-well-formed" }]);

		let caught: unknown;
		try {
			await queryCalendarData(ACCOUNT, CREDENTIAL, COLLECTION_HREF, WINDOW, http, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSyncError);
		const error = caught as ExternalSyncError;
		expect(error.code).toBe("invalid_xml");
		assertHygienicMessage(error.message);
	});
});

// ---------------------------------------------------------------------------
// 11: общий дедлайн прохода, без сброса по шагам, без retry
// ---------------------------------------------------------------------------

describe("общий дедлайн прохода (§6.3)", () => {
	it("now() перескакивает за дедлайн после первого запроса → второй запрос не отправляется, timeout", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_OK },
		]);
		const deadlineAt = NOW + 10_000;
		let callCount = 0;
		const now = (): number => {
			callCount++;
			return callCount === 1 ? NOW : deadlineAt + 1;
		};

		await expect(
			discoverCalendars(ACCOUNT, CREDENTIAL, http, { deadlineAt, now }),
		).rejects.toMatchObject({ code: "timeout" });
		expect(requests).toHaveLength(1);
	});

	it("deadlineMs одного запроса равен min(perRequestTimeoutMs, remaining)", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_OK },
		]);
		const deadlineAt = NOW + 2_000; // меньше дефолтного perRequestTimeoutMs (30000)
		await discoverCalendars(ACCOUNT, CREDENTIAL, http, { deadlineAt, now: () => NOW });
		expect(requests[0]?.deadlineMs).toBe(2_000);

		const { http: http2, requests: requests2 } = scriptedHttp([
			{ status: 207, text: EMPTY_REPORT_OK },
		]);
		await queryCalendarData(ACCOUNT, CREDENTIAL, COLLECTION_HREF, WINDOW, http2, {
			deadlineAt: NOW + 100_000,
			now: () => NOW,
			perRequestTimeoutMs: 5_000,
		});
		expect(requests2[0]?.deadlineMs).toBe(5_000);
	});
});

// ---------------------------------------------------------------------------
// 12: basicAuthHeader
// ---------------------------------------------------------------------------

/** Независимый референсный base64-энкодер (bit-accumulator, НЕ 3-байтовые
 *  чанки реализации) — для перекрёстной проверки без Buffer/btoa. */
function referenceBase64(bytes: Uint8Array): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let bitBuffer = 0;
	let bitCount = 0;
	let output = "";
	for (const byte of bytes) {
		bitBuffer = (bitBuffer << 8) | byte;
		bitCount += 8;
		while (bitCount >= 6) {
			bitCount -= 6;
			output += chars.charAt((bitBuffer >> bitCount) & 0x3f);
		}
	}
	if (bitCount > 0) {
		output += chars.charAt((bitBuffer << (6 - bitCount)) & 0x3f);
	}
	while (output.length % 4 !== 0) output += "=";
	return output;
}

function referenceBasicAuthHeader(username: string, token: string): string {
	return `Basic ${referenceBase64(new TextEncoder().encode(`${username}:${token}`))}`;
}

describe("basicAuthHeader", () => {
	it('ASCII: "user:tok" → "Basic dXNlcjp0b2s="', () => {
		expect(basicAuthHeader("user", "tok")).toBe("Basic dXNlcjp0b2s=");
	});

	it("non-ASCII логин/токен кодируются идентично независимому референсному энкодеру", () => {
		const username = "пользователь@corp";
		const token = "секрет";
		const expected = referenceBasicAuthHeader(username, token);
		expect(expected.startsWith("Basic ")).toBe(true);
		expect(basicAuthHeader(username, token)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// 14: collectionKeyFor
// ---------------------------------------------------------------------------

describe("collectionKeyFor", () => {
	it("детерминирован и не зависит от displayName (не входной параметр)", () => {
		const a = collectionKeyFor("urn:uuid:1", "/calendars/alice/work/");
		const b = collectionKeyFor("urn:uuid:1", "/calendars/alice/work/");
		expect(a).toBe(b);
		expect(a.startsWith("ck-")).toBe(true);
	});

	it("предпочитает stableId; меняется при смене stableId", () => {
		const withId1 = collectionKeyFor("urn:uuid:1", "/calendars/alice/work/");
		const withId2 = collectionKeyFor("urn:uuid:2", "/calendars/alice/work/");
		expect(withId1).not.toBe(withId2);
	});

	it("при отсутствии stableId — использует путь href; разные пути дают разные ключи", () => {
		const byPathA = collectionKeyFor(null, "/calendars/alice/work/");
		const byPathB = collectionKeyFor(null, "/calendars/alice/home/");
		expect(byPathA).not.toBe(byPathB);

		const stableWithSamePath = collectionKeyFor("urn:uuid:1", "/calendars/alice/work/");
		expect(stableWithSamePath).not.toBe(byPathA);
	});
});
