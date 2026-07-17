import { describe, expect, it } from "vitest";
import type { NodeInfo, NodeState } from "../../core/projects/graphEngine";
import type { Task } from "../../core/model/Task";
import type { ProjectModel, ProjectSummary } from "../../services/ProjectService";
import {
	criticalEdgeIds,
	criticalPathIds,
	depthList,
	issueLabel,
	pickProjectPath,
	sortProjectSummaries,
	stateColorClass,
	toFlowEdges,
	toFlowNodes,
	unblockedByDelete,
} from "./projectGraphLogic";

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

function nodeInfo(
	id: string,
	state: NodeState,
	over: Omit<Partial<NodeInfo>, "task"> & { task?: Partial<Task> } = {},
): NodeInfo {
	const { task: taskOver, ...rest } = over;
	return {
		id,
		task: makeTask({ key: `id:${id}`, taskId: id, ...taskOver }),
		state,
		depth: 0,
		remainingDownstream: 0,
		ghost: false,
		...rest,
	};
}

function makeModel(over: Partial<ProjectModel> = {}): ProjectModel {
	return { nodes: [], edges: [], issues: [], layout: {}, ...over };
}

describe("toFlowNodes", () => {
	it("позиции берутся из layout, data несёт task/state/ghost", () => {
		const model = makeModel({
			nodes: [nodeInfo("a", "done"), nodeInfo("g", "ready", { ghost: true })],
			layout: { a: { x: 10, y: -20 }, g: { x: 300, y: 40 } },
		});
		const vms = toFlowNodes(model);
		expect(vms).toHaveLength(2);
		const a = vms.find((v) => v.id === "a")!;
		expect(a.x).toBe(10);
		expect(a.y).toBe(-20);
		expect(a.data.state).toBe("done");
		expect(a.data.ghost).toBe(false);
		expect(a.data.task.taskId).toBe("a");
		const g = vms.find((v) => v.id === "g")!;
		expect(g.data.ghost).toBe(true);
	});

	it("узлы без позиции складываются сеткой-стопкой ниже размещённых", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("b", "ready"),
				nodeInfo("c", "ready"),
				nodeInfo("d", "ready"),
				nodeInfo("e", "ready"),
			],
			layout: { a: { x: 0, y: 100 } },
		});
		const vms = toFlowNodes(model);
		const grid = vms.filter((v) => v.id !== "a");
		// все ниже a (100) на шаг сетки
		for (const v of grid) expect(v.y).toBeGreaterThanOrEqual(220);
		// первый ряд: b,c,d; второй ряд: e
		const b = vms.find((v) => v.id === "b")!;
		const c = vms.find((v) => v.id === "c")!;
		const e = vms.find((v) => v.id === "e")!;
		expect(b.x).toBe(0);
		expect(c.x).toBeGreaterThan(b.x);
		expect(e.x).toBe(0);
		expect(e.y).toBeGreaterThan(b.y);
	});

	it("пустой layout: сетка от нуля; дубли id схлопываются в один узел", () => {
		const model = makeModel({
			nodes: [nodeInfo("a", "ready"), nodeInfo("a", "done"), nodeInfo("b", "ready")],
		});
		const vms = toFlowNodes(model);
		expect(vms.map((v) => v.id).sort()).toEqual(["a", "b"]);
		const a = vms.find((v) => v.id === "a")!;
		expect(a.data.state).toBe("ready"); // первый носитель побеждает
		expect(a.y).toBe(0);
	});
});

describe("toFlowEdges", () => {
	it("ребро from→to = source/target с детерминированным id", () => {
		const model = makeModel({ edges: [{ from: "a", to: "b" }] });
		expect(toFlowEdges(model)).toEqual([{ id: "a->b", source: "a", target: "b" }]);
	});
});

describe("stateColorClass", () => {
	it("каждому состоянию — свой класс", () => {
		const states: NodeState[] = [
			"ready",
			"blocked",
			"done",
			"cancelled",
			"deferred",
			"waiting",
			"doing",
		];
		const classes = states.map(stateColorClass);
		expect(new Set(classes).size).toBe(states.length);
		expect(classes.every((c) => c.startsWith("gtd-node-"))).toBe(true);
	});
});

describe("depthList", () => {
	it("группы по возрастанию глубины, внутри — порядок модели", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("c", "blocked", { depth: 2 }),
				nodeInfo("a", "done", { depth: 0 }),
				nodeInfo("b1", "ready", { depth: 1 }),
				nodeInfo("b2", "ready", { depth: 1 }),
			],
		});
		const groups = depthList(model);
		expect(groups.map((g) => g.depth)).toEqual([0, 1, 2]);
		expect(groups[1]!.nodes.map((n) => n.id)).toEqual(["b1", "b2"]);
	});
});

describe("criticalPathIds", () => {
	it("длиннейшая невыполненная цепочка; done-узлы не в пути", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "done"),
				nodeInfo("b", "ready", { depth: 1 }),
				nodeInfo("c", "blocked", { depth: 2 }),
				nodeInfo("x", "ready"),
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			],
		});
		const ids = criticalPathIds(model);
		expect(ids).toEqual(new Set(["b", "c"]));
	});

	it("criticalEdgeIds: рёбра между последовательными узлами пути", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("b", "ready", { depth: 1 }),
				nodeInfo("c", "blocked", { depth: 2 }),
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			],
		});
		expect(criticalEdgeIds(model)).toEqual(new Set(["a->b", "b->c"]));
	});
});

describe("pickProjectPath", () => {
	const sorted = [
		{ path: "p1", name: "P1", status: "active", complete: false, stalled: false } as const,
		{ path: "p2", name: "P2", status: "done", complete: true, stalled: false } as const,
	];

	it("текущий выбор сохраняется, пока проект существует", () => {
		expect(pickProjectPath(sorted, "p2")).toBe("p2");
	});

	it("исчезнувший выбор → первый из списка; пустой список → null", () => {
		expect(pickProjectPath(sorted, "gone")).toBe("p1");
		expect(pickProjectPath([], null)).toBe(null);
	});
});

describe("unblockedByDelete", () => {
	it("прямой зависимый с единственной зависимостью разблокируется", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("b", "blocked", { task: { dependsOn: ["a"] } }),
			],
			edges: [{ from: "a", to: "b" }],
		});
		expect(unblockedByDelete(model, "a")).toBe(1);
	});

	it("остальные невыполненные зависимости удерживают blocked", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("b", "ready"),
				nodeInfo("c", "blocked", { task: { dependsOn: ["a", "b"] } }),
			],
		});
		expect(unblockedByDelete(model, "a")).toBe(0);
	});

	it("выполненная остальная зависимость не мешает", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("b", "done"),
				nodeInfo("c", "blocked", { task: { dependsOn: ["a", "b"] } }),
			],
		});
		expect(unblockedByDelete(model, "a")).toBe(1);
	});

	it("битая (отсутствующая в модели) зависимость — fail-closed, не разблокирует", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("c", "blocked", { task: { dependsOn: ["a", "missing"] } }),
			],
		});
		expect(unblockedByDelete(model, "a")).toBe(0);
	});

	it("призраки и не-blocked узлы не считаются", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("g", "blocked", { ghost: true, task: { dependsOn: ["a"] } }),
				nodeInfo("w", "waiting", { task: { dependsOn: ["a"] } }),
			],
		});
		expect(unblockedByDelete(model, "a")).toBe(0);
	});

	it("дубль id зависимости: выполнены ОБА носителя — иначе не разблокирует", () => {
		const model = makeModel({
			nodes: [
				nodeInfo("a", "ready"),
				nodeInfo("b", "done"),
				nodeInfo("b", "ready"), // второй носитель того же 🆔 не выполнен
				nodeInfo("c", "blocked", { task: { dependsOn: ["a", "b"] } }),
			],
		});
		expect(unblockedByDelete(model, "a")).toBe(0);
	});
});

describe("sortProjectSummaries", () => {
	function summary(over: Partial<ProjectSummary> & { path: string }): ProjectSummary {
		return { name: over.path, status: "active", complete: false, stalled: false, ...over };
	}

	it("active первыми, затем on-hold/done/archived; внутри — по имени", () => {
		const list = [
			summary({ path: "z", name: "Я-проект", status: "active" }),
			summary({ path: "arch", status: "archived" }),
			summary({ path: "d", status: "done" }),
			summary({ path: "h", status: "on-hold" }),
			summary({ path: "a", name: "А-проект", status: "active" }),
		];
		expect(sortProjectSummaries(list).map((s) => s.path)).toEqual(["a", "z", "h", "d", "arch"]);
	});

	it("вход не мутируется", () => {
		const list = [summary({ path: "b", status: "done" }), summary({ path: "a" })];
		const before = [...list];
		sortProjectSummaries(list);
		expect(list).toEqual(before);
	});
});

describe("issueLabel", () => {
	it("все виды issues получают человекочитаемую подпись", () => {
		expect(issueLabel({ kind: "broken-dep", taskKey: "id:b", depId: "ghost1" })).toContain(
			"ghost1",
		);
		expect(issueLabel({ kind: "duplicate-id", id: "dup", taskKeys: ["k1", "k2"] })).toContain(
			"dup",
		);
		expect(
			issueLabel({ kind: "done-downstream-of-undone", taskKey: "id:d", depId: "u1" }),
		).toContain("u1");
	});
});
