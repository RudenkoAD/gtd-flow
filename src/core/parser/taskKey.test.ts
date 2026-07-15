import { describe, expect, it } from "vitest";
import { computeKey, fnv1a, normalizeDescription } from "./taskKey";
import { parseTaskLine } from "./parseTaskLine";

describe("fnv1a: канонические вектора 32-битного FNV-1a", () => {
	it("пустая строка = offset basis", () => {
		expect(fnv1a("")).toBe(0x811c9dc5);
	});
	it('"a"', () => {
		expect(fnv1a("a")).toBe(0xe40c292c);
	});
	it('"foobar"', () => {
		expect(fnv1a("foobar")).toBe(0xbf9cf968);
	});
	it("детерминирован и различает не-ASCII строки (UTF-8 байты)", () => {
		expect(fnv1a("привет")).toBe(fnv1a("привет"));
		expect(fnv1a("привет")).not.toBe(fnv1a("привёт"));
		expect(fnv1a("日本")).not.toBe(fnv1a("日木"));
	});
});

describe("normalizeDescription", () => {
	it("trim и схлопывание пробелов", () => {
		expect(normalizeDescription("  Buy   milk  ")).toBe("Buy milk");
	});
	it("вырезает токены полей из полной строки задачи, теги сохраняет", () => {
		expect(normalizeDescription("- [x] Buy milk 📅 2026-01-01 #store ⏫")).toBe(
			"Buy milk #store",
		);
	});
	it("вырезает поля и из фрагмента текста", () => {
		expect(normalizeDescription("Call 🆔 x9")).toBe("Call");
	});
	it("совпадает с Task.description после парса", () => {
		const line = "- [ ]   Fix   pump 🛫 2026-07-01 #home";
		const t = parseTaskLine(line, {
			filePath: "a.md",
			lineStart: 0,
			parentLine: null,
			heading: null,
			container: "plain",
			projectActive: true,
		})!;
		expect(normalizeDescription(line)).toBe(t.description);
	});
});

describe("computeKey", () => {
	it("🆔 имеет приоритет над content-key", () => {
		expect(computeKey({ taskId: "abc-1", filePath: "a.md", description: "whatever" })).toBe(
			"id:abc-1",
		);
	});
	it("пустой id не считается id", () => {
		expect(computeKey({ taskId: "", filePath: "a.md", description: "x" }).startsWith("a.md#")).toBe(
			true,
		);
	});
	it("occurrenceIndex дизамбигуирует одинаковые строки", () => {
		const src = { taskId: null, filePath: "a.md", description: "Same" };
		expect(computeKey(src, 0)).not.toBe(computeKey(src, 1));
		expect(computeKey(src, 0)).toBe(computeKey(src)); // default 0
	});
	it("нормализация: лишние пробелы не меняют ключ", () => {
		const k1 = computeKey({ taskId: null, filePath: "a.md", description: "A  B" });
		const k2 = computeKey({ taskId: null, filePath: "a.md", description: " A B " });
		expect(k1).toBe(k2);
	});
	it("описание с полями и без них даёт один ключ", () => {
		const k1 = computeKey({ taskId: null, filePath: "a.md", description: "Call 📅 2026-01-01" });
		const k2 = computeKey({ taskId: null, filePath: "a.md", description: "Call" });
		expect(k1).toBe(k2);
	});
	it("разные файлы — разные ключи", () => {
		const k1 = computeKey({ taskId: null, filePath: "a.md", description: "X" });
		const k2 = computeKey({ taskId: null, filePath: "b.md", description: "X" });
		expect(k1).not.toBe(k2);
	});
	it("когерентность с parseTaskLine: computeKey(task) === task.key", () => {
		const mk = (line: string) =>
			parseTaskLine(line, {
				filePath: "GTD/Inbox.md",
				lineStart: 1,
				parentLine: null,
				heading: null,
				container: "plain",
				projectActive: true,
			})!;
		const withId = mk("- [ ] A 🆔 q1");
		expect(computeKey(withId)).toBe(withId.key);
		const noId = mk("- [ ] Plain task #tag 📅 2026-01-01");
		expect(computeKey(noId)).toBe(noId.key);
	});
});
