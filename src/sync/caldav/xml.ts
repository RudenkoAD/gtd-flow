/**
 * Ограниченный namespace-aware разбор WebDAV/CalDAV XML (§6.4 CalDAV-заказа).
 *
 * Поверх saxes (namespace URI, не префиксы) — с обязательными бюджетами:
 * байтовый лимит и запрет DOCTYPE/ENTITY проверяются ДО парсера, глубина,
 * число элементов и суммарный текст — по ходу. Любая ошибка/превышение —
 * типизированная ExternalSyncError с кодом invalid_xml/response_too_large:
 * сырой текст ответа сервера в сообщение не попадает.
 *
 * Модуль чистый: без obsidian, тестируется в node.
 */
import { SaxesParser } from "saxes";
import { ExternalSyncError } from "../externalSyncStatus";

export interface XmlBudget {
	/** Максимум байт (UTF-8) всего документа до парсинга. */
	maxBytes: number;
	/** Максимальная глубина вложенности элементов. */
	maxDepth: number;
	/** Максимум элементов в документе. */
	maxElements: number;
	/** Суммарный лимит текстового содержимого (символы). */
	maxTotalTextChars: number;
}

export const DEFAULT_DAV_XML_BUDGET: XmlBudget = {
	maxBytes: 12 * 1024 * 1024,
	maxDepth: 24,
	maxElements: 40_000,
	maxTotalTextChars: 11 * 1024 * 1024,
};

/** Разобранный элемент: имена — ТОЛЬКО пары (namespace URI, local name). */
export interface XmlElement {
	uri: string;
	local: string;
	children: XmlElement[];
	/** Сцепленный текст прямых текстовых узлов (без текста детей). */
	text: string;
}

const utf8Length = (() => {
	const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
	return (text: string): number =>
		encoder !== null ? encoder.encode(text).length : text.length * 2;
})();

/** Пре-скан до парсера: байтовый бюджет и запрет DTD-конструкций (fail-closed).
 *  Сам saxes сущности не разворачивает, но полагаться на поведение библиотеки
 *  в вопросе безопасности нельзя — отклоняем декларации до неё. */
function preflight(text: string, budget: XmlBudget): void {
	if (utf8Length(text) > budget.maxBytes)
		throw new ExternalSyncError("response_too_large", "XML response exceeds byte budget");
	if (/<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/iu.test(text))
		throw new ExternalSyncError("invalid_xml", "DOCTYPE/DTD constructs are not allowed");
}

/**
 * Разобрать XML-документ в дерево с бюджетами. Возвращает корневой элемент.
 * Ошибки парсера/структуры → invalid_xml; превышения → response_too_large
 * (байты) или invalid_xml (структурные лимиты — глубина/число элементов).
 */
export function parseXml(text: string, budget: XmlBudget = DEFAULT_DAV_XML_BUDGET): XmlElement {
	preflight(text, budget);
	const parser = new SaxesParser({ xmlns: true });
	const stack: XmlElement[] = [];
	let root: XmlElement | null = null;
	let elements = 0;
	let textChars = 0;
	let failure: ExternalSyncError | null = null;
	const fail = (error: ExternalSyncError): void => {
		failure ??= error;
	};

	parser.on("error", () => fail(new ExternalSyncError("invalid_xml", "malformed XML")));
	parser.on("doctype", () =>
		fail(new ExternalSyncError("invalid_xml", "DOCTYPE/DTD constructs are not allowed")),
	);
	parser.on("opentag", (tag) => {
		if (failure !== null) return;
		elements++;
		if (elements > budget.maxElements) {
			fail(new ExternalSyncError("invalid_xml", "XML element budget exceeded"));
			return;
		}
		if (stack.length + 1 > budget.maxDepth) {
			fail(new ExternalSyncError("invalid_xml", "XML depth budget exceeded"));
			return;
		}
		const element: XmlElement = {
			uri: tag.uri ?? "",
			local: tag.local,
			children: [],
			text: "",
		};
		const parent = stack[stack.length - 1];
		if (parent !== undefined) parent.children.push(element);
		else if (root === null) root = element;
		else {
			fail(new ExternalSyncError("invalid_xml", "multiple XML roots"));
			return;
		}
		stack.push(element);
	});
	parser.on("closetag", () => {
		if (failure !== null) return;
		stack.pop();
	});
	parser.on("text", (chunk) => {
		if (failure !== null) return;
		textChars += chunk.length;
		if (textChars > budget.maxTotalTextChars) {
			fail(new ExternalSyncError("response_too_large", "XML text budget exceeded"));
			return;
		}
		const current = stack[stack.length - 1];
		if (current !== undefined) current.text += chunk;
	});
	parser.on("cdata", (chunk) => {
		if (failure !== null) return;
		textChars += chunk.length;
		if (textChars > budget.maxTotalTextChars) {
			fail(new ExternalSyncError("response_too_large", "XML text budget exceeded"));
			return;
		}
		const current = stack[stack.length - 1];
		if (current !== undefined) current.text += chunk;
	});

	try {
		parser.write(text).close();
	} catch {
		throw failure ?? new ExternalSyncError("invalid_xml", "malformed XML");
	}
	if (failure !== null) throw failure;
	if (root === null) throw new ExternalSyncError("invalid_xml", "empty XML document");
	return root;
}

export const DAV_NS = "DAV:";
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";

export function childrenOf(el: XmlElement, uri: string, local: string): XmlElement[] {
	return el.children.filter((child) => child.uri === uri && child.local === local);
}

export function firstChild(el: XmlElement, uri: string, local: string): XmlElement | null {
	return childrenOf(el, uri, local)[0] ?? null;
}

/** Первый вложенный элемент по пути имён (каждый шаг — (uri, local)). */
export function descend(
	el: XmlElement,
	...path: ReadonlyArray<readonly [string, string]>
): XmlElement | null {
	let current: XmlElement | null = el;
	for (const [uri, local] of path) {
		if (current === null) return null;
		current = firstChild(current, uri, local);
	}
	return current;
}
