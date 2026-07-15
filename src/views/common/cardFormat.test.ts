import { describe, expect, it } from "vitest";
import { makeTask } from "../../stores/testSupport";
import { dateBadges, segmentDescription } from "./cardFormat";

describe("segmentDescription", () => {
	it("выделяет тег в середине текста", () => {
		expect(segmentDescription("Купить молоко #home и хлеб")).toEqual([
			{ text: "Купить молоко ", tag: false },
			{ text: "#home", tag: true },
			{ text: " и хлеб", tag: false },
		]);
	});

	it("тег в начале и в конце строки", () => {
		expect(segmentDescription("#срочно позвонить")).toEqual([
			{ text: "#срочно", tag: true },
			{ text: " позвонить", tag: false },
		]);
		expect(segmentDescription("позвонить #home")).toEqual([
			{ text: "позвонить ", tag: false },
			{ text: "#home", tag: true },
		]);
	});

	it("вложенный тег целиком", () => {
		expect(segmentDescription("x #kanban/board/col y")).toEqual([
			{ text: "x ", tag: false },
			{ text: "#kanban/board/col", tag: true },
			{ text: " y", tag: false },
		]);
	});

	it("не-теги: только цифры, # внутри слова, ##", () => {
		expect(segmentDescription("#123 a#b ##x")).toEqual([{ text: "#123 a#b ##x", tag: false }]);
	});

	it("пустая строка — ноль сегментов", () => {
		expect(segmentDescription("")).toEqual([]);
	});

	it("инвариант: конкатенация сегментов == исходной строке", () => {
		const samples = [
			"Купить молоко #home и хлеб",
			"#a #b#c ### #кир_тег/x",
			"без тегов вообще",
			"# одинокий хэш",
		];
		for (const s of samples) {
			const joined = segmentDescription(s)
				.map((seg) => seg.text)
				.join("");
			expect(joined).toBe(s);
		}
	});
});

describe("dateBadges", () => {
	it("все три даты в порядке 📅 ⏳ 🛫", () => {
		const t = makeTask({
			filePath: "a.md",
			due: "2026-07-20",
			scheduled: "2026-07-18",
			start: "2026-07-16",
		});
		expect(dateBadges(t)).toEqual([
			{ icon: "📅", date: "2026-07-20", field: "due" },
			{ icon: "⏳", date: "2026-07-18", field: "scheduled" },
			{ icon: "🛫", date: "2026-07-16", field: "start" },
		]);
	});

	it("без дат — пусто", () => {
		expect(dateBadges(makeTask({ filePath: "a.md" }))).toEqual([]);
	});
});
