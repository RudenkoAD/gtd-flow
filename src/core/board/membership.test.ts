import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import type { BoardDef } from "./boardFile";
import { resolveColumn } from "./membership";

function makeTask(over: Partial<Task> & { key: string }): Task {
	return {
		taskId: null,
		filePath: "inbox.md",
		lineStart: 0,
		lineEnd: 0,
		parentLine: null,
		heading: null,
		description: "task",
		rawLine: "- [ ] task",
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
		tags: [],
		container: "plain",
		projectActive: true,
		...over,
	};
}

function board(columns: BoardDef["columns"]): BoardDef {
	return { id: "b", name: "b", groupBy: "tag", columns, order: {} };
}

const tagBoard = board([
	{ id: "todo", name: "todo", match: "#kanban/b/todo" },
	{ id: "doing", name: "doing", match: "#kanban/b/doing" },
]);

const statusBoard = board([
	{ id: "done", name: "done", match: "status:done" },
	{ id: "doing", name: "doing", match: "status:doing" },
	{ id: "todo", name: "todo", match: "status:todo" },
]);

describe("resolveColumn: tag matching", () => {
	it("matches by column tag", () => {
		const t = makeTask({ key: "k", tags: ["#kanban/b/todo", "#other"] });
		expect(resolveColumn(t, tagBoard)).toBe("todo");
	});

	it("tags without leading # also match", () => {
		const t = makeTask({ key: "k", tags: ["kanban/b/doing"] });
		expect(resolveColumn(t, tagBoard)).toBe("doing");
	});

	it("nested tag counts as membership", () => {
		const b = board([{ id: "w", name: "w", match: "#work" }]);
		expect(resolveColumn(makeTask({ key: "k", tags: ["#work/deep"] }), b)).toBe("w");
		// но простой префикс строки — не член: #workshop ≠ #work
		expect(resolveColumn(makeTask({ key: "k", tags: ["#workshop"] }), b)).toBeNull();
	});

	it("no matching tag: null", () => {
		const t = makeTask({ key: "k", tags: ["#elsewhere"] });
		expect(resolveColumn(t, tagBoard)).toBeNull();
	});
});

describe("resolveColumn: status matching", () => {
	it("statusChar sets: done/doing/todo", () => {
		expect(resolveColumn(makeTask({ key: "k", statusChar: "x" }), statusBoard)).toBe("done");
		expect(resolveColumn(makeTask({ key: "k", statusChar: "X" }), statusBoard)).toBe("done");
		expect(resolveColumn(makeTask({ key: "k", statusChar: "/" }), statusBoard)).toBe("doing");
		expect(resolveColumn(makeTask({ key: "k", statusChar: " " }), statusBoard)).toBe("todo");
		// нестандартный символ = todo
		expect(resolveColumn(makeTask({ key: "k", statusChar: "?" }), statusBoard)).toBe("todo");
	});

	it("cancelled '-' matches no status column", () => {
		expect(resolveColumn(makeTask({ key: "k", statusChar: "-" }), statusBoard)).toBeNull();
	});
});

describe("resolveColumn: first column wins", () => {
	it("task matching two columns lands in the earlier one", () => {
		const t = makeTask({ key: "k", tags: ["#kanban/b/todo", "#kanban/b/doing"] });
		expect(resolveColumn(t, tagBoard)).toBe("todo");

		const flipped = board([
			{ id: "doing", name: "doing", match: "#kanban/b/doing" },
			{ id: "todo", name: "todo", match: "#kanban/b/todo" },
		]);
		expect(resolveColumn(t, flipped)).toBe("doing");
	});

	it("mixed tag + status board: order decides", () => {
		const mixed = board([
			{ id: "tagged", name: "tagged", match: "#pin" },
			{ id: "done", name: "done", match: "status:done" },
		]);
		const t = makeTask({ key: "k", statusChar: "x", tags: ["#pin"] });
		expect(resolveColumn(t, mixed)).toBe("tagged");
	});
});
