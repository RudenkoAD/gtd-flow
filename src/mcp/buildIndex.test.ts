import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNamespace } from "../core/namespace/namespace";
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

	it("строит индекс из скана vault'а с двумя пространствами", async () => {
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
		expect(byFile("Жизнь/Проекты/Ремонт.md").every((t) => t.container === "project")).toBe(true);

		// событие-серия несёт правило и место распознаётся (📍 нет тут, но 🔁 есть)
		const yoga = byFile("Жизнь/События.md").find((t) => t.description === "Йога");
		expect(yoga?.recurrence).toBe("every monday at 08:00");

		// пространства резолвятся по папкам
		const defs = [
			{ name: "Работа", root: "Работа" },
			{ name: "Жизнь", root: "Жизнь" },
		];
		const card = all.find((t) => t.taskId === "card01")!;
		expect(resolveNamespace(card.filePath, card.nsOverride ?? null, defs)).toBe("Работа");
		const proj = all.find((t) => t.taskId === "proj01")!;
		expect(resolveNamespace(proj.filePath, proj.nsOverride ?? null, defs)).toBe("Жизнь");
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
});
