import { describe, expect, it } from "vitest";
import { makeTask } from "../../stores/testSupport";
import { dateBadges, renderWikiLinks, segmentDescription, wikiLinkBasename } from "./cardFormat";

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

describe("wikiLinkBasename", () => {
	it("срезает путь и .md", () => {
		expect(wikiLinkBasename("GTD/Cards/Заметка.md")).toBe("Заметка");
		expect(wikiLinkBasename("Заметка")).toBe("Заметка");
	});

	it("срезает #заголовок и #^блок", () => {
		expect(wikiLinkBasename("Заметка#Раздел")).toBe("Заметка");
		expect(wikiLinkBasename("Папка/Заметка.md#^abc123")).toBe("Заметка");
	});
});

describe("renderWikiLinks", () => {
	it("[[target|alias]] → alias", () => {
		expect(renderWikiLinks("см. [[Notes/Проект X.md|проект]]", null)).toBe("см. проект");
	});

	it("[[target]] → basename без пути и .md", () => {
		expect(renderWikiLinks("[[GTD/Cards/Ссылка на файл.md]]", null)).toBe("Ссылка на файл");
	});

	it("ссылка в середине текста", () => {
		expect(renderWikiLinks("до [[a/b.md|B]] после", null)).toBe("до B после");
	});

	it("[[c2flv3 Разобрать фотографии с отпуска]] скрывается при taskId=c2flv3", () => {
		expect(
			renderWikiLinks("[[c2flv3 Разобрать фотографии с отпуска]]", "c2flv3"),
		).toBe("");
	});

	it("скрытая ссылка на карточку в середине текста не оставляет двойной пробел", () => {
		expect(renderWikiLinks("Фото [[c2flv3 Разобрать фотографии]] дома", "c2flv3")).toBe(
			"Фото дома",
		);
	});

	it("ссылка на карточку с путём скрывается по basename", () => {
		expect(renderWikiLinks("x [[GTD/Cards/c2flv3 Фото.md]]", "c2flv3")).toBe("x");
	});

	it("без taskId ссылка на карточку показывается как basename", () => {
		expect(renderWikiLinks("[[c2flv3 Разобрать фотографии с отпуска]]", null)).toBe(
			"c2flv3 Разобрать фотографии с отпуска",
		);
	});

	it("чужой taskId не прячет ссылку", () => {
		expect(renderWikiLinks("[[c2flv3 Фото]]", "zzz111")).toBe("c2flv3 Фото");
	});

	it("пустой alias падает обратно на basename", () => {
		expect(renderWikiLinks("[[Папка/Заметка.md|]]", null)).toBe("Заметка");
	});

	it("незакрытые скобки и пустые ссылки остаются текстом", () => {
		expect(renderWikiLinks("a [[не закрыто", null)).toBe("a [[не закрыто");
		expect(renderWikiLinks("a [[]] b", null)).toBe("a [[]] b");
	});

	it("несколько ссылок в одной строке", () => {
		expect(renderWikiLinks("[[a|A]] и [[dir/b.md]]", null)).toBe("A и b");
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
