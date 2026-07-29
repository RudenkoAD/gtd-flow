/**
 * Помощники для тестов MCP-сервера: временный vault из карты «путь → содержимое»
 * во временной папке (mkdtemp), плюс общая фикстура с двумя пространствами.
 * Не тест сам по себе (импортируется тестами); в бандл mcp-server.js не входит.
 */
import { promises as fs } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

/** Создать временный vault и записать файлы (ключи — vault-относительные POSIX). */
export async function makeVault(files: Record<string, string>): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), "gtd-mcp-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel.split("/").join(path.sep));
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, "utf8");
	}
	return root;
}

export async function readVaultFile(root: string, rel: string): Promise<string> {
	return fs.readFile(path.join(root, rel.split("/").join(path.sep)), "utf8");
}

export async function removeVault(root: string): Promise<void> {
	await fs.rm(root, { recursive: true, force: true });
}

/** Unified-inbox data.json used by standalone MCP tests. */
const DATA_JSON = JSON.stringify({
	inboxFile: "GTD/Inbox.md",
	eventsFile: "GTD/Events.md",
	autoInjectId: true,
});

/**
 * Общая фикстура: общий инбокс (GTD/), инбокс Жизни, проект Жизни, доска Работы,
 * события Жизни. Даты подобраны относительно FIXTURE_TODAY.
 */
export const FIXTURE_TODAY = "2026-07-19";

export const FIXTURE_FILES: Record<string, string> = {
	".obsidian/plugins/gtd-flow/data.json": DATA_JSON,

	"GTD/Inbox.md": `---
gtd-inbox: true
---
- [ ] Общая задача без даты
- [ ] Задача с айди 🆔 aaa111
- [ ] Купить молоко 📅 2026-07-20
`,
	".gtd-flow/config/scopes.json": JSON.stringify({
		schemaVersion: 1,
		scopes: [
			{ id: "work", name: "Работа", order: 0, archived: false },
			{ id: "life", name: "Жизнь", order: 1, archived: false },
		],
	}),

	"Жизнь/Входящие.md": `---
gtd-inbox: true
---
- [ ] Позвонить маме 🧭 life
- [ ] Записаться к врачу 🛫 2026-08-01 🧭 life
`,

	"Жизнь/Проекты/Ремонт.md": `---
gtd-project: true
name: Ремонт кухни
---
- [ ] Выбрать плитку 🆔 proj01 🧭 life
- [x] Замерить стены 🆔 proj02 ✅ 2026-07-10
`,

	"Работа/Доски/Спринт.md": `---
gtd-board: true
id: sprint
name: Спринт
columns:
  - {id: todo, name: Очередь, match: "#kanban/sprint/todo"}
  - {id: doing, name: В работе, match: "#kanban/sprint/doing"}
  - {id: done, name: Готово, match: "#kanban/sprint/done"}
---
- [ ] Задача A #kanban/sprint/todo 🆔 card01 🧭 work
- [ ] Задача B #kanban/sprint/doing 🆔 card02 🧭 work
`,

	"Жизнь/События.md": `---
gtd-events: true
---
- [ ] Йога 🔁 every monday at 08:00
- [ ] День рождения 📅 2026-07-25
`,
};
