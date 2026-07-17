import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import { applyOrder, patchOrder } from "./ordering";

function makeTask(over: Partial<Task> & { key: string }): Task {
	return {
		taskId: null,
		filePath: "board.md",
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
		excludedDates: [],
		location: null,
		tags: [],
		container: "plain",
		projectActive: true,
		...over,
	};
}

function withId(id: string, over: Partial<Task> = {}): Task {
	return makeTask({ key: `id:${id}`, taskId: id, ...over });
}

describe("applyOrder", () => {
	it("orders by the 🆔 list", () => {
		const a = withId("a");
		const b = withId("b");
		const c = withId("c");
		expect(applyOrder([a, b, c], ["c", "a", "b"])).toEqual([c, a, b]);
	});

	it("unknown ids in order are dropped silently", () => {
		const a = withId("a");
		const b = withId("b");
		expect(applyOrder([a, b], ["ghost", "b", "gone", "a"])).toEqual([b, a]);
	});

	it("unlisted tasks are appended sorted by priority, then created", () => {
		const listed = withId("z");
		const high = withId("h", { priority: "high" });
		const oldLow = withId("l1", { priority: "low", created: "2026-01-01" });
		const newLow = withId("l2", { priority: "low", created: "2026-06-01" });
		const noneNoDate = withId("n");
		const tasks = [noneNoDate, newLow, listed, high, oldLow];

		expect(applyOrder(tasks, ["z"])).toEqual([listed, high, oldLow, newLow, noneNoDate]);
	});

	it("created=null sorts after dated tasks of same priority", () => {
		const dated = withId("d", { created: "2026-05-05" });
		const dateless = withId("n");
		expect(applyOrder([dateless, dated], [])).toEqual([dated, dateless]);
	});

	it("tasks without 🆔 are always appended", () => {
		const anon = makeTask({ key: "content-key-1" });
		const a = withId("a");
		expect(applyOrder([anon, a], ["a"])).toEqual([a, anon]);
	});

	it("empty order: pure priority/created sort", () => {
		const a = withId("a", { priority: "lowest" });
		const b = withId("b", { priority: "highest" });
		expect(applyOrder([a, b], [])).toEqual([b, a]);
	});

	it("duplicate carriers of one id: each order entry consumes the next carrier", () => {
		const c1 = makeTask({ key: "k1", taskId: "dup" });
		const c2 = makeTask({ key: "k2", taskId: "dup" });
		const res = applyOrder([c1, c2], ["dup"]);
		expect(res[0]).toBe(c1);
		expect(res).toHaveLength(2);
		expect(res).toContain(c2); // второй носитель добавлен в хвост, не потерян
	});
});

describe("patchOrder", () => {
	it("replaces the column list and removes moved ids from other columns", () => {
		const order = { todo: ["a", "b"], doing: ["c"], done: ["d"] };
		const next = patchOrder(order, "doing", ["b", "c"]);
		expect(next).toEqual({ todo: ["a"], doing: ["b", "c"], done: ["d"] });
		// вход не мутирован
		expect(order.todo).toEqual(["a", "b"]);
	});

	it("dedupes ids inside the new list", () => {
		const next = patchOrder({}, "col", ["a", "b", "a", "a"]);
		expect(next).toEqual({ col: ["a", "b"] });
	});

	it("creates the column entry when absent", () => {
		const next = patchOrder({ other: ["x"] }, "fresh", ["y"]);
		expect(next).toEqual({ other: ["x"], fresh: ["y"] });
	});

	it("emptying a column keeps the key with an empty list", () => {
		const next = patchOrder({ a: ["x"], b: ["y"] }, "a", []);
		expect(next).toEqual({ a: [], b: ["y"] });
	});
});
