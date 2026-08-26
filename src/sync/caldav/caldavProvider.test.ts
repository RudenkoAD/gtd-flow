import { describe, expect, it } from "vitest";
import { CalDavProvider } from "./caldavProvider";
import { collectionKeyFor } from "./protocol";
import type {
	CalDavCredential,
	CalDavCredentialPort,
	CalDavHttpPort,
	CalDavHttpRequest,
} from "./httpPort";
import type { CalDavAccount, CalDavCalendarSub } from "../../settings/Settings";
import type { CalDavSourceRef } from "../SyncService";
import type { MirrorWindow } from "../icsParse";

// ---------------------------------------------------------------------------
// Скриптованный фейковый CalDavHttpPort (паттерн protocol.test.ts): очередь
// ожидаемых ответов по порядку вызовов, каждый вызов записывается.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
	status: number;
	text: string;
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
		return { status: next.status, headers: {}, text: next.text };
	};
	return { http, requests };
}

function methodCount(requests: readonly CalDavHttpRequest[], method: string): number {
	return requests.filter((r) => r.method === method).length;
}

function multistatus(inner: string): string {
	return (
		'<?xml version="1.0"?>\n' +
		'<x0:multistatus xmlns:x0="DAV:" xmlns:c9="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">\n' +
		`${inner}\n` +
		"</x0:multistatus>"
	);
}

/** Заменяет CRLF на числовую ссылку на CR + буквальный LF (см. protocol.test.ts):
 *  XML-нормализация переводов строк не должна съесть CR внутри calendar-data. */
function crlfSafe(text: string): string {
	return text.replace(/\r\n/g, "&#13;\n").replace(/\r(?!\n)/g, "&#13;");
}

function reportWithDocs(docs: readonly string[]): string {
	return multistatus(
		docs
			.map(
				(doc, i) =>
					"  <x0:response>\n" +
					`    <x0:href>https://caldav.example/calendars/alice/a/e${i}.ics</x0:href>\n` +
					"    <x0:propstat>\n" +
					`      <x0:prop><c9:calendar-data>${crlfSafe(doc)}</c9:calendar-data></x0:prop>\n` +
					"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
					"    </x0:propstat>\n" +
					"  </x0:response>",
			)
			.join("\n"),
	);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function freshSignal(): AbortSignal {
	return new AbortController().signal;
}

function assertHygienicMessage(message: string): void {
	expect(message).not.toContain("caldav.example");
	expect(message).not.toContain(CREDENTIAL.username);
	expect(message.toLowerCase()).not.toContain("http://");
	expect(message.toLowerCase()).not.toContain("https://");
}

// ---------------------------------------------------------------------------
// Фикстуры: аккаунт, credential, подписки, окно, discovery, ICS-документы
// ---------------------------------------------------------------------------

const ACCOUNT: CalDavAccount = {
	id: "acc1",
	serverOrigin: "https://caldav.example",
	secretRef: "acc1",
};
const CREDENTIAL: CalDavCredential = { username: "alice", token: "s3cr3t" };

const HREF_A = "https://caldav.example/calendars/alice/a/";
const HREF_B = "https://caldav.example/calendars/alice/b/";
const KEY_A = collectionKeyFor("urn:uuid:cal-a", "/calendars/alice/a/");
const KEY_B = collectionKeyFor("urn:uuid:cal-b", "/calendars/alice/b/");
const KEY_MISSING = collectionKeyFor("urn:uuid:cal-missing", "/calendars/alice/missing/");

/** Окно, накрывающее июль 2026 (стабильно, не зависит от «сегодня»). */
const WINDOW: MirrorWindow = { start: new Date(2026, 6, 1), end: new Date(2026, 7, 1) };
const NOW = 2_000_000;

function opts(over: Partial<{ deadlineAt: number; signal: AbortSignal }> = {}): {
	deadlineAt: number;
	signal: AbortSignal;
} {
	return { deadlineAt: NOW + 60_000, signal: freshSignal(), ...over };
}

function sub(overrides: Partial<CalDavCalendarSub> = {}): CalDavCalendarSub {
	return {
		kind: "caldav",
		id: "sub1",
		name: "Work",
		lastSyncAt: null,
		lastError: null,
		errorCode: null,
		accountId: ACCOUNT.id,
		collectionKey: KEY_A,
		privacy: "details",
		enabled: true,
		scopeId: null,
		pendingRedaction: false,
		...overrides,
	};
}

function sourceRef(
	subOverrides: Partial<CalDavCalendarSub> = {},
	account: CalDavAccount = ACCOUNT,
): CalDavSourceRef {
	return { sub: sub(subOverrides), account };
}

function credentialPort(map: Record<string, CalDavCredential | null>): CalDavCredentialPort {
	return { get: (accountId) => (accountId in map ? map[accountId]! : null) };
}

// Discovery-фикстуры (враждебные префиксы, как в protocol.test.ts).
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

const STEP3_ERROR_500 = { status: 500, text: "" };

function calendarResponseXml(href: string, displayName: string, stableId: string): string {
	return (
		"  <x0:response>\n" +
		`    <x0:href>${href}</x0:href>\n` +
		"    <x0:propstat>\n" +
		"      <x0:prop>\n" +
		"        <x0:resourcetype><x0:collection/><c9:calendar/></x0:resourcetype>\n" +
		`        <x0:displayname>${displayName}</x0:displayname>\n` +
		`        <x0:resource-id><x0:href>${stableId}</x0:href></x0:resource-id>\n` +
		"      </x0:prop>\n" +
		"      <x0:status>HTTP/1.1 200 OK</x0:status>\n" +
		"    </x0:propstat>\n" +
		"  </x0:response>"
	);
}

const STEP3_ONE_CALENDAR = multistatus(calendarResponseXml(HREF_A, "A", "urn:uuid:cal-a"));

const STEP3_TWO_CALENDARS = multistatus(
	[
		calendarResponseXml(HREF_A, "A", "urn:uuid:cal-a"),
		calendarResponseXml(HREF_B, "B", "urn:uuid:cal-b"),
	].join("\n"),
);

// ICS-документы: один VEVENT на документ, оба внутри окна (июль 2026).
const EVENT_DOC_1 =
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Событие 1\r\n" +
	"DTSTART:20260710T100000\r\nDTEND:20260710T110000\r\nEND:VEVENT\r\nEND:VCALENDAR";
const EVENT_DOC_2 =
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e2\r\nSUMMARY:Событие 2\r\n" +
	"DTSTART:20260715T140000\r\nDTEND:20260715T150000\r\nEND:VEVENT\r\nEND:VCALENDAR";
const MALFORMED_DOC = "это не ICS, а случайный текст без структуры";

// ---------------------------------------------------------------------------
// 1: credential_missing — без единого сетевого вызова
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — credential_missing", () => {
	it("нет credential у аккаунта → credential_missing, http порт не вызывается", async () => {
		const { http, requests } = scriptedHttp([]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({}), // acc1 отсутствует → null
			now: () => NOW,
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef(), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "credential_missing" });
		assertHygienicMessage((caught as Error).message);
		expect(requests).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 2: happy path с кэшированным href — без discovery
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — кэшированный href", () => {
	it("credential.collections несёт href → PROPFIND не уходит, один REPORT, оба VEVENT разобраны", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: reportWithDocs([EVENT_DOC_1, EVENT_DOC_2]) },
		]);
		const credential: CalDavCredential = { ...CREDENTIAL, collections: { [KEY_A]: HREF_A } };
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: credential }),
			now: () => NOW,
		});

		const occurrences = await provider.load(sourceRef(), WINDOW, opts());

		expect(methodCount(requests, "PROPFIND")).toBe(0);
		expect(methodCount(requests, "REPORT")).toBe(1);
		expect(occurrences.map((o) => o.uid).sort()).toEqual(["e1", "e2"]);
	});
});

// ---------------------------------------------------------------------------
// 3: rediscovery — нет кэша, discovery находит коллекцию по collectionKey
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — rediscovery", () => {
	it("нет кэша → полный discovery, коллекция найдена по collectionKey, затем REPORT", async () => {
		const { http, requests } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_ONE_CALENDAR },
			{ status: 207, text: reportWithDocs([EVENT_DOC_1]) },
		]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: CREDENTIAL }),
			now: () => NOW,
		});

		const occurrences = await provider.load(
			sourceRef({ collectionKey: KEY_A }),
			WINDOW,
			opts(),
		);

		expect(methodCount(requests, "PROPFIND")).toBe(3);
		expect(methodCount(requests, "REPORT")).toBe(1);
		expect(occurrences.map((o) => o.uid)).toEqual(["e1"]);
	});
});

// ---------------------------------------------------------------------------
// 4: мемоизация discovery на проход между коллекциями ОДНОГО аккаунта
// ---------------------------------------------------------------------------

describe("CalDavProvider — мемоизация discovery на проход", () => {
	it("два load() без кэша, один аккаунт → одна discovery-цепочка, два REPORT; после beginPass — снова discovery", async () => {
		let current = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_TWO_CALENDARS },
			{ status: 207, text: reportWithDocs([EVENT_DOC_1]) },
			{ status: 207, text: reportWithDocs([EVENT_DOC_2]) },
		]);
		const provider = new CalDavProvider({
			http: (request) => current.http(request),
			credentials: credentialPort({ acc1: CREDENTIAL }),
			now: () => NOW,
		});

		const [resultA, resultB] = await Promise.all([
			provider.load(sourceRef({ id: "subA", collectionKey: KEY_A }), WINDOW, opts()),
			provider.load(sourceRef({ id: "subB", collectionKey: KEY_B }), WINDOW, opts()),
		]);

		expect(methodCount(current.requests, "PROPFIND")).toBe(3);
		expect(methodCount(current.requests, "REPORT")).toBe(2);
		expect(resultA.length + resultB.length).toBe(2);

		// После beginPass() мемо сброшено — третий load() того же аккаунта (тот
		// же provider!) снова проходит полный discovery.
		provider.beginPass();
		current = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_ONE_CALENDAR },
			{ status: 207, text: reportWithDocs([EVENT_DOC_1]) },
		]);
		await provider.load(sourceRef({ id: "subA", collectionKey: KEY_A }), WINDOW, opts());
		expect(methodCount(current.requests, "PROPFIND")).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 5: отклонённый discovery НЕ кэшируется между проходами
// ---------------------------------------------------------------------------

describe("CalDavProvider — отклонённый discovery и beginPass", () => {
	it("проход 1: discovery падает 500 → ошибка; beginPass(); проход 2 с рабочими ответами → успех", async () => {
		let current = scriptedHttp([STEP3_ERROR_500]);
		const provider = new CalDavProvider({
			http: (request) => current.http(request),
			credentials: credentialPort({ acc1: CREDENTIAL }),
			now: () => NOW,
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef({ collectionKey: KEY_A }), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "network_error" });

		provider.beginPass();
		current = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_ONE_CALENDAR },
			{ status: 207, text: reportWithDocs([EVENT_DOC_1, EVENT_DOC_2]) },
		]);

		const occurrences = await provider.load(
			sourceRef({ collectionKey: KEY_A }),
			WINDOW,
			opts(),
		);
		expect(occurrences.map((o) => o.uid).sort()).toEqual(["e1", "e2"]);
	});
});

// ---------------------------------------------------------------------------
// 6: collection_missing — discovery успешен, но коллекция не найдена
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — collection_missing", () => {
	it("discovery не находит коллекцию с этим collectionKey → collection_missing", async () => {
		const { http } = scriptedHttp([
			{ status: 207, text: STEP1_OK },
			{ status: 207, text: STEP2_OK },
			{ status: 207, text: STEP3_ONE_CALENDAR }, // только KEY_A
		]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: CREDENTIAL }),
			now: () => NOW,
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef({ collectionKey: KEY_MISSING }), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "collection_missing" });
		assertHygienicMessage((caught as Error).message);
	});
});

// ---------------------------------------------------------------------------
// 7: один битый embedded-документ роняет ВСЮ коллекцию
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — битый embedded ICS", () => {
	it("второй calendar-data документ — мусор → invalid_calendar_data для всей коллекции", async () => {
		const credential: CalDavCredential = { ...CREDENTIAL, collections: { [KEY_A]: HREF_A } };
		const { http } = scriptedHttp([
			{ status: 207, text: reportWithDocs([EVENT_DOC_1, MALFORMED_DOC]) },
		]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: credential }),
			now: () => NOW,
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef(), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "invalid_calendar_data" });
		assertHygienicMessage((caught as Error).message);
	});
});

// ---------------------------------------------------------------------------
// 8: агрегатный байтовый бюджет — комбинированная длина двух документов
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — агрегатный байтовый бюджет", () => {
	it("суммарная длина двух документов превышает маленький потолок → response_too_large", async () => {
		const credential: CalDavCredential = { ...CREDENTIAL, collections: { [KEY_A]: HREF_A } };
		const { http } = scriptedHttp([
			{ status: 207, text: reportWithDocs([EVENT_DOC_1, EVENT_DOC_2]) },
		]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: credential }),
			now: () => NOW,
			limits: { maxAggregateChars: EVENT_DOC_1.length + 3 },
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef(), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "response_too_large" });
		assertHygienicMessage((caught as Error).message);
	});
});

// ---------------------------------------------------------------------------
// 9: агрегатный бюджет строк с крошечным maxAggregateRows
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — агрегатный бюджет строк", () => {
	it("два документа по одной строке каждый, aggregate cap=1 → response_too_large", async () => {
		const credential: CalDavCredential = { ...CREDENTIAL, collections: { [KEY_A]: HREF_A } };
		const { http } = scriptedHttp([
			{ status: 207, text: reportWithDocs([EVENT_DOC_1, EVENT_DOC_2]) },
		]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: credential }),
			now: () => NOW,
			limits: { maxAggregateRows: 1 },
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef(), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "response_too_large" });
		assertHygienicMessage((caught as Error).message);
	});
});

// ---------------------------------------------------------------------------
// 10: уже отменённый сигнал → timeout без единого http-вызова
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — abort", () => {
	it("signal.aborted уже true → timeout, http порт не вызывается", async () => {
		const { http, requests } = scriptedHttp([]);
		const credential: CalDavCredential = { ...CREDENTIAL, collections: { [KEY_A]: HREF_A } };
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: credential }),
			now: () => NOW,
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef(), WINDOW, {
				deadlineAt: NOW + 60_000,
				signal: abortedSignal(),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "timeout" });
		expect(requests).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 11: ошибки протокольного слоя всплывают неизменными
// ---------------------------------------------------------------------------

describe("CalDavProvider.load — проброс ошибок протокола", () => {
	it("queryCalendarData 401 → authentication_failed всплывает как есть", async () => {
		const credential: CalDavCredential = { ...CREDENTIAL, collections: { [KEY_A]: HREF_A } };
		const { http, requests } = scriptedHttp([{ status: 401, text: "" }]);
		const provider = new CalDavProvider({
			http,
			credentials: credentialPort({ acc1: credential }),
			now: () => NOW,
		});

		let caught: unknown;
		try {
			await provider.load(sourceRef(), WINDOW, opts());
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ code: "authentication_failed" });
		assertHygienicMessage((caught as Error).message);
		expect(requests).toHaveLength(1);
	});
});
