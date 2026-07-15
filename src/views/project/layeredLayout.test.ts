import { describe, expect, it } from "vitest";
import type { LayoutEdge, LayoutMove, LayoutNode } from "./layeredLayout";
import { layeredLayout } from "./layeredLayout";

// Дефолтные размеры узла (совпадают с константами модуля): 240x80,
// отступы 40 внутри слоя / 80 между слоями ⇒ шаг слоя 320, шаг штабеля 120.
const STEP_X = 240 + 80;
const STEP_Y = 80 + 40;

function node(id: string, over: Partial<LayoutNode> = {}): LayoutNode {
	return { id, ...over };
}

function edge(from: string, to: string): LayoutEdge {
	return { from, to };
}

function byId(moves: LayoutMove[]): Map<string, LayoutMove> {
	return new Map(moves.map((m) => [m.id, m]));
}

/** Пересечения рёбер между парами слоёв (одинаковые x концов). */
function countCrossings(moves: LayoutMove[], edges: readonly LayoutEdge[]): number {
	const m = byId(moves);
	let count = 0;
	for (let i = 0; i < edges.length; i++) {
		for (let j = i + 1; j < edges.length; j++) {
			const a1 = m.get(edges[i]!.from)!;
			const b1 = m.get(edges[i]!.to)!;
			const a2 = m.get(edges[j]!.from)!;
			const b2 = m.get(edges[j]!.to)!;
			if (a1.x !== a2.x || b1.x !== b2.x) continue;
			if (Math.sign(a1.y - a2.y) * Math.sign(b1.y - b2.y) < 0) count++;
		}
	}
	return count;
}

describe("layeredLayout", () => {
	it("пустой вход — пустой результат", () => {
		expect(layeredLayout([], [])).toEqual([]);
	});

	it("цепочка: все узлы в ряд слева направо, одинаковый y", () => {
		const moves = byId(
			layeredLayout(
				[node("a"), node("b"), node("c")],
				[edge("a", "b"), edge("b", "c")],
			),
		);
		expect(moves.get("a")).toEqual({ id: "a", x: 0, y: 0 });
		expect(moves.get("b")).toEqual({ id: "b", x: STEP_X, y: 0 });
		expect(moves.get("c")).toEqual({ id: "c", x: 2 * STEP_X, y: 0 });
	});

	it("алмаз: b и c в одном слое, a и d центрированы по вертикали", () => {
		const moves = byId(
			layeredLayout(
				[node("a"), node("b"), node("c"), node("d")],
				[edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
			),
		);
		const [a, b, c, d] = [moves.get("a")!, moves.get("b")!, moves.get("c")!, moves.get("d")!];
		expect(a.x).toBe(0);
		expect(b.x).toBe(STEP_X);
		expect(c.x).toBe(STEP_X); // один слой
		expect(d.x).toBe(2 * STEP_X);
		// слой [b, c] — самый высокий (80+40+80=200); a и d по его середине
		expect(b.y).toBe(0);
		expect(c.y).toBe(STEP_Y);
		expect(a.y).toBe((200 - 80) / 2);
		expect(d.y).toBe(a.y);
	});

	it("два независимых подграфа не перекрываются", () => {
		const moves = layeredLayout(
			[node("a"), node("b"), node("c"), node("d")],
			[edge("a", "b"), edge("c", "d")],
		);
		// в одном слое штабель без наложений: расстояние >= высота узла
		for (const m1 of moves) {
			for (const m2 of moves) {
				if (m1.id === m2.id || m1.x !== m2.x) continue;
				expect(Math.abs(m1.y - m2.y)).toBeGreaterThanOrEqual(80);
			}
		}
	});

	it("ghost-узел получает слой; рёбра на неизвестные id игнорируются", () => {
		// ghost — обычный узел набора (корень-зависимость из другого файла)
		const moves = byId(
			layeredLayout(
				[node("ghost"), node("a")],
				[edge("ghost", "a"), edge("missing", "a"), edge("a", "missing")],
			),
		);
		expect(moves.get("ghost")).toEqual({ id: "ghost", x: 0, y: 0 });
		expect(moves.get("a")!.x).toBe(STEP_X);
		expect(moves.size).toBe(2);
	});

	it("barycenter уменьшает пересечения против исходного порядка", () => {
		// три ребра «наперекрёст»: в исходном порядке слоёв — 3 пересечения
		const nodes = [node("a"), node("b"), node("c"), node("d"), node("e"), node("f")];
		const edges = [edge("a", "f"), edge("b", "e"), edge("c", "d")];
		// naive: слои в исходном порядке (тот же штабель, без barycenter)
		const naive: LayoutMove[] = [
			{ id: "a", x: 0, y: 0 },
			{ id: "b", x: 0, y: STEP_Y },
			{ id: "c", x: 0, y: 2 * STEP_Y },
			{ id: "d", x: STEP_X, y: 0 },
			{ id: "e", x: STEP_X, y: STEP_Y },
			{ id: "f", x: STEP_X, y: 2 * STEP_Y },
		];
		const naiveCrossings = countCrossings(naive, edges);
		expect(naiveCrossings).toBe(3);
		const moves = layeredLayout(nodes, edges);
		expect(countCrossings(moves, edges)).toBeLessThan(naiveCrossings);
		expect(countCrossings(moves, edges)).toBe(0);
	});

	it("стабильность: два вызова дают одинаковый результат", () => {
		const nodes = [node("a"), node("b"), node("c"), node("d"), node("e")];
		const edges = [edge("a", "c"), edge("b", "c"), edge("c", "d"), edge("c", "e")];
		expect(layeredLayout(nodes, edges)).toEqual(layeredLayout(nodes, edges));
	});

	it("реальные размеры узлов учитываются в шаге слоя и штабеля", () => {
		const moves = byId(
			layeredLayout(
				[node("a", { width: 300, height: 100 }), node("b"), node("c", { height: 60 })],
				[edge("a", "b"), edge("a", "c")],
			),
		);
		// шаг слоя = max ширина слоя 0 (300) + 80
		expect(moves.get("b")!.x).toBe(380);
		// штабель слоя 1: b (80) + 40 + c (60) = 180 > 100 ⇒ высокий слой — первый... нет:
		// слой 1 выше (180 против 100), значит a центрируется: (180-100)/2 = 40
		expect(moves.get("a")!.y).toBe(40);
		expect(moves.get("b")!.y).toBe(0);
		expect(moves.get("c")!.y).toBe(120);
	});

	it("цикл не роняет раскладку: все узлы получают позиции", () => {
		const moves = layeredLayout(
			[node("a"), node("b")],
			[edge("a", "b"), edge("b", "a")],
		);
		expect(moves).toHaveLength(2);
		// оба остаются на слое 0 (как depth в graphEngine), штабелем без наложения
		expect(moves[0]!.x).toBe(moves[1]!.x);
		expect(Math.abs(moves[0]!.y - moves[1]!.y)).toBe(STEP_Y);
	});
});
