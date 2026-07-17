import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import type { ProjectGraph } from "./graphEngine";
import { buildGraph, criticalPath, wouldCreateCycle } from "./graphEngine";

const TODAY = "2026-07-15";

function makeTask(over: Partial<Task> & { key: string }): Task {
	return {
		taskId: null,
		filePath: "Projects/kitchen.md",
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
		container: "project",
		projectActive: true,
		...over,
	};
}

function member(id: string, over: Partial<Task> = {}): Task {
	return makeTask({ key: `id:${id}`, taskId: id, ...over });
}

function makeResolve(tasks: readonly Task[]): (id: string) => Task[] {
	return (id) => tasks.filter((t) => t.taskId === id);
}

function node(g: ProjectGraph, id: string) {
	const n = g.nodes.find((x) => x.id === id);
	if (!n) throw new Error(`node ${id} not found`);
	return n;
}

describe("buildGraph: readiness", () => {
	it("chain: done -> ready -> blocked", () => {
		const a = member("a", { statusChar: "x" });
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["b"] });
		const members = [a, b, c];
		const g = buildGraph(members, makeResolve(members), TODAY);

		expect(node(g, "a").state).toBe("done");
		expect(node(g, "b").state).toBe("ready");
		expect(node(g, "c").state).toBe("blocked");
		expect(g.edges).toEqual(
			expect.arrayContaining([
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			]),
		);
		expect(g.edges).toHaveLength(2);
		expect(g.issues).toEqual([]);
	});

	it("cancelled dependency counts as satisfied", () => {
		const a = member("a", { statusChar: "-" });
		const b = member("b", { dependsOn: ["a"] });
		const members = [a, b];
		const g = buildGraph(members, makeResolve(members), TODAY);
		expect(node(g, "a").state).toBe("cancelled");
		expect(node(g, "b").state).toBe("ready");
	});

	it("diamond: fan-out is blocked until the root is done", () => {
		const a = member("a");
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["a"] });
		const d = member("d", { dependsOn: ["b", "c"] });
		const members = [a, b, c, d];
		const g = buildGraph(members, makeResolve(members), TODAY);

		expect(node(g, "a").state).toBe("ready");
		expect(node(g, "b").state).toBe("blocked");
		expect(node(g, "c").state).toBe("blocked");
		expect(node(g, "d").state).toBe("blocked");
	});

	it("diamond with done root: both branches become ready, join stays blocked", () => {
		const a = member("a", { statusChar: "x" });
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["a"] });
		const d = member("d", { dependsOn: ["b", "c"] });
		const members = [a, b, c, d];
		const g = buildGraph(members, makeResolve(members), TODAY);

		expect(node(g, "b").state).toBe("ready");
		expect(node(g, "c").state).toBe("ready");
		expect(node(g, "d").state).toBe("blocked");
	});

	it("parallel branches: independent roots are ready at once", () => {
		const a = member("a");
		const b = member("b");
		const c = member("c", { dependsOn: ["a"] });
		const members = [a, b, c];
		const g = buildGraph(members, makeResolve(members), TODAY);
		expect(node(g, "a").state).toBe("ready");
		expect(node(g, "b").state).toBe("ready");
		expect(node(g, "c").state).toBe("blocked");
	});

	it("deferred (start > today) beats readiness; waiting beats blocked; doing needs met deps", () => {
		const a = member("a", { statusChar: "x" });
		const tickler = member("t", { dependsOn: ["a"], start: "2027-01-01" });
		const waiting = member("w", { dependsOn: ["zzz-missing"], tags: ["#waiting"] });
		const doing = member("g", { dependsOn: ["a"], statusChar: "/" });
		const doingBlocked = member("h", { dependsOn: ["t"], statusChar: "/" });
		const members = [a, tickler, waiting, doing, doingBlocked];
		const g = buildGraph(members, makeResolve(members), TODAY);

		expect(node(g, "t").state).toBe("deferred");
		expect(node(g, "w").state).toBe("waiting");
		expect(node(g, "g").state).toBe("doing");
		expect(node(g, "h").state).toBe("blocked");
	});
});

describe("buildGraph: ghosts and issues", () => {
	it("cross-file dependency becomes a read-only ghost node", () => {
		const ghostCarrier = makeTask({
			key: "id:ext",
			taskId: "ext",
			filePath: "Projects/other.md",
		});
		const m = member("m", { dependsOn: ["ext"] });
		const g = buildGraph([m], makeResolve([m, ghostCarrier]), TODAY);

		const ghost = node(g, "ext");
		expect(ghost.ghost).toBe(true);
		expect(ghost.task).toBe(ghostCarrier);
		expect(node(g, "m").ghost).toBe(false);
		expect(node(g, "m").state).toBe("blocked");
		expect(g.edges).toEqual([{ from: "ext", to: "m" }]);
		expect(g.issues).toEqual([]);
	});

	it("done ghost dependency unblocks the member", () => {
		const ghostCarrier = makeTask({
			key: "id:ext",
			taskId: "ext",
			filePath: "Projects/other.md",
			statusChar: "x",
		});
		const m = member("m", { dependsOn: ["ext"] });
		const g = buildGraph([m], makeResolve([m, ghostCarrier]), TODAY);
		expect(node(g, "m").state).toBe("ready");
		expect(node(g, "ext").state).toBe("done");
	});

	it("unresolvable dep id: broken-dep issue, no edge, fail-closed blocked", () => {
		const m = member("m", { dependsOn: ["nope"] });
		const g = buildGraph([m], makeResolve([m]), TODAY);

		expect(node(g, "m").state).toBe("blocked");
		expect(g.edges).toEqual([]);
		expect(g.issues).toEqual([{ kind: "broken-dep", taskKey: m.key, depId: "nope" }]);
		expect(g.nodes).toHaveLength(1); // призрака для битого id нет
	});

	it("duplicate member ids are reported and dependents stay fail-closed blocked", () => {
		const d1 = makeTask({ key: "k1", taskId: "dup", statusChar: "x" });
		const d2 = makeTask({ key: "k2", taskId: "dup", statusChar: " " });
		const m = member("m", { dependsOn: ["dup"] });
		const members = [d1, d2, m];
		const g = buildGraph(members, makeResolve(members), TODAY);

		const dupIssue = g.issues.find((i) => i.kind === "duplicate-id");
		expect(dupIssue).toEqual({ kind: "duplicate-id", id: "dup", taskKeys: ["k1", "k2"] });
		// не ВСЕ носители done ⇒ зависимость не выполнена
		expect(node(g, "m").state).toBe("blocked");
	});

	it("done task downstream of an undone dependency is an anomaly", () => {
		const a = member("a", { statusChar: " " });
		const b = member("b", { dependsOn: ["a"], statusChar: "x" });
		const members = [a, b];
		const g = buildGraph(members, makeResolve(members), TODAY);

		expect(g.issues).toEqual([
			{ kind: "done-downstream-of-undone", taskKey: b.key, depId: "a" },
		]);
		// состояние при этом остаётся DONE — аномалия лишь бейдж
		expect(node(g, "b").state).toBe("done");
	});
});

describe("buildGraph: depth and remainingDownstream", () => {
	it("depth is the longest path from roots (diamond)", () => {
		const a = member("a");
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["a"] });
		const d = member("d", { dependsOn: ["b", "c"] });
		// e зависит и от корня, и от глубокого узла — глубина по ДЛИННЕЙШЕМУ пути
		const e = member("e", { dependsOn: ["a", "d"] });
		const members = [a, b, c, d, e];
		const g = buildGraph(members, makeResolve(members), TODAY);

		expect(node(g, "a").depth).toBe(0);
		expect(node(g, "b").depth).toBe(1);
		expect(node(g, "c").depth).toBe(1);
		expect(node(g, "d").depth).toBe(2);
		expect(node(g, "e").depth).toBe(3);
	});

	it("remainingDownstream counts transitively dependent not-done nodes", () => {
		const a = member("a", { statusChar: "x" });
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["a"], statusChar: "-" });
		const d = member("d", { dependsOn: ["b", "c"] });
		const members = [a, b, c, d];
		const g = buildGraph(members, makeResolve(members), TODAY);

		// вниз от a: b, c, d; из них невыполненные — b и d (c cancelled)
		expect(node(g, "a").remainingDownstream).toBe(2);
		expect(node(g, "b").remainingDownstream).toBe(1);
		expect(node(g, "c").remainingDownstream).toBe(1);
		expect(node(g, "d").remainingDownstream).toBe(0);
	});

	it("ghost node is a root at depth 0 feeding member depths", () => {
		const ghostCarrier = makeTask({ key: "id:ext", taskId: "ext", filePath: "other.md" });
		const m = member("m", { dependsOn: ["ext"] });
		const g = buildGraph([m], makeResolve([m, ghostCarrier]), TODAY);
		expect(node(g, "ext").depth).toBe(0);
		expect(node(g, "m").depth).toBe(1);
		expect(node(g, "ext").remainingDownstream).toBe(1);
	});
});

describe("wouldCreateCycle", () => {
	const edges = [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	];

	it("detects a cycle closing a chain", () => {
		const res = wouldCreateCycle(edges, "c", "a");
		expect(res.cycle).toEqual(["a", "b", "c"]);
	});

	it("no cycle for a forward shortcut", () => {
		expect(wouldCreateCycle(edges, "a", "c").cycle).toBeNull();
	});

	it("detects a direct back edge", () => {
		const res = wouldCreateCycle(edges, "b", "a");
		expect(res.cycle).toEqual(["a", "b"]);
	});

	it("self edge is a cycle", () => {
		expect(wouldCreateCycle(edges, "a", "a").cycle).toEqual(["a"]);
	});

	it("disconnected nodes never cycle", () => {
		expect(wouldCreateCycle(edges, "x", "y").cycle).toBeNull();
	});
});

describe("criticalPath", () => {
	it("full undone chain is the critical path", () => {
		const a = member("a");
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["b"] });
		const members = [a, b, c];
		const g = buildGraph(members, makeResolve(members), TODAY);
		expect(criticalPath(g.nodes, g.edges)).toEqual(["a", "b", "c"]);
	});

	it("done head is excluded from the path", () => {
		const a = member("a", { statusChar: "x" });
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["b"] });
		const members = [a, b, c];
		const g = buildGraph(members, makeResolve(members), TODAY);
		expect(criticalPath(g.nodes, g.edges)).toEqual(["b", "c"]);
	});

	it("picks the longer of two branches", () => {
		const a = member("a");
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["b"] });
		const short = member("s", { dependsOn: ["a"] });
		const members = [a, b, c, short];
		const g = buildGraph(members, makeResolve(members), TODAY);
		expect(criticalPath(g.nodes, g.edges)).toEqual(["a", "b", "c"]);
	});

	it("diamond: path spans root to join", () => {
		const a = member("a");
		const b = member("b", { dependsOn: ["a"] });
		const c = member("c", { dependsOn: ["a"] });
		const d = member("d", { dependsOn: ["b", "c"] });
		const members = [a, b, c, d];
		const g = buildGraph(members, makeResolve(members), TODAY);
		const path = criticalPath(g.nodes, g.edges);
		expect(path).toHaveLength(3);
		expect(path[0]).toBe("a");
		expect(path[2]).toBe("d");
	});

	it("everything done: empty path", () => {
		const a = member("a", { statusChar: "x" });
		const b = member("b", { dependsOn: ["a"], statusChar: "X" });
		const members = [a, b];
		const g = buildGraph(members, makeResolve(members), TODAY);
		expect(criticalPath(g.nodes, g.edges)).toEqual([]);
	});
});
