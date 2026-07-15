import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	addTag,
	removeTag,
	setDependsOn,
	setField,
	setPriority,
	setStatusChar,
	setValueField,
} from "./serializeTaskLine";
import { parseTaskLine, type ParseContext } from "./parseTaskLine";
import { tokenizeTaskLine } from "./tokenizer";
import { PRIORITY_EMOJI } from "./emoji";
import type { Priority } from "../model/Task";

const NBSP = " ";

function ctx(): ParseContext {
	return {
		filePath: "GTD/Inbox.md",
		lineStart: 0,
		parentLine: null,
		heading: null,
		container: "plain",
		projectActive: true,
	};
}

describe("setField: золотые случаи", () => {
	it("вставка в конец строки", () => {
		expect(setField("- [ ] Task", "due", "2026-01-05")).toBe("- [ ] Task 📅 2026-01-05");
	});
	it("вставка перед ^block-id", () => {
		expect(setField("- [ ] Task ^b1", "due", "2026-01-05")).toBe(
			"- [ ] Task 📅 2026-01-05 ^b1",
		);
	});
	it("замена меняет только payload", () => {
		expect(setField("- [ ] Task 📅 2026-01-05 ⏫", "due", "2026-02-01")).toBe(
			"- [ ] Task 📅 2026-02-01 ⏫",
		);
	});
	it("удаление съедает ровно один пробел", () => {
		expect(setField("- [ ] Task 📅 2026-01-05 ⏫", "due", null)).toBe("- [ ] Task ⏫");
		expect(setField("- [ ] Task 📅 2026-01-05", "due", null)).toBe("- [ ] Task");
	});
	it("удаление с ^block-id", () => {
		expect(setField("- [ ] Task 📅 2026-01-05 ^b1", "due", null)).toBe("- [ ] Task ^b1");
	});
	it("при дублях замена правит последний токен, удаление убирает все", () => {
		const line = "- [ ] T 📅 2026-01-01 x 📅 2026-02-02";
		expect(setField(line, "due", "2026-03-03")).toBe("- [ ] T 📅 2026-01-01 x 📅 2026-03-03");
		expect(setField(line, "due", null)).toBe("- [ ] T x");
	});
	it("no-op: удалить отсутствующее / записать то же значение", () => {
		expect(setField("- [ ] Task", "due", null)).toBe("- [ ] Task");
		const line = "- [ ] Task 📅 2026-01-05";
		expect(setField(line, "due", "2026-01-05")).toBe(line);
	});
	it("NBSP-разделитель поля переживает замену", () => {
		expect(setField(`- [ ] T 📅${NBSP}2026-01-05`, "due", "2026-02-01")).toBe(
			`- [ ] T 📅${NBSP}2026-02-01`,
		);
	});
	it("каждое из семи полей-дат вставляется своим эмодзи", () => {
		expect(setField("- [ ] T", "scheduled", "2026-01-01")).toBe("- [ ] T ⏳ 2026-01-01");
		expect(setField("- [ ] T", "start", "2026-01-01")).toBe("- [ ] T 🛫 2026-01-01");
		expect(setField("- [ ] T", "created", "2026-01-01")).toBe("- [ ] T ➕ 2026-01-01");
		expect(setField("- [ ] T", "done", "2026-01-01")).toBe("- [ ] T ✅ 2026-01-01");
		expect(setField("- [ ] T", "cancelled", "2026-01-01")).toBe("- [ ] T ❌ 2026-01-01");
		expect(setField("- [ ] T", "nextSpawn", "2026-01-01")).toBe("- [ ] T 🔜 2026-01-01");
	});
	it("неизвестный хвостовой текст сохраняется дословно", () => {
		expect(setField("- [ ] T 📅 2026-01-01 some trailing note", "due", "2026-05-05")).toBe(
			"- [ ] T 📅 2026-05-05 some trailing note",
		);
	});
	it("бросает на не-задаче и на не-ISO дате", () => {
		expect(() => setField("not a task", "due", "2026-01-01")).toThrow();
		expect(() => setField("- [ ] T", "due", "tomorrow")).toThrow();
	});
});

describe("регрессия: писатель дат не мягче читателя (setField = parseDatePayload)", () => {
	it("даты вне диапазонов отклоняются на записи, а не читаются как null", () => {
		expect(() => setField("- [ ] T", "due", "2026-13-05")).toThrow();
		expect(() => setField("- [ ] T", "due", "2026-00-15")).toThrow();
		expect(() => setField("- [ ] T", "due", "2026-01-32")).toThrow();
		expect(() => setField("- [ ] T", "due", "2026-01-00")).toThrow();
	});
	it("календарно-невозможные даты тоже отклоняются", () => {
		expect(() => setField("- [ ] T", "due", "2026-02-30")).toThrow();
		expect(() => setField("- [ ] T", "due", "2026-02-29")).toThrow(); // не високосный
		expect(() => setField("- [ ] T", "due", "2026-04-31")).toThrow();
	});
	it("29 февраля високосного года — валидная запись и читается обратно", () => {
		const out = setField("- [ ] T", "due", "2028-02-29");
		expect(out).toBe("- [ ] T 📅 2028-02-29");
		expect(parseTaskLine(out, ctx())!.due).toBe("2028-02-29");
	});
});

describe("регрессия: удаление не съедает разделитель после ']' (склеенные поля)", () => {
	it("setPriority none на приклеенном к тексту приоритете", () => {
		const out = setPriority("- [ ] ⏫Call mom", "none");
		expect(out).toBe("- [ ] Call mom");
		expect(tokenizeTaskLine(out)).not.toBeNull();
	});
	it("setField null, когда удаляемое поле приклеено к следующему", () => {
		const out = setField("- [ ] 📅⏳ 2026-01-01", "due", null);
		expect(out).toBe("- [ ] ⏳ 2026-01-01");
		expect(tokenizeTaskLine(out)).not.toBeNull();
	});
	it("reopen-сценарий: снятие ✅ на строке с приклеенным ⏫", () => {
		const out = setField("- [x] ✅ 2026-01-01⏫ Call", "done", null);
		expect(out).toBe("- [x] ⏫ Call");
		expect(parseTaskLine(out, ctx())!.priority).toBe("high");
	});
	it("setDependsOn([]) при склейке со следующим полем", () => {
		const out = setDependsOn("- [ ] ⛔ a1🆔 b1", []);
		expect(out).toBe("- [ ] 🆔 b1");
		expect(tokenizeTaskLine(out)).not.toBeNull();
	});
	it("setValueField null при склейке со следующим полем", () => {
		const out = setValueField("- [ ] 🆔 x📅 2026-01-01", "id", null);
		expect(out).toBe("- [ ] 📅 2026-01-01");
		expect(tokenizeTaskLine(out)).not.toBeNull();
	});
	it("removeTag: тег — единственный текст перед приклеенным полем", () => {
		const out = removeTag("- [ ] #a⏫", "#a");
		expect(out).toBe("- [ ] ⏫");
		expect(tokenizeTaskLine(out)).not.toBeNull();
	});
	it("removeTag: kanban-тег приклеен к ⏫, перенос колонки не падает", () => {
		const removed = removeTag("- [ ] #kanban/w/todo⏫ fix bug", "#kanban/w/todo");
		expect(removed).toBe("- [ ] ⏫ fix bug");
		const moved = addTag(removed, "#kanban/w/doing");
		expect(tokenizeTaskLine(moved)).not.toBeNull();
		expect(parseTaskLine(moved, ctx())!.tags).toEqual(["#kanban/w/doing"]);
	});
	it("removeTag: тег приклеен к 📅 без пробела", () => {
		const out = removeTag("- [ ] #waiting📅2026-01-01", "#waiting");
		expect(out).toBe("- [ ] 📅2026-01-01");
		expect(parseTaskLine(out, ctx())!.due).toBe("2026-01-01");
	});
});

describe("регрессия: тег с эмодзи поля отклоняется (парсер не прочитает его назад)", () => {
	it("эмодзи даты внутри тега", () => {
		expect(() => addTag("- [ ] T", "#kanban/w/📅week")).toThrow();
	});
	it("эмодзи приоритета внутри тега", () => {
		expect(() => addTag("- [ ] T", "#hot⏫stuff")).toThrow();
	});
	it("эмодзи с вариационным селектором U+FE0F", () => {
		expect(() => addTag("- [ ] T", "#x⏳️y")).toThrow();
	});
	it("removeTag разделяет ту же валидацию", () => {
		expect(() => removeTag("- [ ] T", "#a📅b")).toThrow();
	});
});

describe("регрессия: хвостовой \\r (CRLF) — вставки идут перед ^block-id и перед \\r", () => {
	it("setField вставляет ПЕРЕД ^block-id, \\r остаётся в конце", () => {
		expect(setField("- [ ] Task ^abc\r", "due", "2026-01-05")).toBe(
			"- [ ] Task 📅 2026-01-05 ^abc\r",
		);
	});
	it("setField без block-id: поле не попадает после \\r", () => {
		expect(setField("- [ ] Task\r", "due", "2026-01-05")).toBe(
			"- [ ] Task 📅 2026-01-05\r",
		);
	});
	it("no-op правки CRLF-строки дословны", () => {
		const line = "- [ ] Task 📅 2026-01-05 ^abc\r";
		expect(setField(line, "due", "2026-01-05")).toBe(line);
		expect(setField(line, "scheduled", null)).toBe(line);
	});
});

describe("setValueField / setDependsOn", () => {
	it("🆔: вставка, замена, удаление", () => {
		expect(setValueField("- [ ] B", "id", "b1")).toBe("- [ ] B 🆔 b1");
		expect(setValueField("- [ ] B 🆔 b1", "id", "b2")).toBe("- [ ] B 🆔 b2");
		expect(setValueField("- [ ] B 🆔 b1 ⛔ a", "id", null)).toBe("- [ ] B ⛔ a");
	});
	it("🧬: вставка", () => {
		expect(setValueField("- [ ] Copy", "spawnedFrom", "tpl-1")).toBe("- [ ] Copy 🧬 tpl-1");
	});
	it("голый эмодзи получает разделитель при записи значения", () => {
		expect(setValueField("- [ ] X 🆔", "id", "abc")).toBe("- [ ] X 🆔 abc");
	});
	it("⛔: установка, замена, очистка", () => {
		expect(setDependsOn("- [ ] B 🆔 b1", ["a1", "c2"])).toBe("- [ ] B 🆔 b1 ⛔ a1,c2");
		expect(setDependsOn("- [ ] B ⛔ a1 🆔 b1", ["z9"])).toBe("- [ ] B ⛔ z9 🆔 b1");
		expect(setDependsOn("- [ ] B ⛔ a1,c2 🆔 b1", [])).toBe("- [ ] B 🆔 b1");
	});
	it("валидация значений", () => {
		expect(() => setValueField("- [ ] B", "id", "has space")).toThrow();
		expect(() => setValueField("- [ ] B", "id", "")).toThrow();
		expect(() => setDependsOn("- [ ] B", ["a,b"])).toThrow();
	});
});

describe("setStatusChar", () => {
	it("меняет только символ статуса", () => {
		expect(setStatusChar("  * [ ] Mixed 🔼 stuff ^z9", "x")).toBe("  * [x] Mixed 🔼 stuff ^z9");
		expect(setStatusChar("- [x] Done", " ")).toBe("- [ ] Done");
		expect(setStatusChar("- [ ] P", "-")).toBe("- [-] P");
		expect(setStatusChar("- [ ] P", "/")).toBe("- [/] P");
	});
	it("бросает на мусорном статусе", () => {
		expect(() => setStatusChar("- [ ] T", "")).toThrow();
		expect(() => setStatusChar("- [ ] T", "ab")).toThrow();
		expect(() => setStatusChar("- [ ] T", "]")).toThrow();
	});
});

describe("setPriority", () => {
	it("вставка, замена, удаление", () => {
		expect(setPriority("- [ ] T 📅 2026-01-01", "high")).toBe("- [ ] T 📅 2026-01-01 ⏫");
		expect(setPriority("- [ ] T ⏫ x", "low")).toBe("- [ ] T 🔽 x");
		expect(setPriority("- [ ] T ⏫", "none")).toBe("- [ ] T");
	});
	it("none на строке без приоритета — no-op", () => {
		const line = "- [ ] T 📅 2026-01-01";
		expect(setPriority(line, "none")).toBe(line);
	});
	it("вставка перед ^block-id", () => {
		expect(setPriority("- [ ] T ^b", "highest")).toBe("- [ ] T 🔺 ^b");
	});
});

describe("addTag / removeTag", () => {
	it("тег добавляется в конец описания, ПЕРЕД полями", () => {
		expect(addTag("- [ ] Task 📅 2026-01-05", "next")).toBe("- [ ] Task #next 📅 2026-01-05");
		expect(addTag("- [ ] Task", "#next")).toBe("- [ ] Task #next");
	});
	it("guard: тег не должен попадать в payload 🔁", () => {
		const out = addTag("- [ ] X 🔁 every day", "#next");
		expect(out).toBe("- [ ] X #next 🔁 every day");
		const t = parseTaskLine(out, ctx())!;
		expect(t.recurrence).toBe("every day");
		expect(t.tags).toEqual(["#next"]);
	});
	it("существующий тег — no-op", () => {
		const line = "- [ ] Task #next 📅 2026-01-05";
		expect(addTag(line, "#next")).toBe(line);
	});
	it("пустое описание", () => {
		expect(addTag("- [ ]", "a")).toBe("- [ ] #a");
		expect(addTag("- [ ] 📅 2026-01-01", "a")).toBe("- [ ] #a 📅 2026-01-01");
	});
	it("удаление тега из середины съедает один пробел", () => {
		expect(removeTag("- [ ] a #next b", "#next")).toBe("- [ ] a b");
	});
	it("удаляются все вхождения", () => {
		expect(removeTag("- [ ] a #x b #x", "#x")).toBe("- [ ] a b");
	});
	it("#work не цепляет #work/sub и #workx", () => {
		const line = "- [ ] x #work/sub #workx";
		expect(removeTag(line, "#work")).toBe(line);
		expect(removeTag("- [ ] x #work #work/sub", "#work")).toBe("- [ ] x #work/sub");
	});
	it("отсутствующий тег — no-op", () => {
		const line = "- [ ] plain";
		expect(removeTag(line, "#ghost")).toBe(line);
	});
	it("kanban-тег: перенос колонки = removeTag + addTag", () => {
		const moved = addTag(removeTag("- [ ] Card #kanban/work/todo", "#kanban/work/todo"), "#kanban/work/doing");
		expect(moved).toBe("- [ ] Card #kanban/work/doing");
	});
	it("валидация тега", () => {
		expect(() => addTag("- [ ] T", "")).toThrow();
		expect(() => addTag("- [ ] T", "#has space")).toThrow();
		expect(() => addTag("- [ ] T", "#123")).toThrow();
	});
});

// ---------- property-тесты: генератор валидных строк ----------

interface GenLine {
	indent: string;
	bullet: string;
	status: string;
	desc: string;
	tag: string | null;
	prio: Exclude<Priority, "none"> | null;
	rec: string | null;
	start: string | null;
	scheduled: string | null;
	due: string | null;
	id: string | null;
	deps: string[] | null;
	block: string | null;
}

const wordArb = fc
	.array(fc.constantFrom(..."abcdefgXYZ0123".split("")), { minLength: 1, maxLength: 6 })
	.map((cs) => cs.join(""));

const dateArb = fc
	.tuple(
		fc.integer({ min: 2000, max: 2099 }),
		fc.integer({ min: 1, max: 12 }),
		fc.integer({ min: 1, max: 28 }),
	)
	.map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

const idArb = fc
	.tuple(fc.constantFrom(..."abcdef".split("")), fc.array(fc.constantFrom(..."abcdef0123-".split("")), { maxLength: 5 }))
	.map(([h, t]) => h + t.join(""));

const genArb: fc.Arbitrary<GenLine> = fc.record({
	indent: fc.constantFrom("", "  ", "\t"),
	bullet: fc.constantFrom("-", "*", "+"),
	status: fc.constantFrom(" ", "x", "X", "/", "-"),
	desc: fc.array(wordArb, { minLength: 0, maxLength: 4 }).map((ws) => ws.join(" ")),
	tag: fc.option(fc.constantFrom("#home", "#waiting", "#kanban/work/todo", "#next"), { nil: null }),
	prio: fc.option(fc.constantFrom("highest", "high", "medium", "low", "lowest") as fc.Arbitrary<Exclude<Priority, "none">>, { nil: null }),
	rec: fc.option(
		fc.constantFrom("every day", "every 2 weeks on mon, thu", "every month on the last day"),
		{ nil: null },
	),
	start: fc.option(dateArb, { nil: null }),
	scheduled: fc.option(dateArb, { nil: null }),
	due: fc.option(dateArb, { nil: null }),
	id: fc.option(idArb, { nil: null }),
	deps: fc.option(fc.array(idArb, { minLength: 1, maxLength: 3 }), { nil: null }),
	block: fc.option(fc.constantFrom("^ab1", "^x-9"), { nil: null }),
});

/** glues[i] === true — склеить i-ю часть с предыдущей без пробела.
 *  Первая часть всегда после пробела: HEAD_RE требует \s после ']'. */
function buildLine(r: GenLine, glues: readonly boolean[] = []): string {
	const parts: string[] = [];
	let desc = r.desc;
	if (r.tag !== null) desc = desc === "" ? r.tag : `${desc} ${r.tag}`;
	if (desc !== "") parts.push(desc);
	if (r.prio !== null) parts.push(PRIORITY_EMOJI[r.prio]);
	if (r.rec !== null) parts.push(`🔁 ${r.rec}`);
	if (r.start !== null) parts.push(`🛫 ${r.start}`);
	if (r.scheduled !== null) parts.push(`⏳ ${r.scheduled}`);
	if (r.due !== null) parts.push(`📅 ${r.due}`);
	if (r.id !== null) parts.push(`🆔 ${r.id}`);
	if (r.deps !== null) parts.push(`⛔ ${r.deps.join(",")}`);
	let line = `${r.indent}${r.bullet} [${r.status}]`;
	parts.forEach((p, i) => {
		line += i > 0 && glues[i % Math.max(glues.length, 1)] === true ? p : ` ${p}`;
	});
	if (r.block !== null) line += ` ${r.block}`;
	return line;
}

describe("property: no-op редактирование = тождество строки", () => {
	it("setField/setValueField/setDependsOn/setPriority/setStatusChar/addTag с текущим значением", () => {
		fc.assert(
			fc.property(genArb, (r) => {
				const line = buildLine(r);
				const t = parseTaskLine(line, ctx());
				expect(t).not.toBeNull();
				for (const f of [
					"due",
					"scheduled",
					"start",
					"created",
					"done",
					"cancelled",
					"nextSpawn",
				] as const) {
					expect(setField(line, f, t![f])).toBe(line);
				}
				expect(setValueField(line, "id", t!.taskId)).toBe(line);
				expect(setValueField(line, "spawnedFrom", t!.spawnedFrom)).toBe(line);
				if (r.deps !== null) expect(setDependsOn(line, t!.dependsOn)).toBe(line);
				expect(setPriority(line, t!.priority)).toBe(line);
				expect(setStatusChar(line, t!.statusChar)).toBe(line);
				if (r.tag !== null) expect(addTag(line, r.tag)).toBe(line);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("property: правка отражает ровно одно изменение", () => {
	const fieldArb = fc.constantFrom("due", "scheduled", "start", "created") as fc.Arbitrary<
		"due" | "scheduled" | "start" | "created"
	>;

	it("setField(value): меняется только поле и rawLine", () => {
		fc.assert(
			fc.property(genArb, fieldArb, dateArb, (r, f, v2) => {
				const line = buildLine(r);
				const before = parseTaskLine(line, ctx())!;
				const after = setField(line, f, v2);
				const t2 = parseTaskLine(after, ctx());
				expect(t2).toEqual({ ...before, [f]: v2, rawLine: after });
			}),
			{ numRuns: 300 },
		);
	});

	it("setField(null): поле обнуляется, остальное неизменно", () => {
		fc.assert(
			fc.property(genArb, fieldArb, (r, f) => {
				const line = buildLine(r);
				const before = parseTaskLine(line, ctx())!;
				const after = setField(line, f, null);
				const t2 = parseTaskLine(after, ctx());
				expect(t2).toEqual({ ...before, [f]: null, rawLine: after });
			}),
			{ numRuns: 300 },
		);
	});

	it("setStatusChar: меняется только статус", () => {
		fc.assert(
			fc.property(genArb, fc.constantFrom("x", "X", "-", "/", " "), (r, s) => {
				const line = buildLine(r);
				const before = parseTaskLine(line, ctx())!;
				const after = setStatusChar(line, s);
				expect(parseTaskLine(after, ctx())).toEqual({
					...before,
					statusChar: s,
					rawLine: after,
				});
			}),
			{ numRuns: 200 },
		);
	});

	it("addTag: тег появляется в tags[] и в описании, 🔁 не задет", () => {
		fc.assert(
			fc.property(genArb, (r) => {
				const line = buildLine(r);
				const before = parseTaskLine(line, ctx())!;
				const after = addTag(line, "#zzz");
				const t2 = parseTaskLine(after, ctx())!;
				expect(t2.tags).toEqual([...before.tags, "#zzz"]);
				expect(t2.description).toBe(
					before.description === "" ? "#zzz" : `${before.description} #zzz`,
				);
				expect(t2.recurrence).toBe(before.recurrence);
				expect(t2.due).toBe(before.due);
				expect(t2.dependsOn).toEqual(before.dependsOn);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("property: после любой правки строка остаётся задачей", () => {
	const gluesArb = fc.array(fc.boolean(), { minLength: 9, maxLength: 9 });

	it("сеттеры и удаления на строках со склеенными без пробела частями", () => {
		fc.assert(
			fc.property(genArb, gluesArb, dateArb, (r, glues, v) => {
				const line = buildLine(r, glues);
				expect(tokenizeTaskLine(line), line).not.toBeNull();
				const outs = [
					setField(line, "due", v),
					setField(line, "due", null),
					setField(line, "done", null),
					setField(line, "start", null),
					setPriority(line, "high"),
					setPriority(line, "none"),
					setValueField(line, "id", null),
					setDependsOn(line, []),
					setStatusChar(line, "x"),
					addTag(line, "#zzz"),
				];
				if (r.tag !== null) outs.push(removeTag(line, r.tag));
				for (const out of outs) {
					expect(tokenizeTaskLine(out), `input: ${line}\noutput: ${out}`).not.toBeNull();
				}
			}),
			{ numRuns: 300 },
		);
	});
});

describe("property: неизвестный хвостовой текст переживает правки", () => {
	it("мусор в конце строки сохраняется дословно", () => {
		fc.assert(
			fc.property(genArb, dateArb, (r, v) => {
				const junk = " trailing junk zz";
				const line = buildLine(r) + junk;
				let out = setField(line, "created", v);
				out = setPriority(out, "medium");
				out = setValueField(out, "spawnedFrom", "tpl-0");
				expect(out).toContain(junk);
			}),
			{ numRuns: 200 },
		);
	});
});
