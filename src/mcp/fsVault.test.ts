import { promises as fs } from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsVault } from "./fsVault";
import { makeVault, readVaultFile, removeVault } from "./testVault";

describe("FsVault", () => {
	let root: string;
	let vault: FsVault;

	beforeEach(async () => {
		root = await makeVault({
			"Note.md": "hello\n",
			"Sub/Deep.md": "deep\n",
			"Board.md": "---\ngtd-board: true\nid: b\n---\n- [ ] card\n",
		});
		vault = new FsVault(root);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	it("read-modify-write заменяет содержимое; no-op не пишет", async () => {
		const changed = await vault.processFile("Note.md", (c) => c.toUpperCase());
		expect(changed).toBe(true);
		expect(await readVaultFile(root, "Note.md")).toBe("HELLO\n");

		// transform вернул исходную строку — записи нет
		const noop = await vault.processFile("Note.md", (c) => c);
		expect(noop).toBe(false);

		// transform вернул null — записи нет
		const nullNoop = await vault.processFile("Note.md", () => null);
		expect(nullNoop).toBe(false);
	});

	it("processFile для несуществующего файла → false, без создания", async () => {
		const changed = await vault.processFile("Missing.md", () => "x");
		expect(changed).toBe(false);
		await expect(fs.access(path.join(root, "Missing.md"))).rejects.toBeDefined();
	});

	it("запись атомарна: temp-файлы не остаются", async () => {
		await vault.processFile("Note.md", (c) => c + "more\n");
		const entries = await fs.readdir(root);
		expect(entries.some((e) => e.includes(".tmp"))).toBe(false);
		expect(await readVaultFile(root, "Note.md")).toBe("hello\nmore\n");
	});

	it("отказывается писать за пределами vault (../ и абсолютный путь)", async () => {
		expect(() => new FsVault(root)).not.toThrow();
		await expect(vault.processFile("../escape.md", () => "x")).rejects.toThrow(/выходит за пределы/);
		await expect(vault.processFile("Sub/../../escape.md", () => "x")).rejects.toThrow(
			/выходит за пределы/,
		);
		// путь ВНУТРИ через ../ обратно допустим
		const ok = await vault.processFile("Sub/../Note.md", (c) => c + "!");
		expect(ok).toBe(true);
	});

	it("ensureFile создаёт файл и родительские папки, существующий не трогает", async () => {
		await vault.ensureFile("New/Folder/File.md");
		expect(await readVaultFile(root, "New/Folder/File.md")).toBe("");
		// существующий файл не перезаписывается
		await vault.ensureFile("Note.md");
		expect(await readVaultFile(root, "Note.md")).toBe("hello\n");
	});

	it("processFrontmatter создаёт и мутирует frontmatter, тело сохраняет", async () => {
		// файл без frontmatter — блок создаётся в начале
		const ok = await vault.processFrontmatter("Note.md", (fm) => {
			fm["gtd-inbox"] = true;
		});
		expect(ok).toBe(true);
		const content = await readVaultFile(root, "Note.md");
		expect(content.startsWith("---\n")).toBe(true);
		expect(content).toContain("gtd-inbox: true");
		expect(content.trimEnd().endsWith("hello")).toBe(true);
	});

	it("processFrontmatter мутирует существующий frontmatter, не теряя чужие ключи", async () => {
		await vault.processFrontmatter("Board.md", (fm) => {
			fm["order"] = { todo: ["card01"] };
		});
		const fm = vault.readFrontmatterSync("Board.md");
		expect(fm).not.toBeNull();
		expect(fm!["gtd-board"]).toBe(true);
		expect(fm!["id"]).toBe("b");
		expect(fm!["order"]).toEqual({ todo: ["card01"] });
	});

	it("listMarkdownFiles обходит рекурсивно и пропускает .obsidian/.git", async () => {
		await makeVaultDot(root);
		const files = await vault.listMarkdownFiles();
		const paths = files.map((f) => f.path).sort();
		expect(paths).toContain("Note.md");
		expect(paths).toContain("Sub/Deep.md");
		expect(paths).toContain("Board.md");
		expect(paths.some((p) => p.startsWith(".obsidian"))).toBe(false);
		expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
	});
});

/** Дописать скрытые папки, которые скан обязан пропустить. */
async function makeVaultDot(root: string): Promise<void> {
	await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
	await fs.writeFile(path.join(root, ".obsidian", "config.md"), "x", "utf8");
	await fs.mkdir(path.join(root, ".git"), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD.md"), "x", "utf8");
}
