import { describe, expect, it } from "vitest";
import { parseDatePayload, parseTaskLine, type ParseContext } from "./parseTaskLine";
import { fnv1a } from "./taskKey";
import type { Priority } from "../model/Task";

const NBSP = " ";

function ctx(over: Partial<ParseContext> = {}): ParseContext {
	return {
		filePath: "GTD/Inbox.md",
		lineStart: 4,
		parentLine: null,
		heading: null,
		container: "plain",
		projectActive: true,
		...over,
	};
}

describe("parseTaskLine: все поля", () => {
	const line =
		"  - [/] Fix pump #home/garage ⏫ 🔁 every month on the last day " +
		"🛫 2026-07-01 ⏳ 2026-07-02 📅 2026-07-03 ➕ 2026-06-01 ✅ 2026-07-10 " +
		"❌ 2026-07-11 🔜 2026-08-31 🆔 fix-1 ⛔ dep1,dep2 🧬 tpl-9 ^blk1";

	it("вычленяет каждое эмодзи-поле", () => {
		const t = parseTaskLine(line, ctx())!;
		expect(t.statusChar).toBe("/");
		expect(t.priority).toBe("high");
		expect(t.recurrence).toBe("every month on the last day");
		expect(t.start).toBe("2026-07-01");
		expect(t.scheduled).toBe("2026-07-02");
		expect(t.due).toBe("2026-07-03");
		expect(t.created).toBe("2026-06-01");
		expect(t.done).toBe("2026-07-10");
		expect(t.cancelled).toBe("2026-07-11");
		expect(t.nextSpawn).toBe("2026-08-31");
		expect(t.taskId).toBe("fix-1");
		expect(t.dependsOn).toEqual(["dep1", "dep2"]);
		expect(t.spawnedFrom).toBe("tpl-9");
	});

	it("description: без токенов полей, теги остаются, пробелы схлопнуты", () => {
		const t = parseTaskLine(line, ctx())!;
		expect(t.description).toBe("Fix pump #home/garage");
		expect(t.tags).toEqual(["#home/garage"]);
	});

	it("rawLine хранится дословно; key = id:<🆔>", () => {
		const t = parseTaskLine(line, ctx())!;
		expect(t.rawLine).toBe(line);
		expect(t.key).toBe("id:fix-1");
	});

	it("контекст файла переносится в Task", () => {
		const c = ctx({
			filePath: "Projects/Kitchen.md",
			lineStart: 12,
			parentLine: 10,
			heading: "Этап 1",
			container: "project",
			projectActive: false,
		});
		const t = parseTaskLine(line, c)!;
		expect(t.filePath).toBe("Projects/Kitchen.md");
		expect(t.lineStart).toBe(12);
		expect(t.lineEnd).toBe(12);
		expect(t.parentLine).toBe(10);
		expect(t.heading).toBe("Этап 1");
		expect(t.container).toBe("project");
		expect(t.projectActive).toBe(false);
	});
});

describe("parseTaskLine: приоритеты", () => {
	const cases: [string, Priority][] = [
		["🔺", "highest"],
		["⏫", "high"],
		["🔼", "medium"],
		["🔽", "low"],
		["⏬", "lowest"],
	];
	for (const [emoji, prio] of cases) {
		it(`${emoji} → ${prio}`, () => {
			expect(parseTaskLine(`- [ ] T ${emoji}`, ctx())!.priority).toBe(prio);
		});
	}
	it("без эмодзи → none", () => {
		expect(parseTaskLine("- [ ] T", ctx())!.priority).toBe("none");
	});
	it("приоритет в середине текста не рвёт описание", () => {
		const t = parseTaskLine("- [ ] Mixed 🔼 stuff", ctx())!;
		expect(t.priority).toBe("medium");
		expect(t.description).toBe("Mixed stuff");
	});
});

describe("parseTaskLine: дубли полей — последний побеждает", () => {
	it("две даты", () => {
		const t = parseTaskLine("- [ ] T 📅 2026-01-01 📅 2026-02-02", ctx())!;
		expect(t.due).toBe("2026-02-02");
		expect(t.rawLine).toContain("2026-01-01"); // оба сохранены в rawLine
	});
	it("два id", () => {
		const t = parseTaskLine("- [ ] T 🆔 a 🆔 b", ctx())!;
		expect(t.taskId).toBe("b");
		expect(t.key).toBe("id:b");
	});
	it("последний дубль с мусором обнуляет поле", () => {
		const t = parseTaskLine("- [ ] T 📅 2026-01-01 📅 nope", ctx())!;
		expect(t.due).toBeNull();
	});
	it("два приоритета", () => {
		expect(parseTaskLine("- [ ] T ⏫ 🔽", ctx())!.priority).toBe("low");
	});
});

describe("parseTaskLine: офсеты ±Nd в шаблонах", () => {
	it("офсеты не попадают в даты, но живут в rawLine", () => {
		const t = parseTaskLine(
			"- [ ] Tpl 🔁 every month on the 1st 🛫 -3d 📅 +14d",
			ctx({ container: "recurring" }),
		)!;
		expect(t.start).toBeNull();
		expect(t.due).toBeNull();
		expect(t.recurrence).toBe("every month on the 1st");
		expect(t.rawLine).toContain("🛫 -3d");
		expect(t.rawLine).toContain("📅 +14d");
		expect(t.description).toBe("Tpl");
	});
});

describe("parseDatePayload", () => {
	it("валидная дата", () => {
		expect(parseDatePayload("2026-07-15")).toEqual({ kind: "date", date: "2026-07-15" });
	});
	it("валидация диапазонов", () => {
		expect(parseDatePayload("2026-13-01").kind).toBe("invalid");
		expect(parseDatePayload("2026-00-10").kind).toBe("invalid");
		expect(parseDatePayload("2026-01-32").kind).toBe("invalid");
		expect(parseDatePayload("2026-01-00").kind).toBe("invalid");
	});
	it("календарная валидация: несуществующие даты — invalid", () => {
		expect(parseDatePayload("2026-02-30").kind).toBe("invalid");
		expect(parseDatePayload("2026-02-29").kind).toBe("invalid"); // 2026 не високосный
		expect(parseDatePayload("2026-04-31").kind).toBe("invalid");
		expect(parseDatePayload("2028-02-29")).toEqual({ kind: "date", date: "2028-02-29" });
		expect(parseDatePayload("2000-02-29")).toEqual({ kind: "date", date: "2000-02-29" });
		expect(parseDatePayload("2100-02-29").kind).toBe("invalid"); // век без високоса
	});
	it("офсеты", () => {
		expect(parseDatePayload("-3d")).toEqual({ kind: "offset", offset: { sign: -1, days: 3 } });
		expect(parseDatePayload("+14d")).toEqual({ kind: "offset", offset: { sign: 1, days: 14 } });
	});
	it("пусто и мусор", () => {
		expect(parseDatePayload("").kind).toBe("empty");
		expect(parseDatePayload("tomorrow").kind).toBe("invalid");
		expect(parseDatePayload("3d").kind).toBe("invalid");
	});
});

describe("parseTaskLine: ⛔ зависимости", () => {
	it("несколько id без пробелов", () => {
		expect(parseTaskLine("- [ ] T ⛔ a1,b2,c3", ctx())!.dependsOn).toEqual(["a1", "b2", "c3"]);
	});
	it("пробелы после запятой терпимы", () => {
		expect(parseTaskLine("- [ ] T ⛔ a1, b2", ctx())!.dependsOn).toEqual(["a1", "b2"]);
	});
	it("текст после списка не попадает в зависимости", () => {
		const t = parseTaskLine("- [ ] T ⛔ a1, b2 rest here", ctx())!;
		expect(t.dependsOn).toEqual(["a1", "b2"]);
		expect(t.description).toBe("T rest here");
	});
});

describe("parseTaskLine: теги", () => {
	it("несколько тегов, включая kanban-колонку и #waiting", () => {
		const t = parseTaskLine("- [ ] Do it #kanban/work/todo #waiting #x", ctx())!;
		expect(t.tags).toEqual(["#kanban/work/todo", "#waiting", "#x"]);
		expect(t.description).toBe("Do it #kanban/work/todo #waiting #x");
	});
	it("повторный тег не дублируется в tags[]", () => {
		const t = parseTaskLine("- [ ] a #x b #x", ctx())!;
		expect(t.tags).toEqual(["#x"]);
	});
	it("тег после поля тоже виден", () => {
		const t = parseTaskLine("- [ ] a 📅 2026-01-01 #late", ctx())!;
		expect(t.tags).toEqual(["#late"]);
		expect(t.description).toBe("a #late");
	});
	it("тег внутри payload 🔁 НЕ извлекается (payload — не текст)", () => {
		const t = parseTaskLine("- [ ] X 🔁 every day #next", ctx())!;
		expect(t.tags).toEqual([]);
		expect(t.recurrence).toBe("every day #next");
	});
});

describe("parseTaskLine: не-задачи и кромки", () => {
	it("не-задачи дают null", () => {
		for (const line of ["", "plain", "- item", "* item2", "-[ ] a", "1. [ ] d", "> [ ] q"]) {
			expect(parseTaskLine(line, ctx()), line).toBeNull();
		}
	});

	it("NBSP между полями: парсится штатно, в description NBSP схлопнут", () => {
		const t = parseTaskLine(`- [ ] Pay${NBSP}rent${NBSP}📅${NBSP}2026-08-01`, ctx())!;
		expect(t.due).toBe("2026-08-01");
		expect(t.description).toBe("Pay rent");
	});

	it("невалидная дата: поле null, токен вырезан из description", () => {
		const t = parseTaskLine("- [ ] Call 📅 tomorrow", ctx())!;
		expect(t.due).toBeNull();
		expect(t.description).toBe("Call");
	});

	it("пустое описание", () => {
		const t = parseTaskLine("- [ ] 📅 2026-01-01", ctx())!;
		expect(t.description).toBe("");
		expect(t.due).toBe("2026-01-01");
	});

	it("голый 🆔 не даёт id", () => {
		const t = parseTaskLine("- [ ] X 🆔", ctx())!;
		expect(t.taskId).toBeNull();
		expect(t.key.startsWith("GTD/Inbox.md#")).toBe(true);
	});

	it("вложенная задача с отступом", () => {
		const t = parseTaskLine("\t\t- [ ] Sub", ctx({ parentLine: 3 }))!;
		expect(t.description).toBe("Sub");
		expect(t.parentLine).toBe(3);
	});

	it("^block-id не попадает в description", () => {
		const t = parseTaskLine("- [ ] Task text ^blk9", ctx())!;
		expect(t.description).toBe("Task text");
		expect(t.rawLine).toContain("^blk9");
	});

	it("хвостовой \\r (CRLF): description и key совпадают с LF-двойником", () => {
		const cr = parseTaskLine("- [ ] Task ^abc\r", ctx({ filePath: "f.md" }))!;
		const lf = parseTaskLine("- [ ] Task ^abc", ctx({ filePath: "f.md" }))!;
		expect(cr.description).toBe("Task"); // ^abc не утёк в описание
		expect(cr.key).toBe(lf.key); // CRLF→LF нормализация не меняет identity
		expect(cr.rawLine).toBe("- [ ] Task ^abc\r"); // rawLine дословно
	});
});

describe("parseTaskLine: content-key", () => {
	it("без 🆔 — путь + fnv1a(описание) + порядковый 0", () => {
		const t = parseTaskLine("- [ ] Same text", ctx({ filePath: "a.md" }))!;
		const hash = fnv1a("Same text").toString(16).padStart(8, "0");
		expect(t.key).toBe(`a.md#${hash}#0`);
	});
	it("одинаковые описания в разных файлах — разные ключи", () => {
		const t1 = parseTaskLine("- [ ] Same", ctx({ filePath: "a.md" }))!;
		const t2 = parseTaskLine("- [ ] Same", ctx({ filePath: "b.md" }))!;
		expect(t1.key).not.toBe(t2.key);
	});
});
