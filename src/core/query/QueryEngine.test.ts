import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import { evaluate, isInTickler, type QueryContext } from "./QueryEngine";
import { defaultInboxConfig, matchesInboxSource } from "./querySpec";

const TODAY = "2026-07-15";

let seq = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
	seq += 1;
	return {
		key: `k${seq}`,
		taskId: null,
		filePath: "Notes/misc.md",
		lineStart: seq,
		lineEnd: seq,
		parentLine: null,
		heading: null,
		description: "тестовая задача",
		rawLine: "- [ ] тестовая задача",
		statusChar: " ",
		due: null,
		scheduled: null,
		start: null,
		created: null,
		done: null,
		cancelled: null,
		dueTime: null,
		scheduledTime: null,
		startTime: null,
		recurrence: null,
		nextSpawn: null,
		spawnedFrom: null,
		priority: "none",
		dependsOn: [],
		tags: [],
		container: "plain",
		projectActive: true,
		...overrides,
	};
}

function ctxOf(tasks: Task[], sources: string[] = ["GTD/Inbox.md", "GTD/Capture/"]): QueryContext {
	return {
		tasks,
		today: TODAY,
		resolveDep: (id) => tasks.filter((t) => t.taskId === id),
		settingsBits: defaultInboxConfig(sources),
	};
}

function inboxKeys(tasks: Task[]): string[] {
	return evaluate({ kind: "inbox" }, ctxOf(tasks)).map((t) => t.key);
}

describe("matchesInboxSource", () => {
	it("точный файл", () => {
		expect(matchesInboxSource("GTD/Inbox.md", ["GTD/Inbox.md"])).toBe(true);
		expect(matchesInboxSource("GTD/Inbox.md.bak", ["GTD/Inbox.md"])).toBe(false);
	});

	it("папка с завершающим слэшем и без", () => {
		expect(matchesInboxSource("GTD/Capture/phone.md", ["GTD/Capture/"])).toBe(true);
		expect(matchesInboxSource("GTD/Capture/phone.md", ["GTD/Capture"])).toBe(true);
	});

	it("префикс только по границе сегмента", () => {
		expect(matchesInboxSource("GTD/CaptureX.md", ["GTD/Capture"])).toBe(false);
		expect(matchesInboxSource("GTD/Inbox.md", ["GTD/In"])).toBe(false);
	});
});

describe("inbox — три ветки §1", () => {
	it("ветка 2: захвачено и не разобрано (без тега доски, проекта и due)", () => {
		const t = makeTask();
		expect(inboxKeys([t])).toEqual([t.key]);
	});

	it("ветка 2: hasDue исключает", () => {
		const t = makeTask({ due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 2: тег доски исключает", () => {
		const t = makeTask({ tags: ["#kanban/work/todo"] });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 2: container board (status-доска) исключает даже без тегов и due", () => {
		// задача в файле gtd-board: true с group-by: status — разобрана по колонке,
		// во входящие попадать не должна (регресс: двойное присутствие доска+inbox)
		const t = makeTask({ filePath: "Boards/dev.md", container: "board" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 1: force-include НЕ спасает container board (разобранное — не во входящих)", () => {
		const t = makeTask({ filePath: "GTD/Inbox.md", container: "board" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 3: проект отдал готовую задачу", () => {
		const done = makeTask({ taskId: "a1", statusChar: "x", container: "project" });
		const t = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(inboxKeys([done, t])).toEqual([t.key]);
	});

	it("ветка 3: projectActive=false исключает (on-hold/архив)", () => {
		const t = makeTask({ container: "project", projectActive: false });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 3: не ready (невыполненная ⛔) исключает", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " ", container: "project" });
		const t = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(inboxKeys([dep, t])).toEqual([dep.key]); // сам dep — корень без ⛔, он ready
	});

	it("ветка 3: тег доски исключает даже готовую задачу проекта", () => {
		const t = makeTask({ container: "project", tags: ["#kanban/work/todo"] });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 1: файл-источник force-include (несмотря на due)", () => {
		const t = makeTask({ filePath: "GTD/Inbox.md", due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([t.key]);
	});

	it("ветка 1 (регрессия живого теста): drag на доску из файла-источника убирает из входящих", () => {
		// Карточка получила #kanban/... прямо в Inbox.md — разобрана, force-include уступает.
		const t = makeTask({ filePath: "GTD/Inbox.md", tags: ["#kanban/work/doing"] });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("ветка 1: папка-источник force-include", () => {
		const t = makeTask({ filePath: "GTD/Capture/phone.md", due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([t.key]);
	});

	it("ветка 1: НЕ спасает неактивные (done/отложенные/шаблоны)", () => {
		const done = makeTask({ filePath: "GTD/Inbox.md", statusChar: "x" });
		const deferred = makeTask({ filePath: "GTD/Inbox.md", start: "2026-08-01" });
		const template = makeTask({ filePath: "GTD/Inbox.md", container: "recurring" });
		expect(inboxKeys([done, deferred, template])).toEqual([]);
	});

	it("похожий путь — не источник: GTD/CaptureX.md с due не во входящих", () => {
		const t = makeTask({ filePath: "GTD/CaptureX.md", due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([]);
	});
});

describe("inbox — сортировка", () => {
	it("приоритет по убыванию, затем created по возрастанию (null в конец)", () => {
		// все в файле-источнике, чтобы все прошли фильтр
		const plain = makeTask({ filePath: "GTD/Inbox.md", priority: "none" });
		const top = makeTask({ filePath: "GTD/Inbox.md", priority: "highest" });
		const highLate = makeTask({
			filePath: "GTD/Inbox.md",
			priority: "high",
			created: "2026-07-05",
		});
		const highEarly = makeTask({
			filePath: "GTD/Inbox.md",
			priority: "high",
			created: "2026-07-01",
		});
		const highNoCreated = makeTask({ filePath: "GTD/Inbox.md", priority: "high" });
		expect(inboxKeys([plain, top, highLate, highEarly, highNoCreated])).toEqual([
			top.key,
			highEarly.key,
			highLate.key,
			highNoCreated.key,
			plain.key,
		]);
	});
});

describe("tickler", () => {
	it("start > today — в тикле; start == today — уже НЕТ (граница)", () => {
		const future = makeTask({ start: "2026-07-16" });
		const today = makeTask({ start: TODAY });
		const past = makeTask({ start: "2026-07-14" });
		const keys = evaluate({ kind: "tickler" }, ctxOf([future, today, past])).map((t) => t.key);
		expect(keys).toEqual([future.key]);
	});

	it("done/cancelled с будущим start — не в тикле", () => {
		const done = makeTask({ start: "2026-08-01", statusChar: "x" });
		const cancelled = makeTask({ start: "2026-08-01", statusChar: "-" });
		expect(evaluate({ kind: "tickler" }, ctxOf([done, cancelled]))).toEqual([]);
	});

	it("TEMPLATE/DETAIL не протекают в тикль (цепочка §1 выше TICKLER)", () => {
		const template = makeTask({ container: "recurring", start: "2026-08-01" });
		const detail = makeTask({ container: "card", start: "2026-08-01" });
		expect(isInTickler(template, TODAY)).toBe(false);
		expect(isInTickler(detail, TODAY)).toBe(false);
	});

	it("сортировка по start по возрастанию", () => {
		const b = makeTask({ start: "2026-08-01" });
		const a = makeTask({ start: "2026-07-20" });
		const c = makeTask({ start: "2026-09-01" });
		const keys = evaluate({ kind: "tickler" }, ctxOf([b, a, c])).map((t) => t.key);
		expect(keys).toEqual([a.key, b.key, c.key]);
	});
});

describe("остальные запросы", () => {
	it("active: исключает done/отложенные/шаблоны/карточки, включает waiting и doing", () => {
		const plain = makeTask({ lineStart: 1 });
		const doing = makeTask({ statusChar: "/", lineStart: 2 });
		const waiting = makeTask({ tags: ["#waiting"], lineStart: 3 });
		const done = makeTask({ statusChar: "x" });
		const deferred = makeTask({ start: "2026-08-01" });
		const template = makeTask({ container: "recurring" });
		const detail = makeTask({ container: "card" });
		const keys = evaluate(
			{ kind: "active" },
			ctxOf([plain, doing, waiting, done, deferred, template, detail]),
		).map((t) => t.key);
		expect(keys).toEqual([plain.key, doing.key, waiting.key]);
	});

	it("all-templates: только container recurring, независимо от статуса", () => {
		const t1 = makeTask({ container: "recurring", statusChar: "-", lineStart: 1 });
		const t2 = makeTask({ container: "recurring", lineStart: 2 });
		const other = makeTask();
		const keys = evaluate({ kind: "all-templates" }, ctxOf([other, t2, t1])).map((t) => t.key);
		expect(keys).toEqual([t1.key, t2.key]);
	});

	it("project-members: задачи файла проекта по порядку строк, включая done", () => {
		const p = "Projects/Кухня.md";
		const a = makeTask({ filePath: p, container: "project", lineStart: 5, statusChar: "x" });
		const b = makeTask({ filePath: p, container: "project", lineStart: 3 });
		const other = makeTask();
		const keys = evaluate({ kind: "project-members", path: p }, ctxOf([a, other, b])).map(
			(t) => t.key,
		);
		expect(keys).toEqual([b.key, a.key]);
	});

	it("calendar-range: фильтр диапазона (включительно), приоритет полей, сортировка по дате", () => {
		const inDue = makeTask({ due: "2026-07-20" });
		const boundary = makeTask({ due: "2026-07-31" });
		const out = makeTask({ due: "2026-08-01" });
		const bySched = makeTask({ scheduled: "2026-07-10" });
		const noDates = makeTask();
		const template = makeTask({ container: "recurring", due: "2026-07-20" });
		const keys = evaluate(
			{
				kind: "calendar-range",
				fromIso: "2026-07-01",
				toIso: "2026-07-31",
				placement: ["due", "scheduled", "start"],
			},
			ctxOf([inDue, boundary, out, bySched, noDates, template]),
		).map((t) => t.key);
		expect(keys).toEqual([bySched.key, inDue.key, boundary.key]);
	});

	it("calendar-range: placement решает, какое поле размещает задачу", () => {
		const t = makeTask({ due: "2026-08-15", scheduled: "2026-07-10" });
		// по due — вне диапазона; по scheduled — внутри
		const byDue = evaluate(
			{ kind: "calendar-range", fromIso: "2026-07-01", toIso: "2026-07-31", placement: ["due"] },
			ctxOf([t]),
		);
		const bySched = evaluate(
			{
				kind: "calendar-range",
				fromIso: "2026-07-01",
				toIso: "2026-07-31",
				placement: ["scheduled"],
			},
			ctxOf([t]),
		);
		expect(byDue).toEqual([]);
		expect(bySched.map((x) => x.key)).toEqual([t.key]);
	});
});
