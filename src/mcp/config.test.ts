import { describe, expect, it } from "vitest";
import { loadSettings, McpConfigError } from "./config";
import { makeVault, removeVault } from "./testVault";

describe("MCP configuration", () => {
	it("uses the unified inbox default when settings are absent", async () => {
		const root = await makeVault({});
		try {
			const settings = await loadSettings(root);
			expect(settings.inboxFile).toBe("GTD/Inbox.md");
		} finally {
			await removeVault(root);
		}
	});

	it("fails closed for malformed persisted settings", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": "{ invalid",
		});
		try {
			await expect(loadSettings(root)).rejects.toBeInstanceOf(McpConfigError);
		} finally {
			await removeVault(root);
		}
	});

	// Регрессия: любой data.json старше 0.13 (пространства, без inboxFile) даёт
	// диагностику штатной миграции, и разбор её по тексту ронял ВСЕ девять
	// инструментов — loadSettings вызывается на каждый вызов инструмента, а
	// плагин переписывает data.json только при сохранении настроек.
	it("загружает legacy data.json 0.12 (пространства) через миграцию, а не падает", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": JSON.stringify({
				settingsVersion: 1,
				commonRoot: "GTD",
				activeNamespace: "Общее",
				namespaces: [{ name: "Работа", root: "Работа" }],
				recurring: { catchUp: "latest", catchUpCap: 30, spawnTarget: "GTD/Inbox.md" },
				ai: { privacyPolicy: "unconfigured", credentialStorage: "unconfigured" },
				eventsFile: "GTD/События.md",
			}),
		});
		try {
			const settings = await loadSettings(root);
			// Единый инбокс выводится из commonRoot — там лежат реальные захваты.
			expect(settings.inboxFile).toBe("GTD/Входящие.md");
			expect(settings.eventsFile).toBe("GTD/События.md");
			expect(settings.ai.privacyPolicy).toBe("account-policy");
		} finally {
			await removeVault(root);
		}
	});

	it("data.json из будущей версии по-прежнему fail-closed", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": JSON.stringify({
				settingsVersion: 99,
				inboxFile: "GTD/Inbox.md",
			}),
		});
		try {
			await expect(loadSettings(root)).rejects.toThrow(/settingsVersion/);
		} finally {
			await removeVault(root);
		}
	});
});
