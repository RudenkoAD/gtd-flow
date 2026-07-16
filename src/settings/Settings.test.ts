/**
 * defaultUnderCommonRoot: «дефолт следует за commonRoot». Логика для dayStatusFile
 * (main.ts): нетронутое дефолтное поле создаётся в «Корневой папке Общего» и следует
 * за её сменой; кастомный путь задан осознанно и остаётся как есть.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultUnderCommonRoot } from "./Settings";

describe("defaultUnderCommonRoot", () => {
	const FACTORY = DEFAULT_SETTINGS.dayStatusFile; // "GTD/DayStatus.md"

	it("дефолт + дефолтный commonRoot ⇒ тот же путь (no-op обратной совместимости)", () => {
		expect(defaultUnderCommonRoot(FACTORY, FACTORY, "GTD")).toBe("GTD/DayStatus.md");
	});

	it("дефолт + сменённый commonRoot ⇒ <commonRoot>/<имя-файла-дефолта>", () => {
		expect(defaultUnderCommonRoot(FACTORY, FACTORY, "Жизнь")).toBe("Жизнь/DayStatus.md");
		expect(defaultUnderCommonRoot(FACTORY, FACTORY, "Areas/GTD")).toBe("Areas/GTD/DayStatus.md");
	});

	it("кастомный путь не трогается, даже если commonRoot сменён", () => {
		expect(defaultUnderCommonRoot("Мой/Статусы.md", FACTORY, "Жизнь")).toBe("Мой/Статусы.md");
	});

	it("commonRoot нормализуется (хвостовой слэш срезается)", () => {
		expect(defaultUnderCommonRoot(FACTORY, FACTORY, "Жизнь/")).toBe("Жизнь/DayStatus.md");
	});

	it("пустой/корневой commonRoot ⇒ голое имя файла (в корне хранилища)", () => {
		expect(defaultUnderCommonRoot(FACTORY, FACTORY, "")).toBe("DayStatus.md");
		expect(defaultUnderCommonRoot(FACTORY, FACTORY, "/")).toBe("DayStatus.md");
	});
});
