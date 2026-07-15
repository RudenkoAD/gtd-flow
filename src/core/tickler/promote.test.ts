import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ContainerKind, Task } from "../model/Task";
import type { ResolveDep } from "../model/gtdState";
import { partition } from "./promote";

const TODAY = "2026-07-15";
const noDeps: ResolveDep = () => [];

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

describe("partition — классификация", () => {
	it("раскладывает по корзинам active/deferred/done", () => {
		const active = makeTask();
		const doing = makeTask({ statusChar: "/" });
		const waiting = makeTask({ tags: ["#waiting"] });
		const deferred = makeTask({ start: "2026-08-01" });
		const done = makeTask({ statusChar: "x" });
		const cancelled = makeTask({ statusChar: "-" });
		const p = partition([active, doing, waiting, deferred, done, cancelled], TODAY, noDeps);
		expect(p.active.map((t) => t.key)).toEqual([active.key, doing.key, waiting.key]);
		expect(p.deferred.map((t) => t.key)).toEqual([deferred.key]);
		expect(p.done.map((t) => t.key)).toEqual([done.key, cancelled.key]);
	});

	it("start == today — уже active, не deferred", () => {
		const t = makeTask({ start: TODAY });
		const p = partition([t], TODAY, noDeps);
		expect(p.active.map((x) => x.key)).toEqual([t.key]);
		expect(p.deferred).toEqual([]);
	});

	it("done с будущим start — в done (DONE выше TICKLER)", () => {
		const t = makeTask({ statusChar: "x", start: "2026-08-01" });
		const p = partition([t], TODAY, noDeps);
		expect(p.done.map((x) => x.key)).toEqual([t.key]);
	});

	it("TEMPLATE и DETAIL не попадают ни в одну корзину", () => {
		const template = makeTask({ container: "recurring" });
		const detail = makeTask({ container: "card" });
		const p = partition([template, detail], TODAY, noDeps);
		expect(p.active).toEqual([]);
		expect(p.deferred).toEqual([]);
		expect(p.done).toEqual([]);
	});
});

describe("partition — идемпотентность", () => {
	it("повторное разбиение объединения корзин даёт тот же результат", () => {
		const tasks = [
			makeTask(),
			makeTask({ start: "2026-08-01" }),
			makeTask({ statusChar: "x" }),
			makeTask({ statusChar: "/" }),
			makeTask({ statusChar: "-" }),
		];
		const p1 = partition(tasks, TODAY, noDeps);
		const p2 = partition([...p1.active, ...p1.deferred, ...p1.done], TODAY, noDeps);
		expect(p2).toEqual(p1);
	});

	it("property: корзины дизъюнктны, полны (минус TEMPLATE/DETAIL) и стабильны при повторе", () => {
		const containerArb = fc.constantFrom<ContainerKind>(
			"plain",
			"board",
			"project",
			"recurring",
			"card",
		);
		const taskArb = fc
			.record({
				statusChar: fc.constantFrom(" ", "x", "X", "-", "/"),
				start: fc.option(
					fc.constantFrom("2026-07-01", "2026-07-15", "2026-07-16", "2026-08-30"),
					{ nil: null },
				),
				container: containerArb,
				tags: fc.constantFrom<string[]>([], ["#waiting"]),
			})
			.map((o) => makeTask({ statusChar: o.statusChar, start: o.start, container: o.container, tags: o.tags }));

		fc.assert(
			fc.property(fc.array(taskArb, { maxLength: 40 }), (tasks) => {
				const p1 = partition(tasks, TODAY, noDeps);
				const total = p1.active.length + p1.deferred.length + p1.done.length;
				const invisible = tasks.filter(
					(t) => t.container === "recurring" || t.container === "card",
				).length;
				expect(total).toBe(tasks.length - invisible);

				// идемпотентность: двойное применение == одинарное
				const p2 = partition([...p1.active, ...p1.deferred, ...p1.done], TODAY, noDeps);
				expect(p2).toEqual(p1);
			}),
		);
	});
});
