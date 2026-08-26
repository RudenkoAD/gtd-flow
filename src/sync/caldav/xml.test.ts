/**
 * Тесты для ограниченного namespace-aware XML-парсера CalDAV (src/sync/caldav/xml.ts).
 *
 * Проверяем: сопоставление по (namespace URI, local) независимо от префиксов
 * (§ спорных префиксов и default-namespace), корректность .text (entities/CDATA),
 * fail-closed поведение на DOCTYPE/DTD/неопределённых сущностях, все четыре
 * бюджета (байты/глубина/элементы/суммарный текст) и инвариант санитизации —
 * сообщение ошибки никогда не содержит сырой текст документа.
 */
import { describe, expect, it } from "vitest";
import { ExternalSyncError } from "../externalSyncStatus";
import {
	CALDAV_NS,
	DAV_NS,
	DEFAULT_DAV_XML_BUDGET,
	childrenOf,
	descend,
	firstChild,
	parseXml,
} from "./xml";
import type { XmlBudget } from "./xml";

/** parseXml() кидает — оборачиваем ожидание throw в один хелпер для всех тестов. */
function expectThrows(text: string, budget?: XmlBudget): ExternalSyncError {
	let captured: unknown;
	try {
		parseXml(text, budget);
	} catch (e) {
		captured = e;
	}
	expect(captured).toBeInstanceOf(ExternalSyncError);
	return captured as ExternalSyncError;
}

describe("parseXml/childrenOf/firstChild/descend — сопоставление по (namespace URI, local), а не по префиксу", () => {
	it("необычные префиксы (x0: для DAV:, cd: для caldav) — элементы находятся по URI", () => {
		const xml = `<?xml version="1.0" encoding="utf-8"?>
<x0:multistatus xmlns:x0="${DAV_NS}" xmlns:cd="${CALDAV_NS}">
	<x0:response>
		<x0:href>/cal/1.ics</x0:href>
		<x0:propstat>
			<x0:prop>
				<cd:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</cd:calendar-data>
			</x0:prop>
			<x0:status>HTTP/1.1 200 OK</x0:status>
		</x0:propstat>
	</x0:response>
</x0:multistatus>`;
		const root = parseXml(xml);
		expect(root.uri).toBe(DAV_NS);
		expect(root.local).toBe("multistatus");

		const response = firstChild(root, DAV_NS, "response");
		expect(response).not.toBeNull();

		// то же самое дерево через чужой (не x0:) namespace-URI не находится
		expect(firstChild(root, CALDAV_NS, "response")).toBeNull();

		const calendarData = descend(
			response!,
			[DAV_NS, "propstat"],
			[DAV_NS, "prop"],
			[CALDAV_NS, "calendar-data"],
		);
		expect(calendarData).not.toBeNull();
		expect(calendarData!.text).toContain("BEGIN:VCALENDAR");
	});

	it('default-namespace (xmlns="DAV:") резолвится так же, как явный префикс', () => {
		const xml = `<multistatus xmlns="${DAV_NS}" xmlns:cd="${CALDAV_NS}">
	<response>
		<propstat>
			<prop><cd:calendar-data>X</cd:calendar-data></prop>
		</propstat>
	</response>
</multistatus>`;
		const root = parseXml(xml);
		expect(root.uri).toBe(DAV_NS);
		expect(root.local).toBe("multistatus");
		const data = descend(
			root,
			[DAV_NS, "response"],
			[DAV_NS, "propstat"],
			[DAV_NS, "prop"],
			[CALDAV_NS, "calendar-data"],
		);
		expect(data?.text).toBe("X");
	});

	it("переопределённый (shadowed) префикс во вложенном элементе — резолвится по фактическому URI в этой области видимости", () => {
		// один и тот же префикс "d:" сначала связан с DAV:, затем на вложенном
		// элементе (и внутри него) переобъявлен на caldav — резолвиться должно
		// по фактическому URI в области видимости, а не по тексту префикса.
		const xml = `<d:root xmlns:d="${DAV_NS}">
	<d:child xmlns:d="${CALDAV_NS}">
		<d:calendar-data>SHADOWED</d:calendar-data>
	</d:child>
</d:root>`;
		const root = parseXml(xml);
		expect(root.uri).toBe(DAV_NS);

		// child сам объявляет новый xmlns:d на себе — его собственный uri уже caldav
		expect(firstChild(root, DAV_NS, "child")).toBeNull();
		const child = firstChild(root, CALDAV_NS, "child");
		expect(child).not.toBeNull();

		expect(childrenOf(child!, DAV_NS, "calendar-data")).toHaveLength(0);
		expect(childrenOf(child!, CALDAV_NS, "calendar-data")).toHaveLength(1);
		expect(firstChild(child!, CALDAV_NS, "calendar-data")?.text).toBe("SHADOWED");
	});
});

describe("XML-сущности в текстовом содержимом", () => {
	it("&amp;, &lt; и числовая сущность &#x2F; корректно раскрываются в .text (href)", () => {
		const xml = `<href xmlns="${DAV_NS}">/cal/foo&amp;bar&lt;baz&#x2F;qux</href>`;
		const root = parseXml(xml);
		expect(root.local).toBe("href");
		expect(root.text).toBe("/cal/foo&bar<baz/qux");
	});
});

describe("CDATA", () => {
	it("содержимое CDATA попадает в .text как есть, без повторного экранирования", () => {
		const xml = `<calendar-data xmlns="${CALDAV_NS}"><![CDATA[BEGIN:VCALENDAR & <weird> content]]></calendar-data>`;
		const root = parseXml(xml);
		expect(root.text).toBe("BEGIN:VCALENDAR & <weird> content");
	});
});

describe("DOCTYPE/DTD — запрещены, отклоняются fail-closed ещё до парсера", () => {
	it("DOCTYPE с внутренним DTD/ENTITY (XXE-подобная форма) → invalid_xml", () => {
		const xml = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe "pwned"> ]>
<foo>&xxe;</foo>`;
		const err = expectThrows(xml);
		expect(err.code).toBe("invalid_xml");
	});

	it("голый <!DOCTYPE html> без internal subset тоже отклоняется", () => {
		const err = expectThrows("<!DOCTYPE html>\n<html></html>");
		expect(err.code).toBe("invalid_xml");
	});

	it("проверка регистронезависимая: <!doctype ...> в нижнем регистре тоже отклоняется", () => {
		const err = expectThrows("<!doctype foo>\n<foo/>");
		expect(err.code).toBe("invalid_xml");
	});
});

describe("некорректный XML", () => {
	it("незакрытый тег → invalid_xml", () => {
		const err = expectThrows("<a><b></a>");
		expect(err.code).toBe("invalid_xml");
	});

	it("произвольный мусор вместо XML → invalid_xml", () => {
		const err = expectThrows("not xml at all");
		expect(err.code).toBe("invalid_xml");
	});
});

describe("несколько корневых элементов", () => {
	it("два корневых элемента подряд → invalid_xml", () => {
		const err = expectThrows("<a/><b/>");
		expect(err.code).toBe("invalid_xml");
	});
});

describe("пустой документ", () => {
	it("пустая строка → invalid_xml", () => {
		expect(expectThrows("").code).toBe("invalid_xml");
	});

	it("только пробельные символы → invalid_xml", () => {
		expect(expectThrows("   \n\t  ").code).toBe("invalid_xml");
	});
});

describe("бюджет глубины (budget.maxDepth)", () => {
	it("документ глубже бюджета → invalid_xml", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxDepth: 2 };
		// root(1) → a(2) → b(3) — третий уровень превышает maxDepth=2
		const err = expectThrows("<root><a><b/></a></root>", budget);
		expect(err.code).toBe("invalid_xml");
	});

	it("документ ровно на границе бюджета глубины парсится успешно", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxDepth: 2 };
		const root = parseXml("<root><a/></root>", budget);
		expect(firstChild(root, "", "a")).not.toBeNull();
	});
});

describe("бюджет числа элементов (budget.maxElements)", () => {
	it("элементов больше бюджета → invalid_xml", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxElements: 2 };
		// root + a + b = 3 элемента > 2
		const err = expectThrows("<root><a/><b/></root>", budget);
		expect(err.code).toBe("invalid_xml");
	});

	it("документ ровно на границе бюджета элементов парсится успешно", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxElements: 2 };
		const root = parseXml("<root><a/></root>", budget); // ровно 2 элемента
		expect(firstChild(root, "", "a")).not.toBeNull();
	});
});

describe("байтовый бюджет (budget.maxBytes)", () => {
	it("документ больше бюджета в байтах → response_too_large", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxBytes: 20 };
		const xml = `<root>${"x".repeat(100)}</root>`;
		const err = expectThrows(xml, budget);
		expect(err.code).toBe("response_too_large");
	});
});

describe("бюджет суммарного текста (budget.maxTotalTextChars)", () => {
	it("текст одного элемента больше бюджета → response_too_large", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxTotalTextChars: 5 };
		const err = expectThrows("<root>hello world</root>", budget);
		expect(err.code).toBe("response_too_large");
	});

	it("бюджет считается по СУММЕ текста всех узлов, а не по одному элементу", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxTotalTextChars: 5 };
		// ни один узел сам по себе (3 символа) не превышает лимит, но 3+3=6 > 5
		const err = expectThrows("<root><a>abc</a><b>abc</b></root>", budget);
		expect(err.code).toBe("response_too_large");
	});
});

describe("неопределённые сущности", () => {
	it("&xxe; без объявления → invalid_xml (fail-closed, а не молчаливый пропуск)", () => {
		const err = expectThrows("<root>&xxe;</root>");
		expect(err.code).toBe("invalid_xml");
	});
});

describe("реалистичный calendar-query 207-ответ (два <response> с calendar-data)", () => {
	const CRLF_CALENDAR =
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nEND:VEVENT\r\nEND:VCALENDAR";

	function multistatus(entries: ReadonlyArray<readonly [string, string]>): string {
		const responses = entries
			.map(
				([href, data]) => `\t<D:response>
		<D:href>${href}</D:href>
		<D:propstat>
			<D:prop>
				<C:calendar-data>${data}</C:calendar-data>
			</D:prop>
			<D:status>HTTP/1.1 200 OK</D:status>
		</D:propstat>
	</D:response>`,
			)
			.join("\n");
		return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="${DAV_NS}" xmlns:C="${CALDAV_NS}">
${responses}
</D:multistatus>`;
	}

	it("форма дерева читается через descend(); оба calendar-data извлекаются целиком", () => {
		const xml = multistatus([
			["/cal/1.ics", CRLF_CALENDAR],
			["/cal/2.ics", CRLF_CALENDAR.replace("UID:1", "UID:2")],
		]);
		const root = parseXml(xml);
		expect(root.uri).toBe(DAV_NS);
		expect(root.local).toBe("multistatus");

		const responses = childrenOf(root, DAV_NS, "response");
		expect(responses).toHaveLength(2);
		const [first, second] = responses;

		expect(descend(first!, [DAV_NS, "href"])?.text).toBe("/cal/1.ics");
		expect(descend(second!, [DAV_NS, "href"])?.text).toBe("/cal/2.ics");

		const data1 = descend(
			first!,
			[DAV_NS, "propstat"],
			[DAV_NS, "prop"],
			[CALDAV_NS, "calendar-data"],
		);
		const data2 = descend(
			second!,
			[DAV_NS, "propstat"],
			[DAV_NS, "prop"],
			[CALDAV_NS, "calendar-data"],
		);
		expect(data1).not.toBeNull();
		expect(data2).not.toBeNull();

		// XML 1.0 §2.11 требует от парсера нормализовать CRLF/CR к LF в текстовых
		// узлах — это поведение saxes (и любого спек-совместимого парсера), а не
		// потеря данных: строки и их порядок сохраняются целиком.
		expect(data1!.text).toBe(CRLF_CALENDAR.replace(/\r\n/g, "\n"));
		expect(data2!.text).toContain("UID:2");
		expect(data1!.text.split("\n")).toEqual([
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			"UID:1",
			"END:VEVENT",
			"END:VCALENDAR",
		]);
	});
});

describe("санитизация: сообщение ошибки никогда не содержит текст документа", () => {
	const MARKER = "TOTALLY_SECRET_MARKER_9f3c";

	it("незакрытый тег с маркером в теле — маркер не попадает в message", () => {
		const err = expectThrows(`<a>${MARKER}<b></a>`);
		expect(err.message).not.toContain(MARKER);
	});

	it("DOCTYPE с маркером внутри ENTITY — маркер не попадает в message", () => {
		const err = expectThrows(`<!DOCTYPE foo [ <!ENTITY x "${MARKER}"> ]>\n<foo>&x;</foo>`);
		expect(err.message).not.toContain(MARKER);
	});

	it("превышение байтового бюджета с маркером в тексте — маркер не попадает в message", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxBytes: 10 };
		const err = expectThrows(`<root>${MARKER}</root>`, budget);
		expect(err.message).not.toContain(MARKER);
	});

	it("превышение текстового бюджета с маркером в тексте — маркер не попадает в message", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxTotalTextChars: 5 };
		const err = expectThrows(`<root>${MARKER}</root>`, budget);
		expect(err.message).not.toContain(MARKER);
	});

	it("превышение бюджета числа элементов с маркером в имени тега — маркер не попадает в message", () => {
		const budget: XmlBudget = { ...DEFAULT_DAV_XML_BUDGET, maxElements: 1 };
		const err = expectThrows(`<root><${MARKER}-tag/></root>`, budget);
		expect(err.message).not.toContain(MARKER);
	});

	it("неопределённая сущность с маркером в имени — маркер не попадает в message", () => {
		const err = expectThrows(`<root>&${MARKER};</root>`);
		expect(err.message).not.toContain(MARKER);
	});
});
