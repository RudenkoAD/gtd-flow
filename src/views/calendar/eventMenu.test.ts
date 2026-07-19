import { describe, expect, it } from "vitest";
import { buildEventMenuModel, type EventMenuItemId } from "./eventMenu";

/** Порядок id по виду строки — единый контракт чипов и блоков почасовой сетки. */
describe("buildEventMenuModel — модель пунктов меню события", () => {
	it("серия: 7 пунктов в каноничном порядке; перенос — «вхождение»", () => {
		const items = buildEventMenuModel("series", false);
		expect(items.map((i) => i.id)).toEqual<EventMenuItemId[]>([
			"edit-series",
			"location",
			"transfer",
			"copy-occurrence",
			"copy-series",
			"delete-occurrence",
			"delete-series",
		]);
		expect(items.find((i) => i.id === "transfer")!.title).toBe("Перенести вхождение…");
	});

	it("одноразовое: 4 пункта; перенос — «событие» (Задание 3), без пунктов серии", () => {
		const items = buildEventMenuModel("single", false);
		expect(items.map((i) => i.id)).toEqual<EventMenuItemId[]>([
			"location",
			"transfer",
			"copy-single",
			"delete-single",
		]);
		// у одноразового подпись переноса — «Перенести событие…» (правится сама строка)
		expect(items.find((i) => i.id === "transfer")!.title).toBe("Перенести событие…");
		// серийных пунктов нет
		for (const id of ["edit-series", "copy-occurrence", "copy-series", "delete-occurrence", "delete-series"])
			expect(items.some((i) => i.id === id)).toBe(false);
	});

	it("подпись места зависит от наличия 📍 (серия и одноразовое одинаково)", () => {
		for (const kind of ["series", "single"] as const) {
			expect(buildEventMenuModel(kind, false).find((i) => i.id === "location")!.title).toBe(
				"Добавить место…",
			);
			expect(buildEventMenuModel(kind, true).find((i) => i.id === "location")!.title).toBe(
				"Изменить место…",
			);
		}
	});

	it("каждый пункт несёт непустую иконку и заголовок", () => {
		for (const kind of ["series", "single"] as const)
			for (const item of buildEventMenuModel(kind, false)) {
				expect(item.icon.length).toBeGreaterThan(0);
				expect(item.title.length).toBeGreaterThan(0);
			}
	});
});
