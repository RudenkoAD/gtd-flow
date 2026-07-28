import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	extractTags,
	serializeTokens,
	tokenizeSegments,
	tokenizeTaskLine,
	type FieldToken,
	type Segment,
} from "./tokenizer";

const NBSP = " ";
const VS = "️";

function fields(segs: Segment[]): FieldToken[] {
	return segs.filter((s): s is FieldToken => s.kind === "field");
}

describe("tokenizeTaskLine: голова строки", () => {
	it("распознаёт маркеры -, *, +", () => {
		for (const b of ["-", "*", "+"] as const) {
			const t = tokenizeTaskLine(`${b} [ ] hello`);
			expect(t).not.toBeNull();
			expect(t!.bullet).toBe(b);
			expect(t!.statusChar).toBe(" ");
		}
	});

	it("сохраняет отступ и пробелы после маркера", () => {
		const t = tokenizeTaskLine("\t  - \t[x] a")!;
		expect(t.indent).toBe("\t  ");
		expect(t.afterBullet).toBe(" \t");
		expect(t.statusChar).toBe("x");
	});

	it("статусы x, X, -, / и пробел", () => {
		for (const s of [" ", "x", "X", "-", "/"]) {
			expect(tokenizeTaskLine(`- [${s}] a`)!.statusChar).toBe(s);
		}
	});

	it("задача без описания валидна", () => {
		expect(tokenizeTaskLine("- [ ]")).not.toBeNull();
		expect(tokenizeTaskLine("- [x]")).not.toBeNull();
		expect(tokenizeTaskLine("- [ ] ")).not.toBeNull();
	});

	it("не-задачи дают null", () => {
		const notTasks = [
			"",
			"plain text",
			"- item without checkbox",
			"* another item",
			"-[ ] нет пробела после маркера",
			"- [ab] два символа статуса",
			"- [] пустые скобки",
			"1. [ ] нумерованный список",
			"> [ ] цитата",
			"- [ ]x нет пробела после скобки",
			"строка\n- [ ] многострочный ввод",
		];
		for (const line of notTasks) expect(tokenizeTaskLine(line), line).toBeNull();
	});
});

describe("tokenizeTaskLine: сегменты", () => {
	it("текст + дата + приоритет", () => {
		const t = tokenizeTaskLine("- [ ] Buy milk 📅 2026-01-05 ⏫")!;
		expect(t.segments).toEqual([
			{ kind: "text", text: " Buy milk " },
			{ kind: "field", field: "due", emoji: "📅", gap: " ", payload: "2026-01-05" },
			{ kind: "text", text: " " },
			{ kind: "field", field: "priority", emoji: "⏫", gap: "", payload: "" },
		]);
	});

	it("🔁 payload идёт до следующего поля", () => {
		const t = tokenizeTaskLine("- [ ] X 🔁 every 2 weeks on mon, thu 🆔 ab1")!;
		const f = fields(t.segments);
		expect(f[0]!.field).toBe("recurrence");
		expect(f[0]!.payload).toBe("every 2 weeks on mon, thu");
		expect(f[1]!.field).toBe("id");
		expect(f[1]!.payload).toBe("ab1");
	});

	it("🔁 payload идёт до конца строки, хвостовые пробелы уходят тексту", () => {
		const t = tokenizeTaskLine("- [ ] X 🔁 every day  ")!;
		const f = fields(t.segments);
		expect(f[0]!.payload).toBe("every day");
		const last = t.segments[t.segments.length - 1]!;
		expect(last).toEqual({ kind: "text", text: "  " });
	});

	it("⛔ список через запятую, с пробелами и без", () => {
		expect(fields(tokenizeTaskLine("- [ ] T ⛔ a1,b2")!.segments)[0]!.payload).toBe("a1,b2");
		expect(fields(tokenizeTaskLine("- [ ] T ⛔ a1, b2")!.segments)[0]!.payload).toBe("a1, b2");
		const t = tokenizeTaskLine("- [ ] T ⛔ a1, b2 rest")!;
		expect(fields(t.segments)[0]!.payload).toBe("a1, b2");
		expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: " rest" });
	});

	it("🚫 список дат через запятую (поле-список как ⛔)", () => {
		const t = tokenizeTaskLine("- [ ] T 🚫 2026-07-21,2026-08-04 rest")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-07-21,2026-08-04");
		expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: " rest" });
	});

	it("дата-токен останавливается на запятой (пунктуация не портит дату)", () => {
		const t = tokenizeTaskLine("- [ ] Pay 📅 2026-08-01, then relax")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-08-01");
	});

	it("поле без пробела перед payload: gap пуст", () => {
		const f = fields(tokenizeTaskLine("- [ ] T 📅2026-01-01")!.segments)[0]!;
		expect(f.gap).toBe("");
		expect(f.payload).toBe("2026-01-01");
	});

	it("голый эмодзи в конце строки: пустой payload", () => {
		const f = fields(tokenizeTaskLine("- [ ] T 🆔")!.segments)[0]!;
		expect(f.field).toBe("id");
		expect(f.payload).toBe("");
	});

	it("NBSP работает как разделитель поля и сохраняется в gap", () => {
		const t = tokenizeTaskLine(`- [ ] Pay${NBSP}rent 📅${NBSP}2026-08-01`)!;
		const f = fields(t.segments)[0]!;
		expect(f.gap).toBe(NBSP);
		expect(f.payload).toBe("2026-08-01");
	});

	it("вариационный селектор U+FE0F поглощается в эмодзи дословно", () => {
		const t = tokenizeTaskLine(`- [ ] T ⏳${VS} 2026-01-01`)!;
		const f = fields(t.segments)[0]!;
		expect(f.field).toBe("scheduled");
		expect(f.emoji).toBe(`⏳${VS}`);
		expect(f.payload).toBe("2026-01-01");
	});

	it("^block-id отделяется от сегментов", () => {
		const t = tokenizeTaskLine("- [ ] T 📅 2026-01-01 ^ab-12")!;
		expect(t.blockRef).toEqual({ spacing: " ", ref: "^ab-12", trailing: "" });
		expect(fields(t.segments)[0]!.payload).toBe("2026-01-01");
	});

	it("строка из одного ^block-id", () => {
		const t = tokenizeTaskLine("- [ ] ^only")!;
		expect(t.blockRef).toEqual({ spacing: " ", ref: "^only", trailing: "" });
		expect(t.segments).toEqual([]);
	});

	it("^ в середине строки не считается block-id", () => {
		const t = tokenizeTaskLine("- [ ] a ^mid b")!;
		expect(t.blockRef).toBeNull();
	});

	it("пробельный хвост после ^block-id не мешает его распознать", () => {
		const t = tokenizeTaskLine("- [ ] Task ^abc  ")!;
		expect(t.blockRef).toEqual({ spacing: " ", ref: "^abc", trailing: "  " });
	});
});

describe("tokenizeTaskLine: время в payload дата-полей (📅/⏳/🛫)", () => {
	it("валидное время попадает в payload токена, а не в следующий текст", () => {
		const t = tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-07-25 14:30");
		expect(t.segments[t.segments.length - 1]!.kind).toBe("field"); // хвостового текста нет
	});

	it("⏳ и 🛫 тоже захватывают время", () => {
		expect(fields(tokenizeTaskLine("- [ ] T ⏳ 2026-01-01 08:05")!.segments)[0]!.payload).toBe(
			"2026-01-01 08:05",
		);
		expect(fields(tokenizeTaskLine("- [ ] T 🛫 2026-01-01 23:59")!.segments)[0]!.payload).toBe(
			"2026-01-01 23:59",
		);
	});

	it("невалидное время остаётся тексту (дата не ломается)", () => {
		for (const bad of ["25:00", "9:30", "14:60", "14:30:00", "1430"]) {
			const t = tokenizeTaskLine(`- [ ] T 📅 2026-07-25 ${bad}`)!;
			expect(fields(t.segments)[0]!.payload, bad).toBe("2026-07-25");
			expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: ` ${bad}` });
		}
	});

	it("у ✅/❌/➕/🔜 времени нет — «14:30» уходит тексту", () => {
		for (const emoji of ["✅", "❌", "➕", "🔜"]) {
			const t = tokenizeTaskLine(`- [ ] T ${emoji} 2026-01-01 14:30`)!;
			expect(fields(t.segments)[0]!.payload, emoji).toBe("2026-01-01");
			expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: " 14:30" });
		}
	});

	it("после офсета ±Nd время не захватывается (шаблоны)", () => {
		expect(fields(tokenizeTaskLine("- [ ] Tpl 📅 +14d 14:30")!.segments)[0]!.payload).toBe(
			"+14d",
		);
	});

	it("текст после времени уходит в следующий сегмент", () => {
		const t = tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30 rest")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-07-25 14:30");
		expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: " rest" });
	});

	it("время перед следующим полем не съедает его", () => {
		const f = fields(tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30 ⏫")!.segments);
		expect(f[0]!.payload).toBe("2026-07-25 14:30");
		expect(f[1]!.field).toBe("priority");
	});

	it("NBSP между датой и временем захватывается дословно", () => {
		const line = `- [ ] T 📅 2026-07-25${NBSP}14:30`;
		const t = tokenizeTaskLine(line)!;
		expect(fields(t.segments)[0]!.payload).toBe(`2026-07-25${NBSP}14:30`);
		expect(serializeTokens(t)).toBe(line);
	});

	it("запятая после даты прерывает захват — время достаётся тексту", () => {
		expect(
			fields(tokenizeTaskLine("- [ ] Pay 📅 2026-08-01, 14:30 later")!.segments)[0]!.payload,
		).toBe("2026-08-01");
	});

	it("round-trip дословный для строк со временем", () => {
		const lines = [
			"- [ ] T 📅 2026-07-25 14:30",
			"- [ ] T ⏳ 2026-01-01 00:00 🛫 2026-01-02 23:59 ^b1",
			"- [ ] T 📅 2026-07-25  14:30", // двойной пробел внутри payload — дословно
			"- [ ] T 📅 2026-07-25 99:99 tail",
			"- [ ] T 📅 2026-07-25 14:30 ⏫ rest\r",
		];
		for (const line of lines) {
			const t = tokenizeTaskLine(line);
			expect(t, JSON.stringify(line)).not.toBeNull();
			expect(serializeTokens(t!)).toBe(line);
		}
	});
});

describe("tokenizeTaskLine: интервал времени «HH:mm-HH:mm» в payload (📅/⏳/🛫)", () => {
	it("валидный интервал попадает в payload токена целиком", () => {
		const t = tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30-16:00")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-07-25 14:30-16:00");
		expect(t.segments[t.segments.length - 1]!.kind).toBe("field"); // хвостового текста нет
	});

	it("⏳ и 🛫 тоже захватывают интервал", () => {
		expect(
			fields(tokenizeTaskLine("- [ ] T ⏳ 2026-01-01 00:00-23:59")!.segments)[0]!.payload,
		).toBe("2026-01-01 00:00-23:59");
		expect(
			fields(tokenizeTaskLine("- [ ] T 🛫 2026-01-01 08:00-08:01")!.segments)[0]!.payload,
		).toBe("2026-01-01 08:00-08:01");
	});

	it("конец НЕ позже начала — уходит тексту, начало остаётся в payload", () => {
		for (const bad of ["13:00", "14:30", "00:00"]) {
			const t = tokenizeTaskLine(`- [ ] T 📅 2026-07-25 14:30-${bad}`)!;
			expect(fields(t.segments)[0]!.payload, bad).toBe("2026-07-25 14:30");
			expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: `-${bad}` });
		}
	});

	it("невалидный конец — уходит тексту, начало остаётся в payload", () => {
		for (const bad of ["25:00", "9:30", "16:0", "16:00:00", "16:00x", ""]) {
			const t = tokenizeTaskLine(`- [ ] T 📅 2026-07-25 14:30-${bad}`)!;
			expect(fields(t.segments)[0]!.payload, bad).toBe("2026-07-25 14:30");
			expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: `-${bad}` });
		}
	});

	it("дефис с пробелами — не интервал (формат: дефис БЕЗ пробелов)", () => {
		const t1 = tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30 -16:00")!;
		expect(fields(t1.segments)[0]!.payload).toBe("2026-07-25 14:30");
		expect(t1.segments[t1.segments.length - 1]).toEqual({ kind: "text", text: " -16:00" });
		const t2 = tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30- 16:00")!;
		expect(fields(t2.segments)[0]!.payload).toBe("2026-07-25 14:30");
		expect(t2.segments[t2.segments.length - 1]).toEqual({ kind: "text", text: "- 16:00" });
	});

	it("невалидное начало ломает весь хвост, как раньше (дата не задета)", () => {
		const t = tokenizeTaskLine("- [ ] T 📅 2026-07-25 25:00-26:00")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-07-25");
		expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: " 25:00-26:00" });
	});

	it("текст и следующее поле после интервала не съедаются", () => {
		const t = tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30-16:00 rest")!;
		expect(fields(t.segments)[0]!.payload).toBe("2026-07-25 14:30-16:00");
		expect(t.segments[t.segments.length - 1]).toEqual({ kind: "text", text: " rest" });
		const f = fields(tokenizeTaskLine("- [ ] T 📅 2026-07-25 14:30-16:00 ⏫")!.segments);
		expect(f[0]!.payload).toBe("2026-07-25 14:30-16:00");
		expect(f[1]!.field).toBe("priority");
	});

	it("у ✅/❌/➕/🔜 интервал — обычный текст", () => {
		for (const emoji of ["✅", "❌", "➕", "🔜"]) {
			const t = tokenizeTaskLine(`- [ ] T ${emoji} 2026-01-01 14:30-16:00`)!;
			expect(fields(t.segments)[0]!.payload, emoji).toBe("2026-01-01");
			expect(t.segments[t.segments.length - 1]).toEqual({
				kind: "text",
				text: " 14:30-16:00",
			});
		}
	});

	it("после офсета ±Nd интервал не захватывается (шаблоны)", () => {
		expect(
			fields(tokenizeTaskLine("- [ ] Tpl 📅 +14d 14:30-16:00")!.segments)[0]!.payload,
		).toBe("+14d");
	});

	it("NBSP между датой и интервалом захватывается дословно", () => {
		const line = `- [ ] T 📅 2026-07-25${NBSP}14:30-16:00`;
		const t = tokenizeTaskLine(line)!;
		expect(fields(t.segments)[0]!.payload).toBe(`2026-07-25${NBSP}14:30-16:00`);
		expect(serializeTokens(t)).toBe(line);
	});

	it("round-trip дословный для строк с интервалом", () => {
		const lines = [
			"- [ ] T 📅 2026-07-25 14:30-16:00",
			"- [ ] T ⏳ 2026-01-01 00:00-00:01 🛫 2026-01-02 22:00-23:59 ^b1",
			"- [ ] T 📅 2026-07-25 14:30-13:00 tail", // невалидный конец — текст, дословно
			"- [ ] T 📅 2026-07-25 14:30-16:00 ⏫ rest\r",
			"- [ ] T 📅 2026-07-25 14:30-",
		];
		for (const line of lines) {
			const t = tokenizeTaskLine(line);
			expect(t, JSON.stringify(line)).not.toBeNull();
			expect(serializeTokens(t!)).toBe(line);
		}
	});
});

describe("tokenizeTaskLine: хвостовой \\r (CRLF-файл, разрезанный по \\n)", () => {
	it("\\r отделяется в trailingCr, ^block-id распознаётся", () => {
		const t = tokenizeTaskLine("- [ ] Task ^abc\r")!;
		expect(t.trailingCr).toBe("\r");
		expect(t.blockRef).toEqual({ spacing: " ", ref: "^abc", trailing: "" });
		expect(t.segments).toEqual([{ kind: "text", text: " Task" }]);
	});

	it("\\r не попадает в текстовые сегменты и без block-id", () => {
		const t = tokenizeTaskLine("- [ ] Task\r")!;
		expect(t.trailingCr).toBe("\r");
		expect(t.segments).toEqual([{ kind: "text", text: " Task" }]);
	});

	it("round-trip дословный для CRLF-строк", () => {
		const lines = [
			"- [ ] Task ^abc\r",
			"- [ ] Task\r",
			"- [ ]\r",
			"- [x] T 📅 2026-01-01 ^ab-12\r",
			"- [ ] Task ^abc \r",
			"- [ ] Task ^abc  ",
		];
		for (const line of lines) {
			const t = tokenizeTaskLine(line);
			expect(t, JSON.stringify(line)).not.toBeNull();
			expect(serializeTokens(t!)).toBe(line);
		}
	});
});

describe("serializeTokens: точный round-trip", () => {
	const gnarly = [
		"- [ ]",
		"- [x] plain",
		"\t* [X]  double  spaces  kept",
		"- [/] Fix pump #home/garage ⏫ 🔁 every month on the last day 🛫 2026-07-01 🆔 fix-1 ⛔ a,b ^blk1",
		`- [ ] Pay${NBSP}rent 📅${NBSP}2026-08-01`,
		`- [ ] T ⏳${VS} 2026-01-01 ^x-1`,
		"- [ ] T 📅2026-01-01 🆔",
		"- [-] Продлить парковку 🔁 every 3 months on the 1st 🆔 park-permit 🔜 2026-10-01",
		"- [ ] Tpl 🔁 every month on the 1st 🛫 -3d 📅 +14d",
		"- [ ] trailing junk after 📅 2026-01-01 some note",
		"- [ ] ⛔ a1, b2 rest of text #tag",
		"- [ ] Тренировка 🔁 every tuesday at 19:00 🚫 2026-07-21,2026-08-04 🆔 ev1",
	];
	for (const line of gnarly) {
		it(JSON.stringify(line), () => {
			const t = tokenizeTaskLine(line);
			expect(t).not.toBeNull();
			expect(serializeTokens(t!)).toBe(line);
		});
	}

	it("property: round-trip для генерированных строк", () => {
		const sep = fc.constantFrom(" ", "  ", NBSP, ` ${NBSP}`);
		const word = fc
			.array(fc.constantFrom(..."abcdefgXYZ0123".split("")), { minLength: 1, maxLength: 6 })
			.map((cs) => cs.join(""));
		const date = fc
			.tuple(
				fc.integer({ min: 2000, max: 2099 }),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 28 }),
			)
			.map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
		const arb = fc.record({
			s1: sep,
			s2: sep,
			s3: sep,
			desc: fc.array(word, { minLength: 0, maxLength: 3 }).map((ws) => ws.join(" ")),
			due: fc.option(date, { nil: null }),
			id: fc.option(word, { nil: null }),
			block: fc.option(fc.constantFrom("^ab1", "^x-9"), { nil: null }),
		});
		fc.assert(
			fc.property(arb, (r) => {
				let line = "- [ ]";
				if (r.desc !== "") line += r.s1 + r.desc;
				if (r.due !== null) line += `${r.s2}📅 ${r.due}`;
				if (r.id !== null) line += `${r.s3}🆔 ${r.id}`;
				if (r.block !== null) line += ` ${r.block}`;
				const t = tokenizeTaskLine(line);
				expect(t).not.toBeNull();
				expect(serializeTokens(t!)).toBe(line);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("extractTags", () => {
	it("простые и вложенные теги", () => {
		expect(extractTags(" call mom #home #kanban/work/todo done")).toEqual([
			"#home",
			"#kanban/work/todo",
		]);
	});

	it("чисто числовой тег — не тег; с нецифровым символом — тег", () => {
		expect(extractTags("#123")).toEqual([]);
		expect(extractTags("#1-2")).toEqual(["#1-2"]);
		expect(extractTags("#a1")).toEqual(["#a1"]);
	});

	it("# внутри слова и ## — не теги", () => {
		expect(extractTags("foo#bar")).toEqual([]);
		expect(extractTags("##double")).toEqual([]);
		expect(extractTags("# lone")).toEqual([]);
	});

	it("не-ASCII теги; NBSP завершает тег", () => {
		expect(extractTags("привет #дом/быт пока")).toEqual(["#дом/быт"]);
		expect(extractTags(`#a${NBSP}b`)).toEqual(["#a"]);
	});

	it("тег в начале и в конце строки", () => {
		expect(extractTags("#start middle #end")).toEqual(["#start", "#end"]);
	});
});

describe("tokenizeSegments (низкоуровневый)", () => {
	it("пустая строка — пустой список сегментов", () => {
		expect(tokenizeSegments("")).toEqual([]);
	});

	it("только текст — один сегмент", () => {
		expect(tokenizeSegments(" just text ")).toEqual([{ kind: "text", text: " just text " }]);
	});
});

describe("📍 location: свободный текст до следующего поля/тега (как 🔁)", () => {
	// 📍 — поле места ПО УМОЛЧАНИЮ (и в обычных задачах). Опция { location: false }
	// возвращает старое поведение «📍 — текст» (обратная совместимость).
	it("поле места распознаётся БЕЗ флага (по умолчанию)", () => {
		const f = fields(tokenizeTaskLine("- [ ] Созвон 📍 Кафе на углу")!.segments);
		expect(f[0]!.field).toBe("location");
		expect(f[0]!.payload).toBe("Кафе на углу");
	});

	it("payload идёт до конца строки, хвостовые пробелы уходят тексту", () => {
		const t = tokenizeTaskLine("- [ ] Созвон 📍 Кафе на углу  ")!;
		const f = fields(t.segments);
		expect(f[0]!.field).toBe("location");
		expect(f[0]!.payload).toBe("Кафе на углу");
		const last = t.segments[t.segments.length - 1]!;
		expect(last).toEqual({ kind: "text", text: "  " });
	});

	it("payload обрезается перед следующим полем 🔁", () => {
		const t = tokenizeTaskLine("- [ ] Тр 📍 Спортзал на Ленина 🔁 every tuesday at 19:00")!;
		const f = fields(t.segments);
		expect(f[0]!.field).toBe("location");
		expect(f[0]!.payload).toBe("Спортзал на Ленина");
		expect(f[1]!.field).toBe("recurrence");
		expect(f[1]!.payload).toBe("every tuesday at 19:00");
	});

	it("🔁 обрезается перед 📍 и наоборот (соседство полей со свободным текстом)", () => {
		const t = tokenizeTaskLine("- [ ] Тр 🔁 every tuesday at 19:00 📍 Зал 🆔 ev1")!;
		const f = fields(t.segments);
		expect(f[0]!.field).toBe("recurrence");
		expect(f[0]!.payload).toBe("every tuesday at 19:00");
		expect(f[1]!.field).toBe("location");
		expect(f[1]!.payload).toBe("Зал");
		expect(f[2]!.field).toBe("id");
		expect(f[2]!.payload).toBe("ev1");
	});

	it("защита «а»: payload обрывается перед первым #тегом, тег остаётся текстом", () => {
		const t = tokenizeTaskLine("- [ ] Купить билеты 📍 касса вокзала #kanban/trips/todo")!;
		const f = fields(t.segments);
		expect(f[0]!.field).toBe("location");
		expect(f[0]!.payload).toBe("касса вокзала"); // #тег не проглочен
		expect(
			extractTags(t.segments.map((s) => (s.kind === "text" ? s.text : "")).join("")),
		).toEqual(["#kanban/trips/todo"]);
	});

	it("защита «а»: числовой #5 — не тег, остаётся частью места", () => {
		const f = fields(tokenizeTaskLine("- [ ] Ev 📍 ТЦ #5 этаж")!.segments);
		expect(f[0]!.payload).toBe("ТЦ #5 этаж");
	});

	it("защита «б»: 📍 в самом начале описания — заголовок, не поле", () => {
		const t = tokenizeTaskLine("- [ ] 📍 Важная встреча 📅 2026-07-20")!;
		const f = fields(t.segments);
		expect(f.map((x) => x.field)).toEqual(["due"]); // 📍 полем НЕ стало
		const text = t.segments.map((s) => (s.kind === "text" ? s.text : "")).join("");
		expect(text).toContain("📍 Важная встреча");
	});

	it("защита «б»: 📍 после поля-даты (описание пусто) — всё же поле", () => {
		const f = fields(tokenizeTaskLine("- [ ] 📅 2026-01-01 📍 Офис")!.segments);
		expect(f[0]!.field).toBe("due");
		expect(f[1]!.field).toBe("location");
		expect(f[1]!.payload).toBe("Офис");
	});

	it("{ location: false } возвращает старое поведение «📍 — текст»", () => {
		const t = tokenizeTaskLine("- [ ] Созвон 📍 Кафе на углу", { location: false })!;
		expect(fields(t.segments)).toEqual([]); // 📍 не даёт поля
		const text = t.segments.map((s) => (s.kind === "text" ? s.text : "")).join("");
		expect(text).toBe(" Созвон 📍 Кафе на углу");
	});

	it("round-trip дословный со свободным текстом места (в т.ч. рядом с 🔁/🆔/#тегом)", () => {
		// round-trip лослесс НЕЗАВИСИМО от флага: 📍 либо поле, либо текст — байты те же
		for (const line of [
			"- [ ] Созвон 📅 2026-07-20 14:30 📍 Офис, 3 этаж",
			"- [ ] Тр 🔁 every tuesday at 19:00 📍 Спортзал на Ленина 🆔 ev1",
			"- [ ] X 📍 Место  с  двойными  пробелами 🚫 2026-07-21 ^blk",
			"- [ ] Купить билеты 📍 касса вокзала #kanban/trips/todo",
			"- [ ] 📍 Заголовок с ведущим 📍 📅 2026-01-01",
		]) {
			for (const opts of [{}, { location: true }, { location: false }]) {
				const t = tokenizeTaskLine(line, opts);
				expect(t).not.toBeNull();
				expect(serializeTokens(t!)).toBe(line);
			}
		}
	});
});
