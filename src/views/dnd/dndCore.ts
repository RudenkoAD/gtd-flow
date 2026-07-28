/**
 * Чистая математика DnD-слоя (ТЗ §8): hit-тест по плоским rect'ам,
 * конечный автомат жеста и вставка по вертикали. Ни DOM, ни obsidian —
 * тестируется в node; DndService подаёт сюда числа из PointerEvent/rect.
 */

export interface FlatRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface HitBox<T> {
	id: T;
	rect: FlatRect;
}

/** Правый/нижний край — исключающие: смежные колонки не пересекаются. */
export function rectContains(r: FlatRect, x: number, y: number): boolean {
	return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

/**
 * Верхняя цель под точкой. Порядок в массиве = порядок регистрации,
 * последняя зарегистрированная считается верхней (вложенные цели
 * регистрируются после родительских — монтирование идёт сверху вниз).
 */
export function hitTest<T>(boxes: readonly HitBox<T>[], x: number, y: number): T | null {
	for (let i = boxes.length - 1; i >= 0; i--) {
		const b = boxes[i]!;
		if (rectContains(b.rect, x, y)) return b.id;
	}
	return null;
}

/**
 * Индекс вставки в вертикальном списке: до первого элемента, чья середина
 * ниже y. Ровно на середине — после элемента. Rect'ы — в порядке сверху вниз.
 */
export function insertIndexByY(itemRects: readonly FlatRect[], y: number): number {
	for (let i = 0; i < itemRects.length; i++) {
		const r = itemRects[i]!;
		if (y < (r.top + r.bottom) / 2) return i;
	}
	return itemRects.length;
}

// --- автоскролл у краёв ---

export const SCROLL_EDGE_PX = 40;
export const SCROLL_MAX_STEP_PX = 16;

/**
 * Скорость автоскролла контейнера: линейный разгон от 0 на границе
 * 40px-зоны до maxStep вплотную к краю. Вне rect — ноль (курсор ушёл
 * с контейнера). Узкий контейнер (< 2*edge): зоны перекрываются и
 * частично гасят друг друга — это осознанно, дёрганья нет.
 */
export function edgeScrollDelta(
	rect: FlatRect,
	x: number,
	y: number,
	edge = SCROLL_EDGE_PX,
	maxStep = SCROLL_MAX_STEP_PX,
): { dx: number; dy: number } {
	if (!rectContains(rect, x, y)) return { dx: 0, dy: 0 };
	// ceil: внутри зоны шаг всегда ненулевой, иначе у самой границы скролл замирает
	const ramp = (dist: number): number =>
		dist >= edge ? 0 : Math.ceil(((edge - dist) / edge) * maxStep);
	return {
		dx: ramp(rect.right - x) - ramp(x - rect.left),
		dy: ramp(rect.bottom - y) - ramp(y - rect.top),
	};
}

// --- конечный автомат жеста ---

export const MOUSE_DRAG_THRESHOLD_PX = 5;
export const TOUCH_SLOP_PX = 10;
export const LONG_PRESS_MS = 250;

export type DragPhase = "idle" | "pending" | "dragging";

/** Ответ автомата на событие: что должен сделать вызывающий слой. */
export type DragSignal = "none" | "activated" | "cancelled" | "dropped";

/**
 * idle → pending (down) → dragging (порог/long-press) → idle (drop/cancel).
 *
 * Мышь/перо: dragging после смещения ≥ 5px; отпустили раньше — клик.
 * Тач: long-press 250мс при смещении < 10px (таймер — забота вызывающего:
 * setTimeout(LONG_PRESS_MS) → longPress(now)); смещение ≥ 10px до таймера —
 * жест отдан нативному скроллу (cancelled).
 */
export class DragStateMachine {
	private _phase: DragPhase = "idle";
	private touch = false;
	private x0 = 0;
	private y0 = 0;
	private t0 = 0;

	get phase(): DragPhase {
		return this._phase;
	}

	get isTouch(): boolean {
		return this.touch;
	}

	/** pointerdown. Повторный down при незавершённом жесте (потерян pointerup) — сброс в новый pending. */
	down(x: number, y: number, touch: boolean, now: number): void {
		this._phase = "pending";
		this.touch = touch;
		this.x0 = x;
		this.y0 = y;
		this.t0 = now;
	}

	/** pointermove. Сигналы возможны только в pending; в dragging ведение ghost — забота вызывающего. */
	move(x: number, y: number, _now: number): DragSignal {
		if (this._phase !== "pending") return "none";
		const dist = Math.hypot(x - this.x0, y - this.y0);
		if (this.touch) {
			if (dist >= TOUCH_SLOP_PX) {
				this._phase = "idle";
				return "cancelled";
			}
			return "none"; // в пределах слопа ждём таймер long-press
		}
		if (dist >= MOUSE_DRAG_THRESHOLD_PX) {
			this._phase = "dragging";
			return "activated";
		}
		return "none";
	}

	/** Сработал таймер long-press. Только тач и только если жест ещё pending. */
	longPress(now: number): DragSignal {
		if (this._phase !== "pending" || !this.touch) return "none";
		if (now - this.t0 < LONG_PRESS_MS) return "none";
		this._phase = "dragging";
		return "activated";
	}

	/** pointerup: из dragging — drop, из pending — обычный клик/тап. */
	up(): DragSignal {
		const was = this._phase;
		this._phase = "idle";
		if (was === "dragging") return "dropped";
		if (was === "pending") return "cancelled";
		return "none";
	}

	/** Escape / pointercancel / размонтирование окна. */
	cancel(): DragSignal {
		if (this._phase === "idle") return "none";
		this._phase = "idle";
		return "cancelled";
	}
}
