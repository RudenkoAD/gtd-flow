/**
 * Авто-layout графа проекта через elkjs (ТЗ §7: layered, слева направо).
 * НАМЕРЕННО в слое вида, не в core: elkjs — зависимость презентации
 * (core/projects/layout.ts только нормализует данные). Импорт bundled-версии —
 * без web worker: расчёт в главном потоке, для графов GTD-масштаба это мгновенно.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";

export interface ElkInputNode {
	id: string;
	/** Реальные размеры узла из Svelte Flow (measured); без них — дефолт. */
	width?: number;
	height?: number;
}

export interface ElkInputEdge {
	from: string;
	to: string;
}

export interface ElkMove {
	id: string;
	x: number;
	y: number;
}

const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 80;

const LAYOUT_OPTIONS: Record<string, string> = {
	"elk.algorithm": "layered",
	"elk.direction": "RIGHT",
	"elk.spacing.nodeNode": "40",
	"elk.layered.spacing.nodeNodeBetweenLayers": "80",
};

/**
 * Позиции всех узлов после layered-раскладки — готовый батч для
 * ProjectPort.moveNodes (один откатываемый MoveNode за нажатие кнопки).
 */
export async function elkAutoLayout(
	nodes: readonly ElkInputNode[],
	edges: readonly ElkInputEdge[],
): Promise<ElkMove[]> {
	if (nodes.length === 0) return [];
	const elk = new ELK();
	const known = new Set(nodes.map((n) => n.id));
	const graph: ElkNode = {
		id: "gtd-project-root",
		layoutOptions: LAYOUT_OPTIONS,
		children: nodes.map((n) => ({
			id: n.id,
			width: n.width ?? DEFAULT_WIDTH,
			height: n.height ?? DEFAULT_HEIGHT,
		})),
		// рёбра на узлы вне набора elk считает ошибкой — отфильтровываем
		edges: edges
			.filter((e) => known.has(e.from) && known.has(e.to))
			.map((e) => ({ id: `${e.from}->${e.to}`, sources: [e.from], targets: [e.to] })),
	};
	const res = await elk.layout(graph);
	return (res.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0 }));
}
