import { describe, expect, it } from "vitest";
import { loadWidgetSettings } from "./widgetSettings";

describe("widget unified settings", () => {
	it("reads a valid inboxFile and ignores unrelated legacy keys", () => {
		const { settings } = loadWidgetSettings(
			JSON.stringify({ inboxFile: "Capture.md", namespaces: [{ name: "Old", root: "Old" }] }),
		);
		expect(settings.inboxFile).toBe("Capture.md");
	});

	// Контракт с Android: если data.json ещё не мигрирован (плагин 0.13 не
	// запускался), виджет обязан вывести ТОТ ЖЕ путь, что выведет плагин. Иначе
	// захват с телефона уходит в файл, который QueryEngine.isInInbox входящими
	// уже не считает, и задача пропадает молча.
	it("выводит единый файл входящих из legacy-настроек пространств", () => {
		const { settings } = loadWidgetSettings(
			JSON.stringify({
				commonRoot: "GTD",
				namespaces: [{ name: "Работа", root: "Work" }],
				recurring: { spawnTarget: "GTD/Inbox.md" },
			}),
		);
		expect(settings.inboxFile).toBe("GTD/Входящие.md");
	});

	it("явный inboxFile побеждает legacy-вывод, мусорный путь откатывается к дефолту", () => {
		expect(
			loadWidgetSettings(JSON.stringify({ inboxFile: "Мои/Входящие.md", commonRoot: "GTD" }))
				.settings.inboxFile,
		).toBe("Мои/Входящие.md");
		expect(loadWidgetSettings(JSON.stringify({ inboxFile: "   " })).settings.inboxFile).toBe(
			"GTD/Inbox.md",
		);
		expect(loadWidgetSettings(null).settings.inboxFile).toBe("GTD/Inbox.md");
	});

	it("migrates legacy duration presentation without consuming AI secrets", () => {
		const { settings } = loadWidgetSettings(
			JSON.stringify({
				durationLongStyle: "days-hours",
				ai: { enabled: true, apiKey: "must-not-be-consumed" },
			}),
		);
		expect(settings.durationLongStyle).toBe("whole-days");
		expect(settings.ai).toEqual({
			enabled: false,
			privacyPolicy: "account-policy",
			credentialStorage: "memory-only",
			storageVersion: 0,
		});
	});
});
