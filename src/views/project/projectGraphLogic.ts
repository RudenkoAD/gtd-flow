/**
 * Чистая логика вида проекта (без DOM, obsidian и Svelte Flow):
 * маппинг ProjectModel → вью-модели узлов/рёбер, группы по глубине для
 * мобильного списка, критический путь, оценка «разблокирует N задач».
 */
import type { NodeInfo, NodeState, GraphIssue } from "../../core/projects/graphEngine";
import { criticalPath } from "../../core/projects/graphEngine";
import type { Task } from "../../core/model/Task";
import type { ProjectModel, ProjectSummary } from "../../services/ProjectService";

// ---------------------------------------------------------------------------
// Узлы
// ---------------------------------------------------------------------------

export interface FlowNodeVM {
	id: string;
	x: number;
	y: number;
	data: { task: Task; state: NodeState; ghost: boolean };
}

/** Сетка-стопка для узлов без сохранённой позиции (потеря layout = не катастрофа). */
const GRID_COLS = 3;
const GRID_STEP_X = 280;
const GRID_STEP_Y = 120;

/**
 * Узлы модели → вью-модели с позициями: из layout, а без позиции —
 * временная сетка-стопка ниже самого нижнего размещённого узла
 * (детерминированно: порядок модели). Дубли id схлопываются в один узел —
 * Svelte Flow требует уникальность id; конфликт виден в issues.
 */
export function toFlowNodes(model: ProjectModel): FlowNodeVM[] {
	const out: FlowNodeVM[] = [];
	const seen = new Set<string>();
	const placed: NodeInfo[] = [];
	const unplaced: NodeInfo[] = [];
	for (const n of model.nodes) {
		if (seen.has(n.id)) continue; // duplicate-id: рисуем первого носителя
		seen.add(n.id);
		if (model.layout[n.id] !== undefined) placed.push(n);
		else unplaced.push(n);
	}
	let maxY = -Infinity;
	for (const n of placed) {
		const pos = model.layout[n.id]!;
		out.push({ id: n.id, x: pos.x, y: pos.y, data: nodeData(n) });
		if (pos.y > maxY) maxY = pos.y;
	}
	const baseY = placed.length > 0 ? maxY + GRID_STEP_Y : 0;
	unplaced.forEach((n, i) => {
		out.push({
			id: n.id,
			x: (i % GRID_COLS) * GRID_STEP_X,
			y: baseY + Math.floor(i / GRID_COLS) * GRID_STEP_Y,
			data: nodeData(n),
		});
	});
	return out;
}

function nodeData(n: NodeInfo): FlowNodeVM["data"] {
	return { task: n.task, state: n.state, ghost: n.ghost };
}

// ---------------------------------------------------------------------------
// Рёбра
// ---------------------------------------------------------------------------

export interface FlowEdgeVM {
	id: string;
	source: string;
	target: string;
}

export function toFlowEdges(model: ProjectModel): FlowEdgeVM[] {
	return model.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to }));
}

// ---------------------------------------------------------------------------
// Цвета состояний
// ---------------------------------------------------------------------------

/** CSS-класс рамки узла по графовому состоянию (ТЗ §7: ready — акцент,
 *  blocked — серый+замок, done — зелёный, deferred — часы, waiting — янтарь). */
export function stateColorClass(state: NodeState): string {
	switch (state) {
		case "ready":
			return "gtd-node-ready";
		case "blocked":
			return "gtd-node-blocked";
		case "done":
			return "gtd-node-done";
		case "cancelled":
			return "gtd-node-cancelled";
		case "deferred":
			return "gtd-node-deferred";
		case "waiting":
			return "gtd-node-waiting";
		case "doing":
			return "gtd-node-doing";
	}
}

// ---------------------------------------------------------------------------
// Мобильный список: группы по глубине зависимостей
// ---------------------------------------------------------------------------

export interface DepthGroup {
	depth: number;
	nodes: NodeInfo[];
}

/** Группы по NodeInfo.depth по возрастанию; внутри группы — порядок модели
 *  (порядок файла). Дубли id не схлопываются: список показывает всех носителей. */
export function depthList(model: ProjectModel): DepthGroup[] {
	const byDepth = new Map<number, NodeInfo[]>();
	for (const n of model.nodes) {
		const list = byDepth.get(n.depth);
		if (list) list.push(n);
		else byDepth.set(n.depth, [n]);
	}
	return [...byDepth.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([depth, nodes]) => ({ depth, nodes }));
}

// ---------------------------------------------------------------------------
// Критический путь
// ---------------------------------------------------------------------------

/** Id-множество узлов критического пути (подсветка в графе). */
export function criticalPathIds(model: ProjectModel): Set<string> {
	return new Set(criticalPath(model.nodes, model.edges));
}

/** Id рёбер (`from->to`) между последовательными узлами критического пути. */
export function criticalEdgeIds(model: ProjectModel): Set<string> {
	const path = criticalPath(model.nodes, model.edges);
	const out = new Set<string>();
	for (let i = 0; i + 1 < path.length; i++) out.add(`${path[i]}->${path[i + 1]}`);
	return out;
}

// ---------------------------------------------------------------------------
// «Разблокирует N задач» — оценка ДО DeleteNode, по модели
// ---------------------------------------------------------------------------

const FINISHED: ReadonlySet<NodeState> = new Set<NodeState>(["done", "cancelled"]);

/**
 * Сколько узлов перестанут быть blocked после удаления узла `id`:
 * прямые зависимые в состоянии blocked, у которых ВСЕ остальные зависимости
 * выполнены. Зависимость выполнена ⇔ все её носители в модели done/cancelled;
 * отсутствующий в модели id (битая зависимость) — не выполнена (fail-closed).
 */
export function unblockedByDelete(model: ProjectModel, id: string): number {
	const carriers = new Map<string, NodeInfo[]>();
	for (const n of model.nodes) {
		const list = carriers.get(n.id);
		if (list) list.push(n);
		else carriers.set(n.id, [n]);
	}
	const depSatisfied = (dep: string): boolean => {
		const list = carriers.get(dep);
		if (list === undefined) return false;
		return list.every((n) => FINISHED.has(n.state));
	};
	let count = 0;
	for (const n of model.nodes) {
		if (n.ghost || n.state !== "blocked") continue;
		if (!n.task.dependsOn.includes(id)) continue;
		const rest = n.task.dependsOn.filter((d) => d !== id);
		if (rest.every(depSatisfied)) count++;
	}
	return count;
}

// ---------------------------------------------------------------------------
// Селектор проектов
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<ProjectSummary["status"], number> = {
	active: 0,
	"on-hold": 1,
	done: 2,
	archived: 3,
};

/** Сортировка селектора: active первыми, внутри статуса — по имени. */
export function sortProjectSummaries(list: readonly ProjectSummary[]): ProjectSummary[] {
	return [...list].sort((a, b) => {
		const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
		if (so !== 0) return so;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
}

// ---------------------------------------------------------------------------
// Состояние вида
// ---------------------------------------------------------------------------

/** JSON-сериализуемое состояние вида для workspace-раскладки (ТЗ §4). */
export interface ProjectPersistedState {
	projectPath?: string;
}

/**
 * Какой проект показывать: текущий выбор, если он существует,
 * иначе первый из отсортированного списка (active первыми), иначе null.
 */
export function pickProjectPath(
	sorted: readonly ProjectSummary[],
	current: string | null,
): string | null {
	if (current !== null && sorted.some((s) => s.path === current)) return current;
	return sorted.length > 0 ? sorted[0]!.path : null;
}

// ---------------------------------------------------------------------------
// Issues проекта — человекочитаемые подписи
// ---------------------------------------------------------------------------

export function issueLabel(issue: GraphIssue): string {
	switch (issue.kind) {
		case "broken-dep":
			return `⛔ ${issue.depId}: зависимость не найдена (задача заблокирована)`;
		case "duplicate-id":
			return `🆔 ${issue.id}: дубль у ${issue.taskKeys.length} задач — выдайте свежий id`;
		case "done-downstream-of-undone":
			return `Выполненная задача зависит от невыполненной ${issue.depId} (след un-done выше по графу)`;
	}
}
