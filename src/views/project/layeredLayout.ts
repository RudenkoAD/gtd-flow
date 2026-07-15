/**
 * Самописный layered-layout графа проекта (ТЗ §7: слева направо) — замена elkjs.
 * Классическая трёхфазная схема Сугиямы без dummy-узлов: слои по длиннейшему
 * пути от корней, порядок внутри слоя — barycenter-эвристика, координаты —
 * простое штабелирование с вертикальным центрированием слоёв. Для DAG
 * GTD-масштаба (10–100 узлов) этого достаточно; идеальная минимизация
 * пересечений не нужна.
 */

export interface LayoutNode {
	id: string;
	/** Реальные размеры узла из Svelte Flow (measured); без них — дефолт. */
	width?: number;
	height?: number;
}

export interface LayoutEdge {
	from: string;
	to: string;
}

export interface LayoutMove {
	id: string;
	x: number;
	y: number;
}

const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 80;
/** Отступы прежнего elk-конфига — визуальная преемственность:
 *  40 между узлами внутри слоя, 80 между слоями. */
const NODE_GAP = 40;
const LAYER_GAP = 80;
/** Проходы barycenter: вниз → вверх → вниз. Больше — почти не улучшает. */
const BARYCENTER_PASSES = 3;

/**
 * Позиции всех узлов после layered-раскладки. Чистая синхронная функция:
 * одинаковый вход ⇒ одинаковый выход (все сортировки стабильны, tie-break —
 * исходный порядок узлов). Порядок результата = порядок входа.
 */
export function layeredLayout(
	nodes: readonly LayoutNode[],
	edges: readonly LayoutEdge[],
): LayoutMove[] {
	if (nodes.length === 0) return [];

	// Дубли id схлопываем в первого носителя (Svelte Flow требует уникальность,
	// но раскладка не должна падать на грязном входе)
	const uniq: LayoutNode[] = [];
	const known = new Set<string>();
	for (const n of nodes) {
		if (known.has(n.id)) continue;
		known.add(n.id);
		uniq.push(n);
	}

	// Рёбра на узлы вне набора и петли отбрасываем — на слои они не влияют
	const outAdj = new Map<string, string[]>();
	const inAdj = new Map<string, string[]>();
	for (const n of uniq) {
		outAdj.set(n.id, []);
		inAdj.set(n.id, []);
	}
	for (const e of edges) {
		if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue;
		outAdj.get(e.from)!.push(e.to);
		inAdj.get(e.to)!.push(e.from);
	}

	// --- (1) слой = длиннейший путь от корней (Kahn); узлы в циклах остаются
	// на слое 0 — как depth в graphEngine: не падаем, рисуем что можем ---
	const layerOf = new Map<string, number>();
	const indeg = new Map<string, number>();
	const queue: string[] = [];
	for (const n of uniq) {
		const deg = inAdj.get(n.id)!.length;
		indeg.set(n.id, deg);
		if (deg === 0) {
			queue.push(n.id);
			layerOf.set(n.id, 0);
		}
	}
	for (let qi = 0; qi < queue.length; qi++) {
		const cur = queue[qi]!;
		const d = layerOf.get(cur) ?? 0;
		for (const next of outAdj.get(cur) ?? []) {
			layerOf.set(next, Math.max(layerOf.get(next) ?? 0, d + 1));
			const rem = (indeg.get(next) ?? 1) - 1;
			indeg.set(next, rem);
			if (rem === 0) queue.push(next);
		}
	}

	// Слои дырок не имеют: узел слоя l>0 получил его от предшественника на l-1
	const layers: LayoutNode[][] = [];
	for (const n of uniq) {
		const l = layerOf.get(n.id) ?? 0;
		(layers[l] ??= []).push(n);
	}
	for (let i = 0; i < layers.length; i++) layers[i] ??= [];

	// --- (2) порядок внутри слоя: barycenter-эвристика ---
	// Позиция узла внутри слоя; соседи из НЕсмежных слоёв (рёбра через слой)
	// тоже участвуют — без dummy-узлов это разумное приближение
	const pos = new Map<string, number>();
	const reindex = (layer: LayoutNode[]): void => {
		layer.forEach((n, i) => pos.set(n.id, i));
	};
	for (const layer of layers) reindex(layer);

	const sortByBarycenter = (layer: LayoutNode[], adj: Map<string, string[]>): void => {
		const bary = new Map<string, number>();
		for (const n of layer) {
			const nb = adj.get(n.id) ?? [];
			if (nb.length === 0) {
				// без соседей — стоим на месте (barycenter = своя позиция)
				bary.set(n.id, pos.get(n.id) ?? 0);
				continue;
			}
			let sum = 0;
			for (const v of nb) sum += pos.get(v) ?? 0;
			bary.set(n.id, sum / nb.length);
		}
		// Array.sort стабилен: при равных barycenter прежний порядок сохраняется
		layer.sort((a, b) => (bary.get(a.id) ?? 0) - (bary.get(b.id) ?? 0));
		reindex(layer);
	};

	for (let pass = 0; pass < BARYCENTER_PASSES; pass++) {
		if (pass % 2 === 0) {
			// вниз: слой упорядочиваем по предшественникам
			for (let l = 1; l < layers.length; l++) sortByBarycenter(layers[l]!, inAdj);
		} else {
			// вверх: по потомкам
			for (let l = layers.length - 2; l >= 0; l--) sortByBarycenter(layers[l]!, outAdj);
		}
	}

	// --- (3) координаты: слои слева направо, внутри слоя — штабель сверху вниз,
	// каждый слой вертикально центрирован относительно самого высокого ---
	const w = (n: LayoutNode): number => n.width ?? DEFAULT_WIDTH;
	const h = (n: LayoutNode): number => n.height ?? DEFAULT_HEIGHT;
	const layerHeight = (layer: LayoutNode[]): number =>
		layer.reduce((acc, n) => acc + h(n), 0) + Math.max(0, layer.length - 1) * NODE_GAP;
	const maxHeight = Math.max(...layers.map(layerHeight));

	const moveById = new Map<string, LayoutMove>();
	let x = 0;
	for (const layer of layers) {
		let y = (maxHeight - layerHeight(layer)) / 2;
		let maxW = 0;
		for (const n of layer) {
			moveById.set(n.id, { id: n.id, x, y });
			y += h(n) + NODE_GAP;
			if (w(n) > maxW) maxW = w(n);
		}
		x += (layer.length > 0 ? maxW : DEFAULT_WIDTH) + LAYER_GAP;
	}
	return uniq.map((n) => moveById.get(n.id)!);
}
