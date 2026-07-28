import { describe, expect, it } from "vitest";
import { makeTask } from "../../stores/testSupport";
import {
	dateBadges,
	displaySegments,
	displayText,
	renderWikiLinks,
	segmentDescription,
	stripColumnTags,
	wikiLinkBasename,
} from "./cardFormat";

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

describe("stripColumnTags", () => {
	it("вырезает тег колонки в середине, шов схлопывается до одного пробела", () => {
		expect(stripColumnTags("Купить молоко #kanban/dev/todo и хлеб")).toBe(
			"Купить молоко и хлеб",
		);
	});

	it("тег колонки в конце — без хвостового пробела", () => {
		expect(stripColumnTags("Позвонить #kanban/dev/doing")).toBe("Позвонить");
	});

	it("тег колонки в начале — без ведущего пробела", () => {
		expect(stripColumnTags("#kanban/dev/todo разобрать почту")).toBe("разобрать почту");
	});

	it("несколько тегов колонок вырезаются, обычные #теги остаются", () => {
		expect(stripColumnTags("Задача #home #kanban/dev/todo #kanban/dev/review срочно")).toBe(
			"Задача #home срочно",
		);
	});

	it("без тегов колонок строка не меняется (пробелы не нормализуются лишний раз)", () => {
		expect(stripColumnTags("Купить молоко #home и хлеб")).toBe("Купить молоко #home и хлеб");
		expect(stripColumnTags("просто текст")).toBe("просто текст");
	});

	it("#kanban без сегмента колонки (нет '/') не считается тегом колонки", () => {
		// префикс строго '#kanban/'; одиночный #kanban — обычный тег, остаётся
		expect(stripColumnTags("тема #kanban заметка")).toBe("тема #kanban заметка");
	});
});

describe("displaySegments", () => {
	it("сегментирует описание, скрывая теги колонок доски", () => {
		expect(displaySegments("Купить #home #kanban/dev/todo молоко")).toEqual([
			{ text: "Купить ", tag: false },
			{ text: "#home", tag: true },
			{ text: " молоко", tag: false },
		]);
	});

	it("без тегов колонок совпадает с segmentDescription", () => {
		const text = "Купить молоко #home и хлеб";
		expect(displaySegments(text)).toEqual(segmentDescription(text));
	});
});

describe("displayText", () => {
	it("вики-ссылки → alias/basename, теги колонок вырезаются", () => {
		const t = makeTask({
			filePath: "a.md",
			description: "Фото [[a/b.md|B]] #kanban/dev/todo дома",
		});
		expect(displayText(t)).toBe("Фото B дома");
	});

	it("ссылка на свою карточку скрывается по taskId", () => {
		const t = makeTask({
			filePath: "a.md",
			taskId: "c2flv3",
			description: "Разбор [[c2flv3 Разобрать фото]] дома",
		});
		expect(displayText(t)).toBe("Разбор дома");
	});

	it("равен конкатенации text-сегментов того же пайплайна (как в TaskCard/EventChip)", () => {
		const t = makeTask({
			filePath: "a.md",
			taskId: "c2flv3",
			description: "x [[dir/n.md|N]] #home #kanban/b/c [[c2flv3 карточка]] y",
		});
		const joined = displaySegments(renderWikiLinks(t.description, t.taskId))
			.map((s) => s.text)
			.join("");
		expect(displayText(t)).toBe(joined);
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
		expect(renderWikiLinks("[[c2flv3 Разобрать фотографии с отпуска]]", "c2flv3")).toBe("");
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
