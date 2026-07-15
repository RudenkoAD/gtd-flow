/**
 * settingsFormat: текст полей вкладки настроек — ручной ввод, поэтому мусор,
 * CRLF, лишние пробелы и частично невалидные строки — штатный вход.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./Settings";
import {
	formatDeferPresets,
	formatPathList,
	parseDeferPresets,
	parseIntInRange,
	parsePathList,
	reorderCalendarPlacement,
} from "./settingsFormat";

describe("parsePathList / formatPathList", () => {
	it("путь-на-строку: trim, пустые строки отбрасываются, CRLF ок", () => {
		expect(parsePathList("GTD/Inbox.md\r\n  Работа/Входящие.md  \n\n\nАрхив\n")).toEqual([
			"GTD/Inbox.md",
			"Работа/Входящие.md",
			"Архив",
		]);
	});

	it("пустой/пробельный текст → пустой список", () => {
		expect(parsePathList("")).toEqual([]);
		expect(parsePathList("  \n \r\n ")).toEqual([]);
	});

	it("round-trip: format → parse возвращает исходный список", () => {
		const paths = ["GTD/Inbox.md", "Работа/Входящие.md"];
		expect(parsePathList(formatPathList(paths))).toEqual(paths);
	});
});

describe("parseDeferPresets / formatDeferPresets", () => {
	it("разбирает «Метка|дни», пропуская пустые строки", () => {
		const { presets, invalid } = parseDeferPresets("Завтра|1\n\n  Через неделю | 7 \r\n+3 дня|3");
		expect(invalid).toEqual([]);
		expect(presets).toEqual([
			{ label: "Завтра", offsetDays: 1 },
			{ label: "Через неделю", offsetDays: 7 },
			{ label: "+3 дня", offsetDays: 3 },
		]);
	});

	it("невалидные строки попадают в invalid, валидные — сохраняются", () => {
		const { presets, invalid } = parseDeferPresets("Завтра|1\nбез разделителя\n|5\nМетка|1.5\nМетка|-2\nОк|0");
		expect(presets).toEqual([
			{ label: "Завтра", offsetDays: 1 },
			{ label: "Ок", offsetDays: 0 },
		]);
		expect(invalid).toEqual(["без разделителя", "|5", "Метка|1.5", "Метка|-2"]);
	});

	it("разделитель — последний «|»: метка может содержать «|»", () => {
		const { presets, invalid } = parseDeferPresets("A|B|14");
		expect(invalid).toEqual([]);
		expect(presets).toEqual([{ label: "A|B", offsetDays: 14 }]);
	});

	it("round-trip дефолтных пресетов", () => {
		const text = formatDeferPresets(DEFAULT_SETTINGS.deferPresets);
		expect(parseDeferPresets(text)).toEqual({ presets: DEFAULT_SETTINGS.deferPresets, invalid: [] });
	});
});

describe("parseIntInRange", () => {
	it("строгое целое: пробелы вокруг ок, «+» ок", () => {
		expect(parseIntInRange(" 42 ", 0)).toBe(42);
		expect(parseIntInRange("+7", 0)).toBe(7);
		expect(parseIntInRange("0", 0)).toBe(0);
	});

	it("мусор → null (в отличие от Number: «» было бы 0)", () => {
		for (const bad of ["", "  ", "abc", "12abc", "1.5", "1e3", "--5", "NaN"]) {
			expect(parseIntInRange(bad, 0)).toBeNull();
		}
	});

	it("границы диапазона включительны, выход за них → null", () => {
		expect(parseIntInRange("1", 1, 30)).toBe(1);
		expect(parseIntInRange("30", 1, 30)).toBe(30);
		expect(parseIntInRange("0", 1, 30)).toBeNull();
		expect(parseIntInRange("31", 1, 30)).toBeNull();
		expect(parseIntInRange("-1", 0)).toBeNull();
	});
});

describe("reorderCalendarPlacement", () => {
	it("выбранное поле — в голову, остальные сохраняют относительный порядок", () => {
		expect(reorderCalendarPlacement(["due", "scheduled", "start"], "start")).toEqual(["start", "due", "scheduled"]);
		expect(reorderCalendarPlacement(["start", "due", "scheduled"], "due")).toEqual(["due", "start", "scheduled"]);
	});

	it("выбор уже первого поля — порядок не меняется", () => {
		expect(reorderCalendarPlacement(["due", "scheduled", "start"], "due")).toEqual(["due", "scheduled", "start"]);
	});

	it("нормализует руками правленный data.json: дубликаты и пропуски", () => {
		expect(reorderCalendarPlacement(["due", "due"], "scheduled")).toEqual(["scheduled", "due", "start"]);
		expect(reorderCalendarPlacement([], "start")).toEqual(["start", "due", "scheduled"]);
	});
});
