import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsVault } from "./fsVault";
import { buildIndex } from "./buildIndex";
import { FIXTURE_FILES, FIXTURE_TODAY, makeVault, removeVault } from "./testVault";

describe("buildIndex", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeVault(FIXTURE_FILES);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	it("строит глобальный индекс из скана vault'а", async () => {
		const vault = new FsVault(root);
		const files = await vault.listMarkdownFiles();
		const { feed, boardPaths, projectPaths } = await buildIndex(files, FIXTURE_TODAY);
		const index = feed.getIndex();
		const all = [...index.all()];

		// доска и проект найдены как контейнеры (для BoardService/ProjectService)
		expect(boardPaths).toContain("Работа/Доски/Спринт.md");
		expect(projectPaths).toContain("Жизнь/Проекты/Ремонт.md");

		// 🆔-адресация работает
		expect(index.resolveDep("aaa111")).toHaveLength(1);
		expect(index.resolveDep("proj01")).toHaveLength(1);
		expect(index.resolveDep("card01")).toHaveLength(1);

		// контейнеры распознаны по frontmatter
		const byFile = (path: string) => index.fileTasks(path);
		expect(byFile("GTD/Inbox.md").every((t) => t.container === "inbox")).toBe(true);
		expect(byFile("Работа/Доски/Спринт.md").every((t) => t.container === "board")).toBe(true);
		expect(byFile("Жизнь/События.md").every((t) => t.container === "events")).toBe(true);
		expect(byFile("Жизнь/Проекты/Ремонт.md").every((t) => t.container === "project")).toBe(
			true,
		);

		// событие-серия несёт правило и место распознаётся (📍 нет тут, но 🔁 есть)
		const yoga = byFile("Жизнь/События.md").find((t) => t.description === "Йога");
		expect(yoga?.recurrence).toBe("every monday at 08:00");

		expect(all.find((task) => task.taskId === "card01")?.scopeId).toBe("work");
		expect(all.find((task) => task.taskId === "proj01")?.scopeId).toBe("life");
	});

	it("пункты внутри огороженного блока кода не считаются задачами", async () => {
		const r = await makeVault({
			"Note.md": "# H\n- [ ] real task\n\n```\n- [ ] fake in code\n```\n- [ ] second real\n",
		});
		try {
			const vault = new FsVault(r);
			const { feed } = await buildIndex(await vault.listMarkdownFiles(), FIXTURE_TODAY);
			const tasks = feed.getIndex().fileTasks("Note.md");
			const descs = tasks.map((t) => t.description).sort();
			expect(descs).toEqual(["real task", "second real"]);
			expect(tasks.find((t) => t.description === "real task")?.heading).toBe("H");
		} finally {
			await removeVault(r);
		}
	});

	// --- паритет с кэшем Obsidian: цитаты/коллауты ---

	it("задачи в цитатах/коллаутах не попадают в индекс (как в плагине)", async () => {
		// Obsidian кладёт такие пункты в ListItemCache, но parseTaskLine плагина
		// отбрасывает строку с префиксом «> » — итог одинаков на обеих сторонах:
		// задача не индексируется. Скан зеркалит кэш, отбрасывает даунстрим.
		const r = await makeVault({
			"Note.md": [
				"- [ ] обычная задача",
				"> - [ ] задача в цитате",
				"> > - [ ] задача во вложенной цитате",
				"> [!note]",
				"> - [ ] задача в коллауте",
				"",
			].join("\n"),
		});
		try {
			const vault = new FsVault(r);
			const { feed } = await buildIndex(await vault.listMarkdownFiles(), FIXTURE_TODAY);
			const descs = feed
				.getIndex()
				.fileTasks("Note.md")
				.map((t) => t.description)
				.sort();
			expect(descs).toEqual(["обычная задача"]);
		} finally {
			await removeVault(r);
		}
	});

	// --- паритет с кэшем Obsidian: отступные блоки кода vs вложенные подзадачи ---

	it("отступный блок кода не индексируется, вложенные подзадачи — индексируются", async () => {
		const r = await makeVault({
			"Note.md": [
				"Абзац текста.",
				"",
				"    - [ ] фейк в отступном блоке кода",
				"",
				"- [ ] родитель",
				"    - [ ] вложенная подзадача",
				"	- [ ] подзадача с табом",
				"",
			].join("\n"),
		});
		try {
			const vault = new FsVault(r);
			const { feed } = await buildIndex(await vault.listMarkdownFiles(), FIXTURE_TODAY);
			const tasks = feed.getIndex().fileTasks("Note.md");
			const descs = tasks.map((t) => t.description).sort();
			expect(descs).toEqual(["вложенная подзадача", "подзадача с табом", "родитель"]);
			// родительская связь по отступу сохранена
			const child = tasks.find((t) => t.description === "вложенная подзадача");
			const parent = tasks.find((t) => t.description === "родитель");
			expect(child?.parentLine).toBe(parent?.lineStart);
		} finally {
			await removeVault(r);
		}
	});

	it("отступная строка-пункт после пустой строки и не-списка — код, после пункта — список", async () => {
		const r = await makeVault({
			"Note.md": [
				"- [ ] верхний пункт",
				"    - [ ] продолжение списка (реальная задача)",
				"",
				"Текст-разделитель.",
				"",
				"	- [ ] таб-отступный код после текста",
				"",
			].join("\n"),
		});
		try {
			const vault = new FsVault(r);
			const { feed } = await buildIndex(await vault.listMarkdownFiles(), FIXTURE_TODAY);
			const descs = feed
				.getIndex()
				.fileTasks("Note.md")
				.map((t) => t.description)
				.sort();
			expect(descs).toEqual(["верхний пункт", "продолжение списка (реальная задача)"]);
		} finally {
			await removeVault(r);
		}
	});
});
