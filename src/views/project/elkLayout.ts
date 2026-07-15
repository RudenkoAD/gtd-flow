/**
 * Авто-layout графа проекта (ТЗ §7: layered, слева направо).
 * Тонкая обёртка над самописным layeredLayout: elkjs удалён — ~1.4 МБ
 * бандла ради раскладки DAG на 10–100 узлов не окупались. Имя и
 * async-сигнатура сохранены, чтобы не трогать ProjectGraph.svelte.
 */
import type { LayoutEdge, LayoutMove, LayoutNode } from "./layeredLayout";
import { layeredLayout } from "./layeredLayout";

export type ElkInputNode = LayoutNode;
export type ElkInputEdge = LayoutEdge;
export type ElkMove = LayoutMove;

/**
 * Позиции всех узлов после layered-раскладки — готовый батч для
 * ProjectPort.moveNodes (один откатываемый MoveNode за нажатие кнопки).
 */
export async function elkAutoLayout(
	nodes: readonly ElkInputNode[],
	edges: readonly ElkInputEdge[],
): Promise<ElkMove[]> {
	return layeredLayout(nodes, edges);
}
