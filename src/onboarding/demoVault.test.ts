import { describe, expect, it } from "vitest";
import { parseBoardFrontmatter, isBoardError } from "../core/board/boardFile";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { isParseError, parseRule } from "../core/recurrence/grammar";
import type { Task } from "../core/model/Task";
import {
	createDemoVault,
	demoTaskLines,
	demoVaultNotice,
	DEMO_BOARD,
	DEMO_EVENTS,
	DEMO_FILES,
	DEMO_INBOX,
	DEMO_PROJECT,
	DEMO_RECURRING,
	type DemoFileSpec,
	type DemoVaultPort,
} from "./demoVault";

// ---------------------------------------------------------------------------
// Фейковый порт: карта путь → содержимое + отдельная карта frontmatter
// (как в eventSeries.test — frontmatter живёт вне тела файла)
// ---------------------------------------------------------------------------

class FakeVault implements DemoVaultPort {
	files = new Map<string, string>();
	frontmatter = new Map<string, Record<string, unknown>>();

	async ensureFile(path: string): Promise<void> {
		if (!this.files.has(path)) this.files.set(path, "");
	}
	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		if (!this.files.has(path)) return false;
		const next = transform(this.files.get(path)!);
		if (next === null) return false;
		this.files.set(path, next);
		return true;
	}
	async processFrontmatter(
		path: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<unknown> {
		const fm = this.frontmatter.get(path) ?? {};
		fn(fm);
		this.frontmatter.set(path, fm);
		return undefined;
	}
}

function taskFrom(spec: DemoFileSpec, rawLine: string): Task {
	const t = parseTaskLine(rawLine, {
		filePath: spec.path,
		lineStart: 0,
		parentLine: null,
		heading: null,
		container: spec.container,
		projectActive: true,
	});
	if (t === null) throw new Error(`не задача: ${rawLine}`);
	return t;
}

// ---------------------------------------------------------------------------
// Содержимое парсится ядром
// ---------------------------------------------------------------------------

describe("демо-контент парсится ядром", () => {
	it("каждая строка задачи каждого файла — валидная задача", () => {
		for (const spec of DEMO_FILES) {
			const lines = demoTaskLines(spec);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				const t = taskFrom(spec, line);
				expect(t.description).not.toBe("");
			}
		}
	});

	it("входящие: 3 демо-задачи", () => {
		expect(demoTaskLines(DEMO_INBOX)).toHaveLength(3);
	});

	it("доска: frontmatter валиден, 3 колонки, каждая задача матчит колонку", () => {
		const def = parseBoardFrontmatter(DEMO_BOARD.frontmatter);
		expect(isBoardError(def)).toBe(false);
		if (isBoardError(def)) return;
		expect(def.id).toBe("primer");
		expect(def.name).toBe("Пример");
		expect(def.columns).toHaveLength(3);
		expect(def.columns.map((c) => c.name)).toEqual(["Очередь", "В работе", "Готово"]);

		const colTags = new Set(def.columns.map((c) => c.match.slice(1))); // без '#'
		const lines = demoTaskLines(DEMO_BOARD);
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			const t = taskFrom(DEMO_BOARD, line);
			// ровно один тег колонки на карточку
			const matched = t.tags.filter((tag) => colTags.has(tag.slice(1)));
			expect(matched).toHaveLength(1);
		}
	});

	it("проект: 🆔 у всех задач и цепочка ⛔ a→b→c плюс независимая d", () => {
		const lines = demoTaskLines(DEMO_PROJECT);
		expect(lines).toHaveLength(4);
		const byId = new Map<string, Task>();
		for (const line of lines) {
			const t = taskFrom(DEMO_PROJECT, line);
			expect(t.taskId).not.toBeNull();
			byId.set(t.taskId!, t);
		}
		const ids = [...byId.keys()].sort();
		expect(ids).toEqual(["demo-a", "demo-b", "demo-c", "demo-d"]);
		// цепочка зависимостей
		expect(byId.get("demo-a")!.dependsOn).toEqual([]);
		expect(byId.get("demo-b")!.dependsOn).toEqual(["demo-a"]);
		expect(byId.get("demo-c")!.dependsOn).toEqual(["demo-b"]);
		expect(byId.get("demo-d")!.dependsOn).toEqual([]);
	});

	it("регулярные и события: правило 🔁 разбирается parseRule", () => {
		for (const spec of [DEMO_RECURRING, DEMO_EVENTS]) {
			const [line] = demoTaskLines(spec);
			const t = taskFrom(spec, line!);
			expect(t.recurrence).not.toBeNull();
			const rule = parseRule(t.recurrence!);
			expect(isParseError(rule)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// createDemoVault: паттерн ensureFile → флаг → строки, идемпотентность
// ---------------------------------------------------------------------------

describe("createDemoVault", () => {
	it("создаёт все пять файлов с флагом и телом", async () => {
		const vault = new FakeVault();
		const report = await createDemoVault(vault);
		expect(report.created).toEqual(DEMO_FILES.map((s) => s.path));
		expect(report.skipped).toEqual([]);
		for (const spec of DEMO_FILES) {
			// флаг контейнера проставлен
			const flag = Object.keys(spec.frontmatter).find((k) => k.startsWith("gtd-"))!;
			expect(vault.frontmatter.get(spec.path)?.[flag]).toBe(true);
			// тело содержит строки задач
			const content = vault.files.get(spec.path) ?? "";
			for (const line of demoTaskLines(spec)) expect(content).toContain(line);
		}
	});

	it("доска: frontmatter, записанный портом, парсится как валидная доска", async () => {
		const vault = new FakeVault();
		await createDemoVault(vault);
		const fm = vault.frontmatter.get(DEMO_BOARD.path)!;
		const def = parseBoardFrontmatter(fm);
		expect(isBoardError(def)).toBe(false);
	});

	it("идемпотентно: повторный запуск ничего не пересоздаёт", async () => {
		const vault = new FakeVault();
		await createDemoVault(vault);
		const before = new Map(vault.files);
		const report = await createDemoVault(vault);
		expect(report.created).toEqual([]);
		expect(report.skipped).toEqual(DEMO_FILES.map((s) => s.path));
		// содержимое не удвоилось
		for (const [path, content] of vault.files) expect(content).toBe(before.get(path));
	});

	it("не перезаписывает существующий непустой файл пользователя", async () => {
		const vault = new FakeVault();
		const userContent = "- [ ] моя личная задача, не трогать";
		vault.files.set(DEMO_INBOX.path, userContent);
		const report = await createDemoVault(vault);
		expect(vault.files.get(DEMO_INBOX.path)).toBe(userContent);
		expect(report.skipped).toContain(DEMO_INBOX.path);
		// остальные всё равно созданы
		expect(report.created).toContain(DEMO_BOARD.path);
		// чужой файл не помечен флагом входящих
		expect(vault.frontmatter.get(DEMO_INBOX.path)).toBeUndefined();
	});

	it("засевает файл, где есть только frontmatter без тела", async () => {
		const vault = new FakeVault();
		// имитируем ранее созданный пустой контейнер: frontmatter в теле, тела нет
		vault.files.set(DEMO_EVENTS.path, "---\ngtd-events: true\n---\n");
		const report = await createDemoVault(vault);
		expect(report.created).toContain(DEMO_EVENTS.path);
		expect(vault.files.get(DEMO_EVENTS.path)).toContain("Пример события");
	});
});

describe("demoVaultNotice", () => {
	it("сообщает о созданных и пропущенных", () => {
		expect(demoVaultNotice({ created: ["a", "b"], skipped: [] })).toContain("2");
		expect(demoVaultNotice({ created: ["a"], skipped: ["b", "c"] })).toContain("пропущено");
		expect(demoVaultNotice({ created: [], skipped: ["a"] })).toContain("уже существуют");
	});
});
