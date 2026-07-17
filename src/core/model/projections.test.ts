import { describe, expect, it } from "vitest";
import type { Task } from "./Task";
import {
	taskToBoardCard,
	taskToCalendarEvent,
	taskToInboxItem,
	type CalendarField,
	type MinimalColumnSpec,
} from "./projections";

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
		tags: [],
		container: "plain",
		projectActive: true,
		...overrides,
	};
}

const DEFAULT_PLACEMENT: CalendarField[] = ["due", "scheduled", "start"];

describe("taskToCalendarEvent — приоритет полей placement", () => {
	it("due побеждает scheduled и start при дефолтном placement", () => {
		const t = makeTask({ due: "2026-07-20", scheduled: "2026-07-18", start: "2026-07-16" });
		expect(taskToCalendarEvent(t, DEFAULT_PLACEMENT)).toEqual({
			date: "2026-07-20",
			field: "due",
		});
	});

	it("без due падает на scheduled", () => {
		const t = makeTask({ scheduled: "2026-07-18", start: "2026-07-16" });
		expect(taskToCalendarEvent(t, DEFAULT_PLACEMENT)).toEqual({
			date: "2026-07-18",
			field: "scheduled",
		});
	});

	it("только start", () => {
		const t = makeTask({ start: "2026-07-16" });
		expect(taskToCalendarEvent(t, DEFAULT_PLACEMENT)).toEqual({
			date: "2026-07-16",
			field: "start",
		});
	});

	it("нет ни одного поля — null", () => {
		expect(taskToCalendarEvent(makeTask(), DEFAULT_PLACEMENT)).toBeNull();
	});

	it("кастомный порядок placement меняет выбор", () => {
		const t = makeTask({ due: "2026-07-20", scheduled: "2026-07-18" });
		expect(taskToCalendarEvent(t, ["scheduled", "due"])).toEqual({
			date: "2026-07-18",
			field: "scheduled",
		});
	});

	it("пустой placement — null", () => {
		expect(taskToCalendarEvent(makeTask({ due: "2026-07-20" }), [])).toBeNull();
	});
});

describe("taskToInboxItem", () => {
	it("переносит поля и помечает задачи проектов", () => {
		const t = makeTask({
			taskId: "a1",
			description: "Собрать сметы",
			priority: "high",
			due: "2026-07-20",
			tags: ["#next"],
			container: "project",
			heading: "Кухня",
		});
		const item = taskToInboxItem(t);
		expect(item.key).toBe(t.key);
		expect(item.taskId).toBe("a1");
		expect(item.description).toBe("Собрать сметы");
		expect(item.priority).toBe("high");
		expect(item.due).toBe("2026-07-20");
		expect(item.heading).toBe("Кухня");
		expect(item.fromProject).toBe(true);
	});

	it("копирует tags (не делит массив с Task)", () => {
		const t = makeTask({ tags: ["#a"] });
		const item = taskToInboxItem(t);
		item.tags.push("#b");
		expect(t.tags).toEqual(["#a"]);
	});

	it("fromProject=false вне проекта", () => {
		expect(taskToInboxItem(makeTask()).fromProject).toBe(false);
	});
});

describe("taskToBoardCard", () => {
	const columns: MinimalColumnSpec[] = [
		{ id: "todo", match: { kind: "tag", tag: "#kanban/work/todo" } },
		{ id: "doing", match: { kind: "status", statusChar: "/" } },
	];

	it("колонка по тегу", () => {
		const t = makeTask({ tags: ["#kanban/work/todo"] });
		expect(taskToBoardCard(t, columns).columnId).toBe("todo");
	});

	it("колонка по статусу", () => {
		const t = makeTask({ statusChar: "/" });
		expect(taskToBoardCard(t, columns).columnId).toBe("doing");
	});

	it("первая подошедшая колонка побеждает", () => {
		const t = makeTask({ tags: ["#kanban/work/todo"], statusChar: "/" });
		expect(taskToBoardCard(t, columns).columnId).toBe("todo");
	});

	it("нет совпадения — columnId null", () => {
		expect(taskToBoardCard(makeTask(), columns).columnId).toBeNull();
	});

	// регресс: семантика tag-матча обязана совпадать с board/membership.matchesSpec
	it("tag-спека без '#' (форма boardFile.parseMatchSpec) матчит '#'-тег задачи", () => {
		const cols: MinimalColumnSpec[] = [{ id: "todo", match: { kind: "tag", tag: "kanban/dev/todo" } }];
		const t = makeTask({ tags: ["#kanban/dev/todo"] });
		expect(taskToBoardCard(t, cols).columnId).toBe("todo");
	});

	it("вложенный тег задачи — член колонки родительского тега (как в membership)", () => {
		const cols: MinimalColumnSpec[] = [{ id: "todo", match: { kind: "tag", tag: "#kanban/dev/todo" } }];
		const t = makeTask({ tags: ["#kanban/dev/todo/urgent"] });
		expect(taskToBoardCard(t, cols).columnId).toBe("todo");
	});

	it("сосед по префиксу без границы сегмента — НЕ член колонки", () => {
		const cols: MinimalColumnSpec[] = [{ id: "todo", match: { kind: "tag", tag: "kanban/dev/todo" } }];
		const t = makeTask({ tags: ["#kanban/dev/todoX"] });
		expect(taskToBoardCard(t, cols).columnId).toBeNull();
	});
});
