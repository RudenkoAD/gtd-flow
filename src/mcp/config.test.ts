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
});
