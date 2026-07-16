import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import {
	buildEventLine,
	buildSingleOccurrenceLine,
	createEventSeries,
	createSingleEvent,
	editEventLine,
	editEventSeries,
	excludeEventOccurrence,
	joinEventRule,
	splitEventRule,
	transferEventOccurrence,
	type EventVaultPort,
} from "./eventSeries";
import { preservedTimeEnd } from "./timeGrid";

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

describe("createSingleEvent — инлайн-создание одноразового события", () => {
	it("создаёт файл, ставит frontmatter gtd-events, пишет строку с временем-диапазоном", async () => {
		const vault = new FakeVault();
		const res = await createSingleEvent({
			vault,
			eventsFile: "Work/События.md",
			name: "Созвон",
			date: "2026-07-20",
			time: "14:30",
			timeEnd: "16:00",
		});
		expect(res.ok).toBe(true);
		expect(vault.frontmatter.get("Work/События.md")).toEqual({ "gtd-events": true });
		// формат — buildSingleOccurrenceLine без 🧬 (новое событие, не перенос)
		expect(vault.files.get("Work/События.md")).toBe("- [ ] Созвон 📅 2026-07-20 14:30-16:00\n");
	});

	it("без времени (месячная сетка) — событие «Весь день»", async () => {
		const vault = new FakeVault();
		const res = await createSingleEvent({
			vault,
			eventsFile: "GTD/События.md",
			name: "День рождения",
			date: "2026-07-21",
			time: null,
			timeEnd: null,
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/События.md")).toBe("- [ ] День рождения 📅 2026-07-21\n");
	});

	it("только начало без конца (клик по слоту) — «📅 <дата> HH:mm»", async () => {
		const vault = new FakeVault();
		const res = await createSingleEvent({
			vault,
			eventsFile: "GTD/События.md",
			name: "Встреча",
			date: "2026-07-20",
			time: "09:15",
			timeEnd: null,
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/События.md")).toBe("- [ ] Встреча 📅 2026-07-20 09:15\n");
	});

	it("строка события распознаётся парсером как одноразовое (📅, без 🔁)", async () => {
		const vault = new FakeVault();
		await createSingleEvent({
			vault,
			eventsFile: "GTD/События.md",
			name: "Событие",
			date: "2026-07-20",
			time: "10:00",
			timeEnd: "11:00",
		});
		const line = vault.files.get("GTD/События.md")!.trimEnd();
		const t = taskFrom(line, "GTD/События.md", 0);
		expect(t.due).toBe("2026-07-20");
		expect(t.dueTime).toBe("10:00");
		expect(t.dueTimeEnd).toBe("11:00");
		expect(t.recurrence).toBeNull();
	});

	it("добавляет строку к уже существующему файлу, не затирая его", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/События.md", "- [ ] Планёрка 🔁 every day at 10:00\n");
		const res = await createSingleEvent({
			vault,
			eventsFile: "GTD/События.md",
			name: "Разовое",
			date: "2026-07-22",
			time: null,
			timeEnd: null,
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/События.md")).toBe(
			"- [ ] Планёрка 🔁 every day at 10:00\n- [ ] Разовое 📅 2026-07-22\n",
		);
	});

	it("пустое имя — отказ без записи", async () => {
		const vault = new FakeVault();
		const res = await createSingleEvent({
			vault,
			eventsFile: "GTD/События.md",
			name: "   ",
			date: "2026-07-20",
			time: null,
			timeEnd: null,
		});
		expect(res).toEqual({ ok: false, reason: "empty-name" });
		expect(vault.files.has("GTD/События.md")).toBe(false);
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

describe("buildSingleOccurrenceLine", () => {
	it("строит строку одноразового переноса с временем и провенансом 🧬", () => {
		expect(buildSingleOccurrenceLine("  Тренировка  ", "2026-07-21", "18:00", "19:30", "ev1")).toBe(
			"- [ ] Тренировка 📅 2026-07-21 18:00-19:30 🧬 ev1",
		);
	});
	it("без времени/конца/провенанса — минимальная строка", () => {
		expect(buildSingleOccurrenceLine("Событие", "2026-07-21", null, null, null)).toBe(
			"- [ ] Событие 📅 2026-07-21",
		);
	});
	it("конец не строго позже начала — выпадает (как канон парсера)", () => {
		expect(buildSingleOccurrenceLine("X", "2026-07-21", "10:00", "10:00", null)).toBe(
			"- [ ] X 📅 2026-07-21 10:00",
		);
	});
	it("длительность сохраняется: preservedTimeEnd + новая строка", () => {
		// вхождение 19:00-20:30 (90 мин) переносится на старт 09:15 → конец 10:45
		const end = preservedTimeEnd("19:00", "20:30", "09:15");
		expect(buildSingleOccurrenceLine("Тр", "2026-07-22", "09:15", end ?? null, "ev1")).toBe(
			"- [ ] Тр 📅 2026-07-22 09:15-10:45 🧬 ev1",
		);
	});
	it("пустое имя — null", () => {
		expect(buildSingleOccurrenceLine("  ", "2026-07-21", null, null, null)).toBeNull();
	});
});

describe("excludeEventOccurrence — удаление вхождения серии", () => {
	it("добавляет 🚫 <date> к строке серии", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Тр 🔁 every tue at 19:00 🆔 ev1\n");
		const task = taskFrom("- [ ] Тр 🔁 every tue at 19:00 🆔 ev1", "GTD/Events.md", 0);
		const res = await excludeEventOccurrence({ vault, task, date: "2026-07-21" });
		expect(res.ok).toBe(true);
		// 🚫 добавляется в конец строки (как все сеттеры полей) — после 🆔
		expect(vault.files.get("GTD/Events.md")).toBe(
			"- [ ] Тр 🔁 every tue at 19:00 🆔 ev1 🚫 2026-07-21\n",
		);
	});
	it("повтор той же даты — успех без изменений (идемпотентно)", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Тр 🔁 every tue 🚫 2026-07-21 🆔 ev1\n");
		const task = taskFrom("- [ ] Тр 🔁 every tue 🚫 2026-07-21 🆔 ev1", "GTD/Events.md", 0);
		const res = await excludeEventOccurrence({ vault, task, date: "2026-07-21" });
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/Events.md")).toBe("- [ ] Тр 🔁 every tue 🚫 2026-07-21 🆔 ev1\n");
	});
	it("строку не найти — line-not-found", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Другое 🔁 every day 🆔 z\n");
		const task = taskFrom("- [ ] Тр 🔁 every tue 🆔 ev1", "GTD/Events.md", 0);
		const res = await excludeEventOccurrence({ vault, task, date: "2026-07-21" });
		expect(res).toEqual({ ok: false, reason: "line-not-found" });
	});
});

describe("transferEventOccurrence — перенос вхождения серии", () => {
	it("одна запись: 🚫 старой даты + append одноразовой строки с 🧬 серии", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Тр 🔁 every tue at 19:00-20:30 🆔 ev1\n");
		const task = taskFrom("- [ ] Тр 🔁 every tue at 19:00-20:30 🆔 ev1", "GTD/Events.md", 0);
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: "series",
			fromDate: "2026-07-21",
			toDate: "2026-07-22",
			time: "18:00",
			timeEnd: "19:30",
		});
		expect(res.ok).toBe(true);
		// 🚫 в конце строки серии (после 🆔); одноразовая строка — следующей
		expect(vault.files.get("GTD/Events.md")).toBe(
			"- [ ] Тр 🔁 every tue at 19:00-20:30 🆔 ev1 🚫 2026-07-21\n" +
				"- [ ] Тр 📅 2026-07-22 18:00-19:30 🧬 ev1\n",
		);
	});

	it("серия без 🆔 — ленивое проставление тем же processFile", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Тр 🔁 every tue at 19:00\n");
		const task = taskFrom("- [ ] Тр 🔁 every tue at 19:00", "GTD/Events.md", 0);
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: "series",
			fromDate: "2026-07-21",
			toDate: "2026-07-22",
			time: "18:00",
			timeEnd: null,
			genId: () => "newid",
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/Events.md")).toBe(
			"- [ ] Тр 🔁 every tue at 19:00 🚫 2026-07-21 🆔 newid\n" +
				"- [ ] Тр 📅 2026-07-22 18:00 🧬 newid\n",
		);
	});

	it("строку не найти — line-not-found, без записи", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Другое 🔁 every day 🆔 z\n");
		const task = taskFrom("- [ ] Тр 🔁 every tue 🆔 ev1", "GTD/Events.md", 0);
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: "series",
			fromDate: "2026-07-21",
			toDate: "2026-07-22",
			time: "18:00",
			timeEnd: null,
		});
		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(vault.files.get("GTD/Events.md")).toBe("- [ ] Другое 🔁 every day 🆔 z\n");
	});
});

describe("transferEventOccurrence — перенос одноразового", () => {
	it("правит собственную 📅/время строки одной записью", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Событие 📅 2026-07-21 18:00-19:30 🧬 ev1\n");
		const task = taskFrom("- [ ] Событие 📅 2026-07-21 18:00-19:30 🧬 ev1", "GTD/Events.md", 0);
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: "single",
			fromDate: "2026-07-21",
			toDate: "2026-07-25",
			time: "20:00",
			timeEnd: "21:30",
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/Events.md")).toBe(
			"- [ ] Событие 📅 2026-07-25 20:00-21:30 🧬 ev1\n",
		);
	});

	it("снятие времени: перенос одноразового на дату без времени", async () => {
		const vault = new FakeVault();
		vault.files.set("GTD/Events.md", "- [ ] Событие 📅 2026-07-21 18:00 🧬 ev1\n");
		const task = taskFrom("- [ ] Событие 📅 2026-07-21 18:00 🧬 ev1", "GTD/Events.md", 0);
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: "single",
			fromDate: "2026-07-21",
			toDate: "2026-07-25",
			time: null,
			timeEnd: null,
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/Events.md")).toBe("- [ ] Событие 📅 2026-07-25 🧬 ev1\n");
	});
});
