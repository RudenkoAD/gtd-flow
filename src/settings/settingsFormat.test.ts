/**
 * settingsFormat: текст полей вкладки настроек — ручной ввод, поэтому мусор,
 * CRLF, лишние пробелы и частично невалидные строки — штатный вход.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./Settings";
import {
	commitInboxFile,
	commitSubName,
	formatDeferPresets,
	formatPathList,
	parseDeferPresets,
	parseIntInRange,
	parsePathList,
	planSubNameCommit,
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
		const { presets, invalid } = parseDeferPresets(
			"Завтра|1\n\n  Через неделю | 7 \r\n+3 дня|3",
		);
		expect(invalid).toEqual([]);
		expect(presets).toEqual([
			{ label: "Завтра", offsetDays: 1 },
			{ label: "Через неделю", offsetDays: 7 },
			{ label: "+3 дня", offsetDays: 3 },
		]);
	});

	it("невалидные строки попадают в invalid, валидные — сохраняются", () => {
		const { presets, invalid } = parseDeferPresets(
			"Завтра|1\nбез разделителя\n|5\nМетка|1.5\nМетка|-2\nОк|0",
		);
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
		expect(parseDeferPresets(text)).toEqual({
			presets: DEFAULT_SETTINGS.deferPresets,
			invalid: [],
		});
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
		expect(reorderCalendarPlacement(["due", "scheduled", "start"], "start")).toEqual([
			"start",
			"due",
			"scheduled",
		]);
		expect(reorderCalendarPlacement(["start", "due", "scheduled"], "due")).toEqual([
			"due",
			"start",
			"scheduled",
		]);
	});

	it("выбор уже первого поля — порядок не меняется", () => {
		expect(reorderCalendarPlacement(["due", "scheduled", "start"], "due")).toEqual([
			"due",
			"scheduled",
			"start",
		]);
	});

	it("нормализует руками правленный data.json: дубликаты и пропуски", () => {
		expect(reorderCalendarPlacement(["due", "due"], "scheduled")).toEqual([
			"scheduled",
			"due",
			"start",
		]);
		expect(reorderCalendarPlacement([], "start")).toEqual(["start", "due", "scheduled"]);
	});
});

describe("planSubNameCommit", () => {
	it("имя не менялось → renamed=false (зеркало не трогаем)", () => {
		expect(planSubNameCommit("Луна", "Луна")).toEqual({ value: "Луна", renamed: false });
	});

	it("только краевые пробелы → не изменение, но значение обрезается", () => {
		expect(planSubNameCommit("Луна", "  Луна ")).toEqual({ value: "Луна", renamed: false });
	});

	it("имя изменилось → renamed=true, значение обрезано", () => {
		expect(planSubNameCommit("Новый календарь", "  Луна  ")).toEqual({
			value: "Луна",
			renamed: true,
		});
	});

	it("очистка в пусто → renamed=true, value пустой (строка покажет «(без имени)»)", () => {
		expect(planSubNameCommit("Луна", "")).toEqual({ value: "", renamed: true });
		expect(planSubNameCommit("Луна", "   ")).toEqual({ value: "", renamed: true });
	});

	it("пустое → пустое → не изменение", () => {
		expect(planSubNameCommit("", "  ")).toEqual({ value: "", renamed: false });
	});
});

describe("commitSubName", () => {
	it("переименование: deleteMirror СТАРОГО имени ровно раз, save раз, sub.name обновлён, true", async () => {
		const sub = { name: "Новый календарь" };
		const deleteMirror = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);

		const renamed = await commitSubName(sub, "  Луна  ", { deleteMirror, save });

		expect(renamed).toBe(true);
		expect(deleteMirror).toHaveBeenCalledTimes(1);
		expect(deleteMirror).toHaveBeenCalledWith("Новый календарь"); // старое, не новое
		expect(save).toHaveBeenCalledTimes(1);
		expect(sub.name).toBe("Луна"); // записано обрезанное новое имя
	});

	it("зеркало удаляется ДО мутации sub.name (порт видит старое имя)", async () => {
		const sub = { name: "Старое" };
		let nameAtDelete: string | null = null;
		const deleteMirror = vi.fn(async () => {
			nameAtDelete = sub.name;
		});
		const save = vi.fn(async () => undefined);

		await commitSubName(sub, "Новое", { deleteMirror, save });

		expect(nameAtDelete).toBe("Старое");
	});

	it("имя не изменилось: ни deleteMirror, ни save, sub.name как был, false", async () => {
		const sub = { name: "Луна" };
		const deleteMirror = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);

		const renamed = await commitSubName(sub, "  Луна ", { deleteMirror, save });

		expect(renamed).toBe(false);
		expect(deleteMirror).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(sub.name).toBe("Луна");
	});

	it("очистка в пусто — тоже переименование: deleteMirror старого раз, sub.name пуст", async () => {
		const sub = { name: "Луна" };
		const deleteMirror = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);

		const renamed = await commitSubName(sub, "   ", { deleteMirror, save });

		expect(renamed).toBe(true);
		expect(deleteMirror).toHaveBeenCalledTimes(1);
		expect(deleteMirror).toHaveBeenCalledWith("Луна");
		expect(sub.name).toBe("");
	});
});

describe("commitInboxFile", () => {
	it("реальное изменение: путь обрезан, reconcile и save по одному разу, true", async () => {
		const settings = { inboxFile: "Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		const changed = await commitInboxFile(settings, "  GTD/Inbox.md  ", { reconcile, save });

		expect(changed).toBe(true);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
	});

	// Ключ фикса: путь зеркал ICS считается от папки этого файла, поэтому запись на
	// каждый символ гоняла зеркала по промежуточным путям («G», «GT», …) и на каждое
	// поколение конфигурации перезапускала полный сетевой проход по всем лентам.
	it("промежуточные значения набора коммитом не считаются: один коммит на весь путь", async () => {
		const settings = { inboxFile: "Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		// blur наступает один раз — ровно с итоговым значением поля
		await commitInboxFile(settings, "GTD/Inbox.md", { reconcile, save });

		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
	});

	it("то же значение (и лишние пробелы) — ни reconcile, ни save, false", async () => {
		const settings = { inboxFile: "GTD/Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		expect(await commitInboxFile(settings, "  GTD/Inbox.md ", { reconcile, save })).toBe(false);
		expect(reconcile).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("пустое значение изменением не считается — прежний путь сохраняется", async () => {
		const settings = { inboxFile: "GTD/Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		expect(await commitInboxFile(settings, "   ", { reconcile, save })).toBe(false);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
		expect(reconcile).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});
});
