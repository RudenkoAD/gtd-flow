/**
 * Вывод GTD-состояния — цепочка ТЗ §1, по убыванию приоритета:
 * TEMPLATE > DETAIL > DONE > CANCELLED > TICKLER > WAITING > BLOCKED > DOING > ACTIVE.
 *
 * Состояние НЕ хранится — чистая функция от (Task, today, resolveDep).
 */
import type { GtdState, IsoDate, Task } from "./Task";

/** Возвращает ВСЕХ носителей 🆔 (byId мультизначен: дубли id — реальный кейс после синка). */
export type ResolveDep = (id: string) => Task[];

export function isDone(t: Task): boolean {
	return t.statusChar === "x" || t.statusChar === "X";
}

export function isCancelled(t: Task): boolean {
	return t.statusChar === "-";
}

/** 🛫 в будущем. Строгое `>`: start == today — уже НЕ отложена. */
export function isDeferred(t: Task, today: IsoDate): boolean {
	return t.start !== null && t.start > today;
}

export function isTemplate(t: Task): boolean {
	return t.container === "recurring";
}

export function isDetail(t: Task): boolean {
	return t.container === "card";
}

/** active = !done && !cancelled && !deferred && !TEMPLATE && !DETAIL (§1). */
export function isActive(t: Task, today: IsoDate): boolean {
	return !isDone(t) && !isCancelled(t) && !isDeferred(t, today) && !isTemplate(t) && !isDetail(t);
}

const WAITING_TAG = "#waiting";

/** Точное совпадение: вложенные теги (#waiting/кто-то) — не WAITING. */
export function hasWaitingTag(t: Task): boolean {
	return t.tags.includes(WAITING_TAG);
}

export function eligible(t: Task, today: IsoDate): boolean {
	return isActive(t, today) && !hasWaitingTag(t);
}

/**
 * Зависимость выполнена ⇔ носители id существуют И у ВСЕХ статус ∈ {x,X,-}.
 * Fail-closed: отсутствующий id ⇒ false; при дублях id считаем по худшему носителю.
 * CANCELLED = выполнена (отменённое — не ворота).
 */
export function depSatisfied(id: string, resolveDep: ResolveDep): boolean {
	const carriers = resolveDep(id);
	if (carriers.length === 0) return false;
	return carriers.every((c) => isDone(c) || isCancelled(c));
}

export function depsMet(t: Task, resolveDep: ResolveDep): boolean {
	return t.dependsOn.every((d) => depSatisfied(d, resolveDep));
}

export function ready(t: Task, today: IsoDate, resolveDep: ResolveDep): boolean {
	return eligible(t, today) && depsMet(t, resolveDep);
}

/**
 * Член проекта с невыполненными ⛔ (строка BLOCKED цепочки §1).
 * Приоритеты выше по цепочке (DONE, TICKLER…) здесь НЕ применяются —
 * это забота deriveGtdState; graphEngine использует хелпер как есть.
 */
export function blocked(t: Task, resolveDep: ResolveDep): boolean {
	return t.container === "project" && !depsMet(t, resolveDep);
}

export function deriveGtdState(task: Task, today: IsoDate, resolveDep: ResolveDep): GtdState {
	if (isTemplate(task)) return "TEMPLATE";
	if (isDetail(task)) return "DETAIL";
	if (isDone(task)) return "DONE";
	if (isCancelled(task)) return "CANCELLED";
	// 🛫 в будущем побеждает и готовность, и блокировку (TICKLER выше BLOCKED)
	if (isDeferred(task, today)) return "TICKLER";
	if (hasWaitingTag(task)) return "WAITING";
	if (!depsMet(task, resolveDep)) {
		// невыполненные ⛔: в проекте — BLOCKED (виден только в виде проекта), вне — WAITING
		return task.container === "project" ? "BLOCKED" : "WAITING";
	}
	if (task.statusChar === "/") return "DOING";
	return "ACTIVE";
}
