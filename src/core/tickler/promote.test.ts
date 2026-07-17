import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ContainerKind, Task } from "../model/Task";
import type { ResolveDep } from "../model/gtdState";
import { partition, planPromotions } from "./promote";

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
		dueTimeEnd: null,
		scheduledTimeEnd: null,
		startTimeEnd: null,
		recurrence: null,
		nextSpawn: null,
		spawnedFrom: null,
		priority: "none",
		dependsOn: [],
		excludedDates: [],
		location: null,
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

describe("planPromotions — отбор кандидатов на всплытие во входящие", () => {
	const PAST = "2026-07-10"; // < TODAY
	const FUTURE = "2026-08-01"; // > TODAY

	it("будущая 🛫 (ещё отложена) — не кандидат", () => {
		const t = makeTask({ start: FUTURE });
		expect(planPromotions([t], TODAY, { includePlain: true, since: null })).toEqual([]);
	});

	it("нет 🛫 — не кандидат", () => {
		const t = makeTask({ start: null });
		expect(planPromotions([t], TODAY, { includePlain: false, since: null })).toEqual([]);
	});

	it("start == today — наступила, кандидат (строгое > держит в тикле)", () => {
		const t = makeTask({ start: TODAY });
		const plan = planPromotions([t], TODAY, { includePlain: true, since: null });
		expect(plan.map((p) => p.task.key)).toEqual([t.key]);
	});

	it("done/cancelled с прошедшей 🛫 — не кандидаты", () => {
		const done = makeTask({ start: PAST, statusChar: "x" });
		const cancelled = makeTask({ start: PAST, statusChar: "-" });
		expect(planPromotions([done, cancelled], TODAY, { includePlain: false, since: null })).toEqual([]);
	});

	it("контейнеры вне тикля (recurring/card/events/archive) не всплывают", () => {
		const tasks = (["recurring", "card", "events", "archive"] as ContainerKind[]).map((c) =>
			makeTask({ start: PAST, container: c }),
		);
		expect(planPromotions(tasks, TODAY, { includePlain: false, since: null })).toEqual([]);
	});

	it("board с прошедшей 🛫 — needsMove + снятие тегов колонок", () => {
		const t = makeTask({
			start: PAST,
			container: "board",
			tags: ["#kanban/work/todo", "#project/x"],
		});
		const plan = planPromotions([t], TODAY, { includePlain: true, since: null });
		expect(plan).toHaveLength(1);
		expect(plan[0]!.needsMove).toBe(true);
		expect(plan[0]!.stripTags).toEqual(["#kanban/work/todo"]); // только теги досок
	});

	it("plain при includePlain=false — needsMove (иначе не попадёт во входящие)", () => {
		const t = makeTask({ start: PAST, container: "plain" });
		const plan = planPromotions([t], TODAY, { includePlain: false, since: null });
		expect(plan[0]!.needsMove).toBe(true);
		expect(plan[0]!.stripTags).toEqual([]);
	});

	it("plain при includePlain=true — виден на месте, перенос не нужен", () => {
		const t = makeTask({ start: PAST, container: "plain" });
		const plan = planPromotions([t], TODAY, { includePlain: true, since: null });
		expect(plan[0]!.needsMove).toBe(false);
	});

	it("inbox с 🛫 и тегом доски — снять тег на месте, без переноса", () => {
		const t = makeTask({ start: PAST, container: "inbox", tags: ["#kanban/b/c"] });
		const plan = planPromotions([t], TODAY, { includePlain: false, since: null });
		expect(plan[0]!.needsMove).toBe(false);
		expect(plan[0]!.stripTags).toEqual(["#kanban/b/c"]);
	});

	it("project (готовые задачи проекта видны во входящих) — без переноса", () => {
		const t = makeTask({ start: PAST, container: "project" });
		const plan = planPromotions([t], TODAY, { includePlain: false, since: null });
		expect(plan[0]!.needsMove).toBe(false);
	});

	it("нормализация тегов без ведущего '#' (индекс хранит kanban/…)", () => {
		const t = makeTask({ start: PAST, container: "plain", tags: ["kanban/b/c"] });
		const plan = planPromotions([t], TODAY, { includePlain: true, since: null });
		expect(plan[0]!.stripTags).toEqual(["#kanban/b/c"]);
	});

	it("окно (since, today]: исторический бэклог до since не сметается", () => {
		const old = makeTask({ start: PAST }); // наступила давно, до окна
		const fresh = makeTask({ start: TODAY }); // наступила в окне
		const plan = planPromotions([old, fresh], TODAY, { includePlain: true, since: "2026-07-14" });
		expect(plan.map((p) => p.task.key)).toEqual([fresh.key]);
	});

	it("окно: since == start — исключительно (день уже обработан)", () => {
		const t = makeTask({ start: "2026-07-14" });
		expect(planPromotions([t], TODAY, { includePlain: true, since: "2026-07-14" })).toEqual([]);
	});

	it("идемпотентность: снятая 🛫 (start=null) больше не кандидат", () => {
		// исполнение плана снимает 🛫 — эмулируем результат и убеждаемся, что
		// следующий проход задачу уже не выберет
		const promoted = makeTask({ start: null, container: "plain" });
		expect(planPromotions([promoted], TODAY, { includePlain: false, since: null })).toEqual([]);
	});
});
