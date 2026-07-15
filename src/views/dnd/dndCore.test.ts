import { describe, expect, it } from "vitest";
import {
	DragStateMachine,
	LONG_PRESS_MS,
	MOUSE_DRAG_THRESHOLD_PX,
	SCROLL_MAX_STEP_PX,
	TOUCH_SLOP_PX,
	edgeScrollDelta,
	hitTest,
	insertIndexByY,
	rectContains,
	type FlatRect,
} from "./dndCore";

function rect(left: number, top: number, right: number, bottom: number): FlatRect {
	return { left, top, right, bottom };
}

describe("rectContains", () => {
	const r = rect(10, 20, 110, 220);

	it("точка внутри", () => {
		expect(rectContains(r, 50, 100)).toBe(true);
	});

	it("левый/верхний край — внутри, правый/нижний — снаружи", () => {
		expect(rectContains(r, 10, 20)).toBe(true);
		expect(rectContains(r, 110, 100)).toBe(false);
		expect(rectContains(r, 50, 220)).toBe(false);
	});

	it("точка вне", () => {
		expect(rectContains(r, 9, 100)).toBe(false);
		expect(rectContains(r, 50, 19)).toBe(false);
	});
});

describe("hitTest", () => {
	it("пустой реестр — null", () => {
		expect(hitTest([], 5, 5)).toBeNull();
	});

	it("одиночная цель: попадание и промах", () => {
		const boxes = [{ id: "a", rect: rect(0, 0, 100, 100) }];
		expect(hitTest(boxes, 50, 50)).toBe("a");
		expect(hitTest(boxes, 150, 50)).toBeNull();
	});

	it("перекрытие: последняя зарегистрированная (верхняя) побеждает", () => {
		const boxes = [
			{ id: "under", rect: rect(0, 0, 100, 100) },
			{ id: "over", rect: rect(40, 40, 60, 60) },
		];
		expect(hitTest(boxes, 50, 50)).toBe("over");
		expect(hitTest(boxes, 10, 10)).toBe("under");
	});

	it("смежные колонки не пересекаются: right исключающий", () => {
		const boxes = [
			{ id: "col1", rect: rect(0, 0, 100, 100) },
			{ id: "col2", rect: rect(100, 0, 200, 100) },
		];
		expect(hitTest(boxes, 100, 50)).toBe("col2");
		expect(hitTest(boxes, 99.9, 50)).toBe("col1");
	});
});

describe("insertIndexByY", () => {
	// три карточки по 40px: середины на 20, 70, 120
	const items = [rect(0, 0, 100, 40), rect(0, 50, 100, 90), rect(0, 100, 100, 140)];

	it("пустой список — 0", () => {
		expect(insertIndexByY([], 55)).toBe(0);
	});

	it("выше середины первого — 0", () => {
		expect(insertIndexByY(items, 5)).toBe(0);
		expect(insertIndexByY(items, 19)).toBe(0);
	});

	it("между серединами — индекс между элементами", () => {
		expect(insertIndexByY(items, 21)).toBe(1);
		expect(insertIndexByY(items, 69)).toBe(1);
		expect(insertIndexByY(items, 71)).toBe(2);
	});

	it("ниже середины последнего — length", () => {
		expect(insertIndexByY(items, 121)).toBe(3);
		expect(insertIndexByY(items, 999)).toBe(3);
	});

	it("ровно на середине — после элемента", () => {
		expect(insertIndexByY(items, 20)).toBe(1);
	});
});

describe("edgeScrollDelta", () => {
	const r = rect(0, 0, 400, 300);

	it("в центре — ноль", () => {
		expect(edgeScrollDelta(r, 200, 150)).toEqual({ dx: 0, dy: 0 });
	});

	it("вне контейнера — ноль", () => {
		expect(edgeScrollDelta(r, -5, 150)).toEqual({ dx: 0, dy: 0 });
		expect(edgeScrollDelta(r, 200, 300)).toEqual({ dx: 0, dy: 0 });
	});

	it("вплотную к краям — полный шаг в сторону края", () => {
		expect(edgeScrollDelta(r, 0, 150).dx).toBe(-SCROLL_MAX_STEP_PX);
		expect(edgeScrollDelta(r, 399.999, 150).dx).toBe(SCROLL_MAX_STEP_PX);
		expect(edgeScrollDelta(r, 200, 0).dy).toBe(-SCROLL_MAX_STEP_PX);
		expect(edgeScrollDelta(r, 200, 299.999).dy).toBe(SCROLL_MAX_STEP_PX);
	});

	it("на границе 40px-зоны — ноль, внутри зоны — ненулевой линейный разгон", () => {
		expect(edgeScrollDelta(r, 40, 150).dx).toBe(0);
		// на полпути в зону: половина шага (ceil от 8)
		expect(edgeScrollDelta(r, 20, 150).dx).toBe(-8);
		// у самой границы зоны шаг всё ещё ненулевой (ceil)
		expect(edgeScrollDelta(r, 39, 150).dx).toBeLessThan(0);
	});

	it("углы: обе оси сразу", () => {
		const d = edgeScrollDelta(r, 1, 1);
		expect(d.dx).toBeLessThan(0);
		expect(d.dy).toBeLessThan(0);
	});
});

describe("DragStateMachine: мышь", () => {
	it("идёт в dragging только после порога 5px", () => {
		const m = new DragStateMachine();
		m.down(100, 100, false, 0);
		expect(m.phase).toBe("pending");
		expect(m.move(103, 100, 10)).toBe("none"); // 3px < 5
		expect(m.phase).toBe("pending");
		expect(m.move(100 + MOUSE_DRAG_THRESHOLD_PX, 100, 20)).toBe("activated");
		expect(m.phase).toBe("dragging");
	});

	it("порог считается по диагонали (гипотенузе)", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		expect(m.move(3, 3, 10)).toBe("none"); // ~4.24px
		expect(m.move(4, 4, 20)).toBe("activated"); // ~5.66px
	});

	it("up без движения — клик (cancelled), не drop", () => {
		const m = new DragStateMachine();
		m.down(100, 100, false, 0);
		expect(m.up()).toBe("cancelled");
		expect(m.phase).toBe("idle");
	});

	it("полный цикл: down → move → up = dropped", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		m.move(10, 0, 10);
		expect(m.up()).toBe("dropped");
		expect(m.phase).toBe("idle");
	});

	it("move в dragging — none (ведение ghost вне автомата)", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		m.move(10, 0, 10);
		expect(m.move(50, 50, 20)).toBe("none");
		expect(m.phase).toBe("dragging");
	});

	it("longPress для мыши игнорируется", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		expect(m.longPress(1000)).toBe("none");
		expect(m.phase).toBe("pending");
	});
});

describe("DragStateMachine: тач", () => {
	it("смещение ≥ 10px до таймера — жест отдан скроллу", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 0);
		expect(m.move(100, 100 + TOUCH_SLOP_PX, 50)).toBe("cancelled");
		expect(m.phase).toBe("idle");
	});

	it("дрожание в пределах слопа не активирует и не отменяет", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 0);
		expect(m.move(104, 103, 50)).toBe("none");
		expect(m.move(97, 99, 100)).toBe("none");
		expect(m.phase).toBe("pending");
	});

	it("long-press через 250мс активирует drag", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 1000);
		m.move(103, 100, 1100);
		expect(m.longPress(1000 + LONG_PRESS_MS)).toBe("activated");
		expect(m.phase).toBe("dragging");
	});

	it("long-press раньше 250мс — none, жест остаётся pending", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 1000);
		expect(m.longPress(1100)).toBe("none");
		expect(m.phase).toBe("pending");
	});

	it("up до таймера — тап (cancelled)", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 0);
		expect(m.up()).toBe("cancelled");
	});

	it("после активации отпускание — dropped", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 0);
		m.longPress(LONG_PRESS_MS);
		expect(m.up()).toBe("dropped");
	});

	it("longPress после cancel (скролл победил) — none", () => {
		const m = new DragStateMachine();
		m.down(100, 100, true, 0);
		m.move(150, 100, 50);
		expect(m.longPress(LONG_PRESS_MS)).toBe("none");
		expect(m.phase).toBe("idle");
	});
});

describe("DragStateMachine: cancel и повторные жесты", () => {
	it("Escape в dragging — cancelled → idle", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		m.move(10, 0, 10);
		expect(m.cancel()).toBe("cancelled");
		expect(m.phase).toBe("idle");
	});

	it("cancel в idle — none", () => {
		const m = new DragStateMachine();
		expect(m.cancel()).toBe("none");
	});

	it("up в idle — none", () => {
		const m = new DragStateMachine();
		expect(m.up()).toBe("none");
	});

	it("повторный down при потерянном pointerup — свежий pending с новой точкой отсчёта", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		m.move(10, 0, 10); // dragging
		m.down(500, 500, true, 2000);
		expect(m.phase).toBe("pending");
		expect(m.isTouch).toBe(true);
		// порог меряется от новой точки
		expect(m.move(500, 505, 2050)).toBe("none");
		expect(m.longPress(2000 + LONG_PRESS_MS)).toBe("activated");
	});

	it("после cancel автомат пригоден для нового жеста", () => {
		const m = new DragStateMachine();
		m.down(0, 0, false, 0);
		m.move(10, 0, 10);
		m.cancel();
		m.down(0, 0, false, 100);
		expect(m.move(10, 0, 110)).toBe("activated");
		expect(m.up()).toBe("dropped");
	});
});
