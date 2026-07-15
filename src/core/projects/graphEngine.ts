/**
 * Чистый DAG-движок проекта (ТЗ §7): состояния узлов, глубина, циклы,
 * критический путь. Всё выводится из членов файла-проекта — ноль записей.
 *
 * core/ не импортирует `obsidian` — см. scripts/check-core-purity.mjs.
 */
import type { IsoDate, Task } from "../model/Task";
import { depsMet } from "../model/gtdState";

/** Резолвер носителей id по глобальному индексу (byId — мультизначный). */
export type ResolveDep = (id: string) => Task[];

/** Графовое состояние узла; порядок вывода = цепочка ТЗ §1
 *  (TICKLER выше BLOCKED: 🛫 в будущем побеждает готовность). */
export type NodeState =
	| "done"
	| "cancelled"
	| "deferred"
	| "waiting"
	| "blocked"
	| "doing"
	| "ready";

export interface NodeInfo {
	/** Идентификатор узла в графе: 🆔 задачи; для члена без 🆔 — его key. */
	id: string;
	task: Task;
	state: NodeState;
	/** Длиннейший путь от корней; 0 у корней (узлов без входящих рёбер). */
	depth: number;
	/** Сколько невыполненных (не done/cancelled) узлов транзитивно зависят от этого. */
	remainingDownstream: number;
	/** Носитель зависимости вне множества членов (cross-file) — read-only «призрак». */
	ghost: boolean;
}

/** Ребро from → to означает: to несёт `⛔ from` (to зависит от from). */
export interface GraphEdge {
	from: string;
	to: string;
}

export type GraphIssue =
	/** ⛔ указывает на id без единого носителя в индексе (fail-closed ⇒ blocked). */
	| { kind: "broken-dep"; taskKey: string; depId: string }
	/** Один 🆔 у нескольких ЧЛЕНОВ проекта (глобальные дубли — забота duplicateIds индекса). */
	| { kind: "duplicate-id"; id: string; taskKeys: string[] }
	/** Выполненная задача зависит от невыполненной — след un-done флипа выше по графу. */
	| { kind: "done-downstream-of-undone"; taskKey: string; depId: string };

export interface ProjectGraph {
	nodes: NodeInfo[];
	edges: GraphEdge[];
	issues: GraphIssue[];
}

function isDoneChar(c: string): boolean {
	return c === "x" || c === "X";
}

function hasWaitingTag(t: Task): boolean {
	// Теги могут прийти с '#' или без — сравниваем нормализованно
	return t.tags.some((tag) => (tag.startsWith("#") ? tag.slice(1) : tag) === "waiting");
}

function nodeState(t: Task, unmetDeps: boolean, today: IsoDate): NodeState {
	if (isDoneChar(t.statusChar)) return "done";
	if (t.statusChar === "-") return "cancelled";
	if (t.start !== null && t.start > today) return "deferred";
	if (hasWaitingTag(t)) return "waiting";
	if (unmetDeps) return "blocked";
	if (t.statusChar === "/") return "doing";
	return "ready";
}

/**
 * Построить граф проекта из его членов.
 * `today` нужен для состояния deferred (🛫 > today) — передаётся скаляром,
 * как и везде в ядре (индекс = чистая функция от файлов + today).
 */
export function buildGraph(
	members: readonly Task[],
	resolveDep: ResolveDep,
	today: IsoDate,
): ProjectGraph {
	const issues: GraphIssue[] = [];

	// --- члены-носители id + дубли внутри проекта ---
	const memberCarriers = new Map<string, Task[]>();
	for (const t of members) {
		if (t.taskId === null) continue;
		const list = memberCarriers.get(t.taskId);
		if (list) list.push(t);
		else memberCarriers.set(t.taskId, [t]);
	}
	for (const [id, carriers] of memberCarriers) {
		if (carriers.length > 1) {
			issues.push({ kind: "duplicate-id", id, taskKeys: carriers.map((t) => t.key) });
		}
	}

	const nodeId = (t: Task): string => t.taskId ?? t.key;

	// --- рёбра + призраки ---
	const edges: GraphEdge[] = [];
	const edgeSeen = new Set<string>();
	const ghostByDep = new Map<string, Task>();
	const pushEdge = (from: string, to: string): void => {
		const sig = from + "\u0000" + to;
		if (edgeSeen.has(sig)) return;
		edgeSeen.add(sig);
		edges.push({ from, to });
	};
	for (const m of members) {
		for (const dep of m.dependsOn) {
			if (memberCarriers.has(dep)) {
				pushEdge(dep, nodeId(m));
				continue;
			}
			const carriers = resolveDep(dep);
			const first = carriers[0];
			if (first === undefined) {
				// Ребро не рисуем: битому id некуда вести; blocked обеспечит depsMet (fail-closed)
				issues.push({ kind: "broken-dep", taskKey: m.key, depId: dep });
				continue;
			}
			if (!ghostByDep.has(dep)) ghostByDep.set(dep, first);
			pushEdge(dep, nodeId(m));
		}
	}

	// --- узлы ---
	const nodes: NodeInfo[] = [];
	for (const m of members) {
		const unmet = !depsMet(m, resolveDep);
		nodes.push({
			id: nodeId(m),
			task: m,
			state: nodeState(m, unmet, today),
			depth: 0,
			remainingDownstream: 0,
			ghost: false,
		});
	}
	for (const [dep, carrier] of ghostByDep) {
		const unmet = !depsMet(carrier, resolveDep);
		nodes.push({
			id: dep,
			task: carrier,
			state: nodeState(carrier, unmet, today),
			depth: 0,
			remainingDownstream: 0,
			ghost: true,
		});
	}

	// --- глубина: длиннейший путь от корней (Kahn; узлы в циклах остаются на 0, не падаем) ---
	const ids = new Set(nodes.map((n) => n.id));
	const out = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	for (const id of ids) {
		out.set(id, []);
		indeg.set(id, 0);
	}
	for (const e of edges) {
		out.get(e.from)?.push(e.to);
		indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	}
	const depth = new Map<string, number>();
	const queue: string[] = [];
	for (const id of ids) {
		if ((indeg.get(id) ?? 0) === 0) {
			queue.push(id);
			depth.set(id, 0);
		}
	}
	for (let qi = 0; qi < queue.length; qi++) {
		const cur = queue[qi];
		if (cur === undefined) break;
		const d = depth.get(cur) ?? 0;
		for (const next of out.get(cur) ?? []) {
			depth.set(next, Math.max(depth.get(next) ?? 0, d + 1));
			const rem = (indeg.get(next) ?? 1) - 1;
			indeg.set(next, rem);
			if (rem === 0) queue.push(next);
		}
	}

	// --- remainingDownstream: транзитивно зависящие невыполненные узлы ---
	// При дублях id узел считается невыполненным, если невыполнен ХОТЬ ОДИН носитель (fail-closed)
	const remainingId = new Map<string, boolean>();
	for (const n of nodes) {
		const r = n.state !== "done" && n.state !== "cancelled";
		remainingId.set(n.id, (remainingId.get(n.id) ?? false) || r);
	}
	const downstreamCount = new Map<string, number>();
	for (const id of ids) {
		const seen = new Set<string>();
		const stack = [...(out.get(id) ?? [])];
		while (stack.length > 0) {
			const cur = stack.pop();
			if (cur === undefined || seen.has(cur)) continue;
			seen.add(cur);
			for (const nx of out.get(cur) ?? []) {
				if (!seen.has(nx)) stack.push(nx);
			}
		}
		let count = 0;
		for (const s of seen) {
			if (s !== id && remainingId.get(s) === true) count++;
		}
		downstreamCount.set(id, count);
	}
	for (const n of nodes) {
		n.depth = depth.get(n.id) ?? 0;
		n.remainingDownstream = downstreamCount.get(n.id) ?? 0;
	}

	// --- аномалия: done-узел зависит от невыполненного (прямое ребро) ---
	const nodesById = new Map<string, NodeInfo[]>();
	for (const n of nodes) {
		const list = nodesById.get(n.id);
		if (list) list.push(n);
		else nodesById.set(n.id, [n]);
	}
	for (const e of edges) {
		if (remainingId.get(e.from) !== true) continue;
		for (const n of nodesById.get(e.to) ?? []) {
			if (n.state === "done") {
				issues.push({ kind: "done-downstream-of-undone", taskKey: n.task.key, depId: e.from });
			}
		}
	}

	return { nodes, edges, issues };
}

/**
 * Замкнёт ли новое ребро from → to цикл? DFS от `to` по существующим рёбрам:
 * цикл есть ⇔ from достижим из to. Возвращаемый путь: [to, …, from] —
 * последовательные элементы соединены существующими рёбрами, новое ребро
 * from → to замыкает петлю. Само-ребро (from === to) ⇒ цикл [from].
 * Используется валидацией ConnectEdge и isValidConnection в UI.
 */
export function wouldCreateCycle(
	edges: readonly GraphEdge[],
	from: string,
	to: string,
): { cycle: string[] | null } {
	if (from === to) return { cycle: [from] };
	const out = new Map<string, string[]>();
	for (const e of edges) {
		const list = out.get(e.from);
		if (list) list.push(e.to);
		else out.set(e.from, [e.to]);
	}
	const parent = new Map<string, string>();
	const visited = new Set<string>([to]);
	const stack: string[] = [to];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (cur === undefined) break;
		for (const next of out.get(cur) ?? []) {
			if (next === from) {
				// восстановить to → … → cur, затем добавить from
				const path: string[] = [];
				let p: string | undefined = cur;
				while (p !== undefined) {
					path.push(p);
					p = parent.get(p);
				}
				path.reverse();
				path.push(from);
				return { cycle: path };
			}
			if (!visited.has(next)) {
				visited.add(next);
				parent.set(next, cur);
				stack.push(next);
			}
		}
	}
	return { cycle: null };
}

/**
 * Критический путь: самая длинная цепочка невыполненных узлов
 * (done И cancelled работой не считаются). Возвращает id в порядке
 * зависимостей: от корневой стороны к листовой. Узлы в циклах игнорируются.
 */
export function criticalPath(nodes: readonly NodeInfo[], edges: readonly GraphEdge[]): string[] {
	const remaining = new Set<string>();
	for (const n of nodes) {
		if (n.state !== "done" && n.state !== "cancelled") remaining.add(n.id);
	}
	const out = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	for (const id of remaining) {
		out.set(id, []);
		indeg.set(id, 0);
	}
	// Индуцированный подграф: рёбра только между невыполненными узлами —
	// done-узел посреди цепочки разрывает её (та часть работы уже сделана)
	for (const e of edges) {
		if (!remaining.has(e.from) || !remaining.has(e.to)) continue;
		out.get(e.from)?.push(e.to);
		indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	}
	const queue: string[] = [];
	for (const id of remaining) {
		if ((indeg.get(id) ?? 0) === 0) queue.push(id);
	}
	const topo: string[] = [];
	for (let qi = 0; qi < queue.length; qi++) {
		const cur = queue[qi];
		if (cur === undefined) break;
		topo.push(cur);
		for (const next of out.get(cur) ?? []) {
			const rem = (indeg.get(next) ?? 1) - 1;
			indeg.set(next, rem);
			if (rem === 0) queue.push(next);
		}
	}
	const len = new Map<string, number>();
	const prev = new Map<string, string>();
	for (const id of topo) len.set(id, 1);
	for (const id of topo) {
		const dl = len.get(id) ?? 1;
		for (const next of out.get(id) ?? []) {
			if ((len.get(next) ?? 1) < dl + 1) {
				len.set(next, dl + 1);
				prev.set(next, id);
			}
		}
	}
	let best: string | null = null;
	let bestLen = 0;
	for (const id of topo) {
		const l = len.get(id) ?? 0;
		if (l > bestLen) {
			bestLen = l;
			best = id;
		}
	}
	if (best === null) return [];
	const path: string[] = [];
	let cur: string | undefined = best;
	while (cur !== undefined) {
		path.push(cur);
		cur = prev.get(cur);
	}
	return path.reverse();
}
