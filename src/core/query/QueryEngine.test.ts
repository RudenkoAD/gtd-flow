import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import { evaluate, isInTickler, type QueryContext } from "./QueryEngine";
import { defaultInboxConfig } from "./querySpec";

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
		dueTimeEnd: null,
		scheduledTimeEnd: null,
		startTimeEnd: null,
		recurrence: null,
		nextSpawn: null,
		spawnedFrom: null,
		priority: "none",
		dependsOn: [],
		excludedDates: [],
		location: null,
		durationMinutes: null,
		cognitiveIntensity: null,
		emotionalIntensity: null,
		physicalIntensity: null,
		scopeId: null,
		tags: [],
		container: "plain",
		projectActive: true,
		...overrides,
	};
}

function ctxOf(tasks: Task[]): QueryContext {
	// Новый дефолт скоупа входящих: includePlain === false — обычные заметки исключены.
	return {
		tasks,
		today: TODAY,
		resolveDep: (id) => tasks.filter((t) => t.taskId === id),
		settingsBits: defaultInboxConfig(),
	};
}

/** Контекст со включённым plain-скоупом (inboxIncludePlain === true) — старое поведение. */
function ctxOfInclude(tasks: Task[]): QueryContext {
	return { ...ctxOf(tasks), settingsBits: defaultInboxConfig(true) };
}

function inboxKeys(tasks: Task[]): string[] {
	return evaluate({ kind: "inbox" }, ctxOf(tasks)).map((t) => t.key);
}

function inboxKeysInclude(tasks: Task[]): string[] {
	return evaluate({ kind: "inbox" }, ctxOfInclude(tasks)).map((t) => t.key);
}

describe("inbox — формула §1 (скоуп входящих: по умолчанию только файлы GTD Flow)", () => {
	it("захвачено и не разобрано (container inbox, без тега доски, проекта и due) — во входящих", () => {
		const t = makeTask({ filePath: "GTD/Inbox.md", container: "inbox" });
		expect(inboxKeys([t])).toEqual([t.key]);
	});

	it("только configured inbox принимает container=inbox; legacy markers do not leak", () => {
		const configured = makeTask({ filePath: "Capture.md", container: "inbox" });
		const legacy = makeTask({ filePath: "GTD/Legacy Inbox.md", container: "inbox" });
		const context: QueryContext = {
			...ctxOf([configured, legacy]),
			settingsBits: defaultInboxConfig(false, "Capture.md"),
		};
		expect(evaluate({ kind: "inbox" }, context).map((task) => task.key)).toEqual([
			configured.key,
		]);
	});

	it("hasDue исключает", () => {
		const t = makeTask({ container: "inbox", due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("hasDue исключает и в файле-захвате: задача с 📅 в GTD/Inbox.md — НЕ во входящих", () => {
		// force-include упразднён: планирование задачи прямо в Inbox.md — это разбор
		const t = makeTask({ filePath: "GTD/Inbox.md", container: "inbox", due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("тег доски исключает", () => {
		const t = makeTask({ container: "inbox", tags: ["#kanban/work/todo"] });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("container board (status-доска) исключает даже без тегов и due", () => {
		// задача в файле gtd-board: true с group-by: status — разобрана по колонке,
		// во входящие попадать не должна (регресс: двойное присутствие доска+inbox)
		const t = makeTask({ filePath: "Boards/dev.md", container: "board" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("container board в GTD/Inbox.md — не во входящих (разобранное — не во входящих)", () => {
		const t = makeTask({ filePath: "GTD/Inbox.md", container: "board" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("регрессия живого теста: drag на доску прямо из Inbox.md убирает из входящих", () => {
		// Карточка получила #kanban/... прямо в Inbox.md — разобрана (!hasBoardTag).
		const t = makeTask({
			filePath: "GTD/Inbox.md",
			container: "inbox",
			tags: ["#kanban/work/doing"],
		});
		expect(inboxKeys([t])).toEqual([]);
	});

	it("проект отдал готовую задачу", () => {
		const done = makeTask({ taskId: "a1", statusChar: "x", container: "project" });
		const t = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(inboxKeys([done, t])).toEqual([t.key]);
	});

	it("projectActive=false исключает (on-hold/архив)", () => {
		const t = makeTask({ container: "project", projectActive: false });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("не ready (невыполненная ⛔) исключает", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " ", container: "project" });
		const t = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(inboxKeys([dep, t])).toEqual([dep.key]); // сам dep — корень без ⛔, он ready
	});

	it("тег доски исключает даже готовую задачу проекта", () => {
		const t = makeTask({ container: "project", tags: ["#kanban/work/todo"] });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("hasDue глобален: готовая задача проекта с 📅 — не во входящих", () => {
		const t = makeTask({ container: "project", due: "2026-07-20" });
		expect(inboxKeys([t])).toEqual([]);
	});

	it("неактивные (done/отложенные/шаблоны) — не во входящих даже в файле захвата", () => {
		const done = makeTask({ filePath: "GTD/Inbox.md", container: "inbox", statusChar: "x" });
		const deferred = makeTask({
			filePath: "GTD/Inbox.md",
			container: "inbox",
			start: "2026-08-01",
		});
		const template = makeTask({ filePath: "GTD/Inbox.md", container: "recurring" });
		expect(inboxKeys([done, deferred, template])).toEqual([]);
	});

	it("container inbox: активная задача файла захвата — во входящих (при любом скоупе)", () => {
		// gtd-inbox помечает файл захвата: его задачи во входящих всегда, независимо
		// от inboxIncludePlain (скоуп ограничивает только обычные заметки).
		const captured = makeTask({ filePath: "GTD/Inbox.md", container: "inbox" });
		expect(inboxKeys([captured])).toEqual([captured.key]);
		expect(inboxKeysInclude([captured])).toEqual([captured.key]);
	});

	it("container inbox: те же исключения, что у plain (due/тег доски разбирают задачу)", () => {
		const withDue = makeTask({ container: "inbox", due: "2026-07-20" });
		const withBoardTag = makeTask({ container: "inbox", tags: ["#kanban/work/todo"] });
		expect(inboxKeys([withDue, withBoardTag])).toEqual([]);
	});

	it("container archive исключён из входящих (полная инертность)", () => {
		const archived = makeTask({ filePath: "GTD/Archive.md", container: "archive" });
		// даже снятая галочка в архиве не возвращает задачу во входящие
		expect(inboxKeys([archived])).toEqual([]);
	});
});

describe("inbox — скоуп входящих (настройка inboxIncludePlain)", () => {
	it("plain-задача обычной заметки: НЕ во входящих при false, ВО входящих при true", () => {
		// причина настройки: на реальном vault сотни чек-листов в обычных заметках
		// затапливали входящие. По умолчанию (false) они исключены.
		const plain = makeTask({ filePath: "Заметки/дела.md", container: "plain" });
		expect(inboxKeys([plain])).toEqual([]); // default false
		expect(inboxKeysInclude([plain])).toEqual([plain.key]); // includePlain=true — старое поведение
	});

	it("plain-задача с due/тегом доски исключена в ОБОИХ режимах (скоуп не переопределяет разбор)", () => {
		const withDue = makeTask({ container: "plain", due: "2026-07-20" });
		const onBoard = makeTask({ container: "plain", tags: ["#kanban/work/todo"] });
		expect(inboxKeysInclude([withDue, onBoard])).toEqual([]);
		expect(inboxKeys([withDue, onBoard])).toEqual([]);
	});

	it("захват (container inbox) — во входящих в ОБОИХ режимах", () => {
		const captured = makeTask({ filePath: "GTD/Inbox.md", container: "inbox" });
		expect(inboxKeys([captured])).toEqual([captured.key]);
		expect(inboxKeysInclude([captured])).toEqual([captured.key]);
	});

	it("готовая задача проекта — во входящих в ОБОИХ режимах (проект не зависит от скоупа plain)", () => {
		const ready = makeTask({ container: "project" });
		expect(inboxKeys([ready])).toEqual([ready.key]);
		expect(inboxKeysInclude([ready])).toEqual([ready.key]);
	});

	it("не-готовая задача проекта — не во входящих в ОБОИХ режимах", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " ", container: "project" });
		const blocked = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(inboxKeys([dep, blocked])).toEqual([dep.key]);
		expect(inboxKeysInclude([dep, blocked])).toEqual([dep.key]);
	});
});

describe("inbox — сортировка", () => {
	it("приоритет по убыванию, затем created по возрастанию (null в конец)", () => {
		// все из файла захвата (container inbox), без даты/тегов/проекта — все проходят фильтр
		const plain = makeTask({ filePath: "GTD/Inbox.md", container: "inbox", priority: "none" });
		const top = makeTask({ filePath: "GTD/Inbox.md", container: "inbox", priority: "highest" });
		const highLate = makeTask({
			filePath: "GTD/Inbox.md",
			container: "inbox",
			priority: "high",
			created: "2026-07-05",
		});
		const highEarly = makeTask({
			filePath: "GTD/Inbox.md",
			container: "inbox",
			priority: "high",
			created: "2026-07-01",
		});
		const highNoCreated = makeTask({
			filePath: "GTD/Inbox.md",
			container: "inbox",
			priority: "high",
		});
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

	it("TEMPLATE/DETAIL/EVENT/ARCHIVED не протекают в тикль (цепочка §1 выше TICKLER)", () => {
		const template = makeTask({ container: "recurring", start: "2026-08-01" });
		const detail = makeTask({ container: "card", start: "2026-08-01" });
		const event = makeTask({ container: "events", start: "2026-08-01" });
		const archived = makeTask({ container: "archive", start: "2026-08-01" });
		expect(isInTickler(template, TODAY)).toBe(false);
		expect(isInTickler(detail, TODAY)).toBe(false);
		expect(isInTickler(event, TODAY)).toBe(false);
		expect(isInTickler(archived, TODAY)).toBe(false);
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

	it("архив (container archive) не протекает ни в один запрос, включая calendar-range", () => {
		// зачёркнутая заархивированная задача с датой раньше мелькала в календаре —
		// теперь архив полностью инертен и исключён отовсюду
		const doneWithDue = makeTask({ container: "archive", statusChar: "x", due: "2026-07-20" });
		const undoneWithDue = makeTask({
			container: "archive",
			statusChar: " ",
			due: "2026-07-21",
		});
		const deferred = makeTask({ container: "archive", start: "2026-07-25" });
		const all = [doneWithDue, undoneWithDue, deferred];
		expect(inboxKeys(all)).toEqual([]);
		expect(evaluate({ kind: "tickler" }, ctxOf(all))).toEqual([]);
		expect(evaluate({ kind: "active" }, ctxOf(all))).toEqual([]);
		expect(
			evaluate(
				{
					kind: "calendar-range",
					fromIso: "2026-07-01",
					toIso: "2026-07-31",
					placement: ["due", "scheduled", "start"],
				},
				ctxOf(all),
			),
		).toEqual([]);
	});

	it("события (container events) не протекают ни в один запрос", () => {
		// событие несёт 🔁-правило; в календарь оно попадает ТОЛЬКО как виртуальное
		// вхождение (expandOccurrences), но как задача — нигде не видно
		const event = makeTask({ container: "events", recurrence: "every day at 09:00" });
		// даже с датой (искусственно) в календарь-диапазон не протекает
		const eventWithDue = makeTask({ container: "events", due: "2026-07-20" });
		const all = [event, eventWithDue];
		expect(inboxKeys(all)).toEqual([]);
		expect(evaluate({ kind: "tickler" }, ctxOf(all))).toEqual([]);
		expect(evaluate({ kind: "active" }, ctxOf(all))).toEqual([]);
		expect(
			evaluate(
				{
					kind: "calendar-range",
					fromIso: "2026-07-01",
					toIso: "2026-07-31",
					placement: ["due", "scheduled", "start"],
				},
				ctxOf(all),
			),
		).toEqual([]);
	});

	it("calendar-range: placement решает, какое поле размещает задачу", () => {
		const t = makeTask({ due: "2026-08-15", scheduled: "2026-07-10" });
		// по due — вне диапазона; по scheduled — внутри
		const byDue = evaluate(
			{
				kind: "calendar-range",
				fromIso: "2026-07-01",
				toIso: "2026-07-31",
				placement: ["due"],
			},
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
