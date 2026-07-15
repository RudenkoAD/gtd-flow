import { describe, expect, it } from "vitest";
import type { Task } from "./Task";
import {
	blocked,
	depSatisfied,
	depsMet,
	deriveGtdState,
	eligible,
	isActive,
	ready,
	type ResolveDep,
} from "./gtdState";

const TODAY = "2026-07-15";

let seq = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
	seq += 1;
	return {
		key: `k${seq}`,
		taskId: null,
		filePath: "Notes/misc.md",
		lineStart: seq,
		lineEnd: seq,
		parentLine: null,
		heading: null,
		description: "тестовая задача",
		rawLine: "- [ ] тестовая задача",
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
		tags: [],
		container: "plain",
		projectActive: true,
		...overrides,
	};
}

const noDeps: ResolveDep = () => [];

function resolverFrom(tasks: Task[]): ResolveDep {
	return (id) => tasks.filter((t) => t.taskId === id);
}

describe("deriveGtdState — каждое состояние цепочки", () => {
	it("TEMPLATE: container recurring", () => {
		expect(deriveGtdState(makeTask({ container: "recurring" }), TODAY, noDeps)).toBe("TEMPLATE");
	});

	it("DETAIL: container card", () => {
		expect(deriveGtdState(makeTask({ container: "card" }), TODAY, noDeps)).toBe("DETAIL");
	});

	it("EVENT: container events", () => {
		expect(deriveGtdState(makeTask({ container: "events" }), TODAY, noDeps)).toBe("EVENT");
	});

	it("DONE: x и X", () => {
		expect(deriveGtdState(makeTask({ statusChar: "x" }), TODAY, noDeps)).toBe("DONE");
		expect(deriveGtdState(makeTask({ statusChar: "X" }), TODAY, noDeps)).toBe("DONE");
	});

	it("CANCELLED: '-'", () => {
		expect(deriveGtdState(makeTask({ statusChar: "-" }), TODAY, noDeps)).toBe("CANCELLED");
	});

	it("TICKLER: start > today", () => {
		expect(deriveGtdState(makeTask({ start: "2026-07-16" }), TODAY, noDeps)).toBe("TICKLER");
	});

	it("start == today — уже НЕ tickler (строгое сравнение)", () => {
		expect(deriveGtdState(makeTask({ start: TODAY }), TODAY, noDeps)).toBe("ACTIVE");
	});

	it("WAITING: тег #waiting", () => {
		expect(deriveGtdState(makeTask({ tags: ["#waiting"] }), TODAY, noDeps)).toBe("WAITING");
	});

	it("WAITING: невыполненная ⛔ вне проекта", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " " });
		const t = makeTask({ dependsOn: ["a1"] });
		expect(deriveGtdState(t, TODAY, resolverFrom([dep]))).toBe("WAITING");
	});

	it("BLOCKED: член проекта с невыполненной ⛔", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " ", container: "project" });
		const t = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(deriveGtdState(t, TODAY, resolverFrom([dep]))).toBe("BLOCKED");
	});

	it("DOING: '/'", () => {
		expect(deriveGtdState(makeTask({ statusChar: "/" }), TODAY, noDeps)).toBe("DOING");
	});

	it("ACTIVE: по умолчанию", () => {
		expect(deriveGtdState(makeTask(), TODAY, noDeps)).toBe("ACTIVE");
	});
});

describe("deriveGtdState — конфликты приоритетов цепочки", () => {
	it("шаблон со статусом x — всё равно TEMPLATE", () => {
		const t = makeTask({ container: "recurring", statusChar: "x" });
		expect(deriveGtdState(t, TODAY, noDeps)).toBe("TEMPLATE");
	});

	it("чек-строка карточки со статусом x — всё равно DETAIL", () => {
		const t = makeTask({ container: "card", statusChar: "x" });
		expect(deriveGtdState(t, TODAY, noDeps)).toBe("DETAIL");
	});

	it("DONE побеждает #waiting и будущий start", () => {
		const t = makeTask({ statusChar: "x", tags: ["#waiting"], start: "2026-08-01" });
		expect(deriveGtdState(t, TODAY, noDeps)).toBe("DONE");
	});

	it("CANCELLED побеждает будущий start", () => {
		const t = makeTask({ statusChar: "-", start: "2026-08-01" });
		expect(deriveGtdState(t, TODAY, noDeps)).toBe("CANCELLED");
	});

	it("отложенная задача проекта с невыполненными ⛔ — TICKLER, не BLOCKED", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " ", container: "project" });
		const t = makeTask({
			container: "project",
			dependsOn: ["a1"],
			start: "2026-08-01",
		});
		expect(deriveGtdState(t, TODAY, resolverFrom([dep]))).toBe("TICKLER");
	});

	it("#waiting у члена проекта — WAITING выше BLOCKED", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " " });
		const t = makeTask({ container: "project", dependsOn: ["a1"], tags: ["#waiting"] });
		expect(deriveGtdState(t, TODAY, resolverFrom([dep]))).toBe("WAITING");
	});

	it("'/' с невыполненной ⛔ вне проекта — WAITING выше DOING", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " " });
		const t = makeTask({ statusChar: "/", dependsOn: ["a1"] });
		expect(deriveGtdState(t, TODAY, resolverFrom([dep]))).toBe("WAITING");
	});
});

describe("зависимости — fail-closed", () => {
	it("отсутствующий id ⇒ не выполнена: WAITING вне проекта, BLOCKED в проекте", () => {
		const outside = makeTask({ dependsOn: ["ghost"] });
		const inside = makeTask({ container: "project", dependsOn: ["ghost"] });
		expect(deriveGtdState(outside, TODAY, noDeps)).toBe("WAITING");
		expect(deriveGtdState(inside, TODAY, noDeps)).toBe("BLOCKED");
	});

	it("дубли id: один носитель открыт ⇒ не выполнена (по худшему)", () => {
		const done = makeTask({ taskId: "dup", statusChar: "x" });
		const open = makeTask({ taskId: "dup", statusChar: " " });
		expect(depSatisfied("dup", resolverFrom([done, open]))).toBe(false);
	});

	it("дубли id: все носители закрыты ⇒ выполнена", () => {
		const a = makeTask({ taskId: "dup", statusChar: "x" });
		const b = makeTask({ taskId: "dup", statusChar: "-" });
		expect(depSatisfied("dup", resolverFrom([a, b]))).toBe(true);
	});

	it("CANCELLED-зависимость считается выполненной (отменённое — не ворота)", () => {
		const dep = makeTask({ taskId: "a1", statusChar: "-" });
		const t = makeTask({ container: "project", dependsOn: ["a1"] });
		expect(deriveGtdState(t, TODAY, resolverFrom([dep]))).toBe("ACTIVE");
	});

	it("depsMet: пустой список ⛔ — выполнено вакуумно", () => {
		expect(depsMet(makeTask(), noDeps)).toBe(true);
	});
});

describe("хелперы eligible/ready/blocked/isActive", () => {
	it("eligible: active и без #waiting", () => {
		expect(eligible(makeTask(), TODAY)).toBe(true);
		expect(eligible(makeTask({ tags: ["#waiting"] }), TODAY)).toBe(false);
		expect(eligible(makeTask({ statusChar: "x" }), TODAY)).toBe(false);
		expect(eligible(makeTask({ start: "2026-08-01" }), TODAY)).toBe(false);
		expect(eligible(makeTask({ container: "recurring" }), TODAY)).toBe(false);
	});

	it("isActive исключает TEMPLATE, DETAIL и EVENT", () => {
		expect(isActive(makeTask({ container: "recurring" }), TODAY)).toBe(false);
		expect(isActive(makeTask({ container: "card" }), TODAY)).toBe(false);
		expect(isActive(makeTask({ container: "events" }), TODAY)).toBe(false);
		expect(isActive(makeTask({ container: "project" }), TODAY)).toBe(true);
	});

	it("EVENT побеждает done/tickler: событие со статусом x и 🛫 в будущем — всё равно EVENT", () => {
		const t = makeTask({ container: "events", statusChar: "x", start: "2026-08-01" });
		expect(deriveGtdState(t, TODAY, noDeps)).toBe("EVENT");
	});

	it("ready: eligible + depsMet", () => {
		const dep = makeTask({ taskId: "a1", statusChar: "x" });
		const resolve = resolverFrom([dep]);
		expect(ready(makeTask({ dependsOn: ["a1"] }), TODAY, resolve)).toBe(true);
		expect(ready(makeTask({ dependsOn: ["ghost"] }), TODAY, resolve)).toBe(false);
		expect(ready(makeTask({ dependsOn: ["a1"], tags: ["#waiting"] }), TODAY, resolve)).toBe(false);
	});

	it("blocked: только container project и только при невыполненных ⛔", () => {
		const dep = makeTask({ taskId: "a1", statusChar: " " });
		const resolve = resolverFrom([dep]);
		expect(blocked(makeTask({ container: "project", dependsOn: ["a1"] }), resolve)).toBe(true);
		expect(blocked(makeTask({ container: "plain", dependsOn: ["a1"] }), resolve)).toBe(false);
		expect(blocked(makeTask({ container: "project" }), resolve)).toBe(false);
	});
});
