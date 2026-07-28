import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadSettings } from "./config";
import { FsVault } from "./fsVault";
import { openSession } from "./session";
import { FIXTURE_FILES, FIXTURE_TODAY, makeVault, removeVault } from "./testVault";

describe("MCP session index cache", () => {
	it("reuses a built index for an unchanged vault and rebuilds it after a write", async () => {
		const root = await makeVault(FIXTURE_FILES);
		try {
			const settings = await loadSettings(root);
			const first = await openSession({
				vault: new FsVault(root),
				settings,
				today: FIXTURE_TODAY,
			});
			const second = await openSession({
				vault: new FsVault(root),
				settings,
				today: FIXTURE_TODAY,
			});
			expect(second.feed).toBe(first.feed);

			await second.vault.processFile("GTD/Inbox.md", (content) => `${content}- [ ] fresh\n`);
			const third = await openSession({
				vault: new FsVault(root),
				settings,
				today: FIXTURE_TODAY,
			});
			expect(third.feed).not.toBe(first.feed);
			expect(third.allTasks.some((task) => task.description === "fresh")).toBe(true);
		} finally {
			await removeVault(root);
		}
	});

	it("fails board persistence when a board disappears after the scan", async () => {
		const root = await makeVault({
			"Board.md": `---\ngtd-board: true\nid: dev\ncolumns:\n  - id: todo\n    name: Todo\n    match: '#kanban/dev/todo'\n---\n- [ ] task 🆔 a #kanban/dev/todo\n`,
		});
		try {
			const settings = await loadSettings(root);
			const session = await openSession({
				vault: new FsVault(root),
				settings,
				today: FIXTURE_TODAY,
			});
			await rm(join(root, "Board.md"));
			await expect(session.boards.reorderCard("Board.md", "todo", ["a"])).rejects.toThrow(
				"board-frontmatter-write-failed:Board.md",
			);
		} finally {
			await removeVault(root);
		}
	});
});
