import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import type { BoardDef } from "./boardFile";
import { belongsToBoard, resolveColumn } from "./membership";

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
	return { id: "b", name: "b", groupBy: "tag", columns, skippedColumns: [], order: {} };
}

const tagBoard = board([
	{ id: "todo", name: "todo", match: "#kanban/b/todo" },
	{ id: "doing", name: "doing", match: "#kanban/b/doing" },
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

describe("resolveColumn: статус на членство не влияет (раунд 3)", () => {
	it("задача любого статуса ложится в свою тег-колонку", () => {
		for (const statusChar of [" ", "/", "x", "X", "-"]) {
			const t = makeTask({ key: "k", statusChar, tags: ["#kanban/b/todo"] });
			expect(resolveColumn(t, tagBoard)).toBe("todo");
		}
	});

	it("без подходящего тега — null, какой бы ни был статус", () => {
		expect(resolveColumn(makeTask({ key: "k", statusChar: "x" }), tagBoard)).toBeNull();
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
});

describe("belongsToBoard", () => {
	it("(a) задача из файла доски — член без тегов и scope", () => {
		const t = makeTask({ key: "k", filePath: "Board.md" });
		expect(belongsToBoard(t, "Board.md", tagBoard)).toBe(true);
	});

	it("(b) тег колонки этой доски делает членом из любого файла", () => {
		const t = makeTask({ key: "k", filePath: "x.md", tags: ["#kanban/b/todo"] });
		expect(belongsToBoard(t, "Board.md", tagBoard)).toBe(true);
	});

	it("тег колонки без ведущего # тоже засчитывается", () => {
		const t = makeTask({ key: "k", filePath: "x.md", tags: ["kanban/b/doing"] });
		expect(belongsToBoard(t, "Board.md", tagBoard)).toBe(true);
	});

	it("тег ДРУГОЙ доски не делает членом", () => {
		const t = makeTask({ key: "k", filePath: "x.md", tags: ["#kanban/other/todo"] });
		expect(belongsToBoard(t, "Board.md", tagBoard)).toBe(false);
	});

	it("(c) scope 'path:' включает по префиксу пути, прочее — нет", () => {
		const def: BoardDef = { ...tagBoard, scope: "path:GTD/" };
		expect(belongsToBoard(makeTask({ key: "k", filePath: "GTD/a.md" }), "Board.md", def)).toBe(true);
		expect(belongsToBoard(makeTask({ key: "k", filePath: "other.md" }), "Board.md", def)).toBe(
			false,
		);
	});

	it("не-path scope членство не расширяет (чужой файл без тега — не член)", () => {
		const def: BoardDef = { ...tagBoard, scope: "#sometag" };
		expect(belongsToBoard(makeTask({ key: "k", filePath: "other.md" }), "Board.md", def)).toBe(
			false,
		);
	});

	it("нет совпадений — не член: чужая задача из другого файла не протекает", () => {
		const t = makeTask({ key: "k", filePath: "other.md", tags: ["#unrelated"] });
		expect(belongsToBoard(t, "Board.md", tagBoard)).toBe(false);
	});
});
