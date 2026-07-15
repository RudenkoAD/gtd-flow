import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import {
	buildEventLine,
	createEventSeries,
	editEventLine,
	editEventSeries,
	joinEventRule,
	splitEventRule,
	type EventVaultPort,
} from "./eventSeries";

// ---------------------------------------------------------------------------
// Фейковый порт файла: карта путь → содержимое + frontmatter
// ---------------------------------------------------------------------------

class FakeVault implements EventVaultPort {
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
		if (next !== null) this.files.set(path, next);
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

/** Разобрать строку файла событий в Task (container events). */
function taskFrom(rawLine: string, filePath: string, lineStart: number): Task {
	const t = parseTaskLine(rawLine, {
		filePath,
		lineStart,
		parentLine: null,
		heading: null,
		container: "events",
		projectActive: true,
	});
	if (t === null) throw new Error(`не задача: ${rawLine}`);
	return t;
}

describe("buildEventLine", () => {
	it("строит строку серии; схлопывает пробелы", () => {
		expect(buildEventLine("  Тренировка  зала ", "every tuesday at 19:00")).toBe(
			"- [ ] Тренировка зала 🔁 every tuesday at 19:00",
		);
	});
	it("пустое имя — null", () => {
		expect(buildEventLine("   ", "every day")).toBeNull();
	});
});

describe("editEventLine — атомарная правка названия + правила", () => {
	it("меняет и описание, и payload 🔁 одной строкой", () => {
		const line = "- [ ] Старое 🔁 every day 🆔 ev1";
		const out = editEventLine(line, "Новое", "every tuesday at 19:00");
		expect(out).toBe("- [ ] Новое 🔁 every tuesday at 19:00 🆔 ev1");
	});
	it("сохраняет 🆔 и порядок полей", () => {
		const line = "- [ ] A 🔁 every day 🆔 xyz";
		const parsed = parseTaskLine(editEventLine(line, "B", "every week on mon")!, {
			filePath: "e.md",
			lineStart: 0,
			parentLine: null,
			heading: null,
			container: "events",
			projectActive: true,
		})!;
		expect(parsed.description).toBe("B");
		expect(parsed.taskId).toBe("xyz");
		expect(parsed.recurrence).toBe("every week on mon");
	});
	it("название с эмодзи поля — null (недопустимо)", () => {
		expect(editEventLine("- [ ] A 🔁 every day", "B 📅 x", "every day")).toBeNull();
	});
});

describe("splitEventRule / joinEventRule", () => {
	it("отщепляет и собирает хвост времени", () => {
		expect(splitEventRule("every tuesday at 19:00-20:30")).toEqual({
			rule: "every tuesday",
			time: "19:00-20:30",
		});
		expect(splitEventRule("every day")).toEqual({ rule: "every day", time: "" });
		expect(joinEventRule("every day", "09:00")).toBe("every day at 09:00");
		expect(joinEventRule("every day", "")).toBe("every day");
	});
	it("round-trip split→join", () => {
		const full = "every 2 weeks on mon, thu at 08:15";
		const { rule, time } = splitEventRule(full);
		expect(joinEventRule(rule, time)).toBe(full);
	});
});

describe("createEventSeries", () => {
	it("создаёт файл, ставит frontmatter gtd-events, добавляет строку", async () => {
		const vault = new FakeVault();
		const res = await createEventSeries({
			vault,
			eventsFile: "GTD/Events.md",
			name: "Планёрка",
			ruleText: "every day at 10:00",
		});
		expect(res.ok).toBe(true);
		expect(vault.frontmatter.get("GTD/Events.md")).toEqual({ "gtd-events": true });
		expect(vault.files.get("GTD/Events.md")).toBe("- [ ] Планёрка 🔁 every day at 10:00\n");
	});

	it("невалидное правило — отказ без записи", async () => {
		const vault = new FakeVault();
		const res = await createEventSeries({
			vault,
			eventsFile: "GTD/Events.md",
			name: "X",
			ruleText: "каждый день",
		});
		expect(res).toEqual({ ok: false, reason: "invalid-rule" });
		expect(vault.files.has("GTD/Events.md")).toBe(false);
	});

	it("пустое имя — отказ", async () => {
		const vault = new FakeVault();
		const res = await createEventSeries({
			vault,
			eventsFile: "GTD/Events.md",
			name: "  ",
			ruleText: "every day",
		});
		expect(res).toEqual({ ok: false, reason: "empty-name" });
	});
});

describe("editEventSeries", () => {
	it("локализует строку серии и переписывает её атомарно", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Старое 🔁 every day 🆔 ev1\n");
		const task = taskFrom("- [ ] Старое 🔁 every day 🆔 ev1", "GTD/Events.md", 0);
		const res = await editEventSeries({
			vault,
			task,
			name: "Новое",
			ruleText: "every tuesday at 19:00",
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/Events.md")).toBe(
			"- [ ] Новое 🔁 every tuesday at 19:00 🆔 ev1\n",
		);
	});

	it("строку не найти — line-not-found, без записи", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Другое 🔁 every day 🆔 zzz\n");
		const task = taskFrom("- [ ] Старое 🔁 every day 🆔 ev1", "GTD/Events.md", 0);
		const res = await editEventSeries({ vault, task, name: "N", ruleText: "every day" });
		expect(res).toEqual({ ok: false, reason: "line-not-found" });
	});

	it("невалидное правило — отказ без записи", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] A 🔁 every day 🆔 ev1\n");
		const task = taskFrom("- [ ] A 🔁 every day 🆔 ev1", "GTD/Events.md", 0);
		const res = await editEventSeries({ vault, task, name: "A", ruleText: "мусор" });
		expect(res).toEqual({ ok: false, reason: "invalid-rule" });
		expect(vault.files.get("GTD/Events.md")).toBe("- [ ] A 🔁 every day 🆔 ev1\n");
	});
});
