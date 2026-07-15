import { describe, expect, it } from "vitest";
import {
	MAX_CARD_NAME_LEN,
	buildCardContent,
	cardFileName,
	cardPath,
	checklistProgress,
	insertCardLink,
	sanitizeCardName,
} from "./cardLogic";

describe("sanitizeCardName", () => {
	it("заменяет запрещённые символы Windows/Obsidian пробелом и схлопывает пробелы", () => {
		expect(sanitizeCardName('Спека: график/план? "v2" <черновик>')).toBe(
			"Спека график план v2 черновик",
		);
		expect(sanitizeCardName("[x] #tag ^ref a|b *c* \\d")).toBe("x tag ref a b c d");
	});

	it("вычищает управляющие символы", () => {
		expect(sanitizeCardName("a" + String.fromCharCode(0) + "b" + String.fromCharCode(9) + "c")).toBe(
			"a b c",
		);
	});

	it("обрезает до предела и срезает хвостовые пробелы/точки после обрезки", () => {
		expect(sanitizeCardName("a".repeat(100))).toHaveLength(MAX_CARD_NAME_LEN);
		// 59 символов + пробел на границе обрезки — хвостовой пробел срезан
		expect(sanitizeCardName("b".repeat(59) + " tail")).toBe("b".repeat(59));
		expect(sanitizeCardName("проект...")).toBe("проект");
	});

	it("пустой/полностью запрещённый текст → пустая строка", () => {
		expect(sanitizeCardName("")).toBe("");
		expect(sanitizeCardName("///:::***")).toBe("");
	});
});

describe("cardFileName / cardPath", () => {
	it("имя = '<id> <описание>.md'; без описания — '<id>.md'", () => {
		expect(cardFileName("m3q9z4", "Собрать сметы")).toBe("m3q9z4 Собрать сметы.md");
		expect(cardFileName("m3q9z4", "")).toBe("m3q9z4.md");
	});

	it("описание и id санитизируются; пустой после очистки id → 'card'", () => {
		expect(cardFileName("a/b", "план: №1?")).toBe("a b план №1.md");
		expect(cardFileName("::", "x")).toBe("card x.md");
	});

	it("cardPath присоединяет папку; пустая папка и лишние слэши терпимы", () => {
		expect(cardPath("GTD/Cards", "a.md")).toBe("GTD/Cards/a.md");
		expect(cardPath("/GTD/Cards/", "a.md")).toBe("GTD/Cards/a.md");
		expect(cardPath("", "a.md")).toBe("a.md");
	});
});

describe("buildCardContent", () => {
	it("frontmatter gtd-card-of (id в кавычках) + заголовок + заготовка чеклиста", () => {
		expect(buildCardContent("m3q9z4", "Собрать сметы")).toBe(
			'---\ngtd-card-of: "m3q9z4"\n---\n\n# Собрать сметы\n\n- [ ] \n',
		);
	});

	it("пустое описание — заголовком становится id", () => {
		expect(buildCardContent("k7", "")).toBe('---\ngtd-card-of: "k7"\n---\n\n# k7\n\n- [ ] \n');
	});

	it("числовой id остаётся строкой в YAML (кавычки)", () => {
		expect(buildCardContent("123", "x")).toContain('gtd-card-of: "123"');
	});
});

describe("insertCardLink", () => {
	it("строка без полей — ссылка в конец", () => {
		expect(insertCardLink("- [ ] Купить билеты", "abc Купить билеты")).toBe(
			"- [ ] Купить билеты [[abc Купить билеты]]",
		);
	});

	it("ссылка вставляется ПЕРЕД первым эмодзи-полем", () => {
		expect(insertCardLink("- [ ] Задача 📅 2026-07-20 🆔 abc", "abc Задача")).toBe(
			"- [ ] Задача [[abc Задача]] 📅 2026-07-20 🆔 abc",
		);
	});

	it("строка, начинающаяся сразу с поля-приоритета, — ссылка перед ним", () => {
		expect(insertCardLink("- [ ] ⏫ Срочно 🆔 q1", "q1 Срочно")).toBe(
			"- [ ] [[q1 Срочно]] ⏫ Срочно 🆔 q1",
		);
	});

	it("идемпотентность: повторная вставка не дублирует ссылку", () => {
		const once = insertCardLink("- [ ] Задача 🆔 abc", "abc Задача")!;
		expect(insertCardLink(once, "abc Задача")).toBe(once);
	});

	it("имя карточки с эмодзи поля — отказ от вставки (строка не тронута)", () => {
		const line = "- [ ] Задача 🆔 abc";
		expect(insertCardLink(line, "📅 план")).toBe(line);
	});

	it("не задача → null", () => {
		expect(insertCardLink("просто текст", "x")).toBeNull();
		expect(insertCardLink("- пункт списка без чекбокса", "x")).toBeNull();
	});
});

describe("checklistProgress", () => {
	it("done = x/X; '-' и '/' в total, но не в done", () => {
		expect(
			checklistProgress([
				{ statusChar: "x" },
				{ statusChar: "X" },
				{ statusChar: " " },
				{ statusChar: "-" },
				{ statusChar: "/" },
			]),
		).toEqual({ done: 2, total: 5 });
	});

	it("пустой список → {0, 0}", () => {
		expect(checklistProgress([])).toEqual({ done: 0, total: 0 });
	});
});
