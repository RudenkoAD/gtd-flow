import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { IsoDate, Task } from "../model/Task";
import { computeKey } from "../parser/taskKey";
import { TaskIndex } from "./TaskIndex";

function makeTask(over: Partial<Task> & { key: string }): Task {
	return {
		taskId: null,
		filePath: "a.md",
		lineStart: 0,
		lineEnd: 0,
		parentLine: null,
		heading: null,
		description: "task",
		rawLine: "- [ ] task",
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
		...over,
	};
}

function expectSameTasks(actual: Iterable<Task>, expected: readonly Task[]): void {
	const a = new Set(actual);
	expect(a.size).toBe(new Set(expected).size);
	for (const t of expected) expect(a.has(t)).toBe(true);
}

describe("TaskIndex: replaceFile", () => {
	it("updates primary and all secondary indices", () => {
		const index = new TaskIndex();
		const t1 = makeTask({ key: "k1", taskId: "a", due: "2026-08-01", tags: ["#p"], filePath: "f.md" });
		const t2 = makeTask({ key: "k2", scheduled: "2026-08-02", start: "2026-08-01", filePath: "f.md" });
		index.replaceFile("f.md", [t1, t2]);

		expect(index.get("k1")).toBe(t1);
		expectSameTasks(index.all(), [t1, t2]);
		expectSameTasks(index.fileTasks("f.md"), [t1, t2]);
		// byDate — объединённый бакет due/scheduled/start
		expectSameTasks(index.dateTasks("2026-08-01"), [t1, t2]);
		expectSameTasks(index.dateTasks("2026-08-02"), [t2]);
		expectSameTasks(index.tagTasks("#p"), [t1]);
		expect(index.resolveDep("a")).toEqual([t1]);

		// повторная замена вычищает старое из ВСЕХ индексов
		const t3 = makeTask({ key: "k3", due: "2026-09-09", tags: ["#q"], filePath: "f.md" });
		index.replaceFile("f.md", [t3]);
		expect(index.get("k1")).toBeUndefined();
		expect(index.get("k2")).toBeUndefined();
		expect(index.dateTasks("2026-08-01")).toEqual([]);
		expect(index.dateTasks("2026-08-02")).toEqual([]);
		expect(index.tagTasks("#p")).toEqual([]);
		expect(index.resolveDep("a")).toEqual([]);
		expectSameTasks(index.all(), [t3]);
	});

	it("removeFile clears every trace of the file", () => {
		const index = new TaskIndex();
		const t = makeTask({ key: "k", taskId: "a", due: "2026-01-01", tags: ["#t"], filePath: "f.md" });
		index.replaceFile("f.md", [t]);
		index.removeFile("f.md");
		expect(index.get("k")).toBeUndefined();
		expect([...index.all()]).toEqual([]);
		expect(index.fileTasks("f.md")).toEqual([]);
		expect(index.dateTasks("2026-01-01")).toEqual([]);
		expect(index.tagTasks("#t")).toEqual([]);
		expect(index.resolveDep("a")).toEqual([]);
	});

	it("epoch bumps on every mutation", () => {
		const index = new TaskIndex();
		const e0 = index.epoch;
		index.replaceFile("f.md", []);
		const e1 = index.epoch;
		index.removeFile("f.md");
		const e2 = index.epoch;
		index.renameFile("f.md", "g.md");
		const e3 = index.epoch;
		expect(e1).toBeGreaterThan(e0);
		expect(e2).toBeGreaterThan(e1);
		expect(e3).toBeGreaterThan(e2);
	});
});

describe("TaskIndex: byId multi-carrier", () => {
	it("tolerates several carriers of one 🆔 and reports them", () => {
		const index = new TaskIndex();
		const c1 = makeTask({ key: "k1", taskId: "x", filePath: "a.md" });
		const c2 = makeTask({ key: "k2", taskId: "x", filePath: "b.md" });
		index.replaceFile("a.md", [c1]);
		index.replaceFile("b.md", [c2]);

		expectSameTasks(index.resolveDep("x"), [c1, c2]);
		const dup = index.duplicateIds();
		expect(dup.size).toBe(1);
		const keys = dup.get("x");
		expect(keys).toBeDefined();
		expect(keys).toHaveLength(2);

		// один носитель ушёл — дубль исчез
		index.removeFile("a.md");
		expectSameTasks(index.resolveDep("x"), [c2]);
		expect(index.duplicateIds().size).toBe(0);
	});

	it("identical keys from two files: no carrier is lost (fail-closed needs all)", () => {
		const index = new TaskIndex();
		// оба носителя получают одинаковый "id:x" — сценарий дублей spawn §8
		const c1 = makeTask({ key: "id:x", taskId: "x", filePath: "a.md", rawLine: "- [ ] one" });
		const c2 = makeTask({ key: "id:x", taskId: "x", filePath: "b.md", rawLine: "- [ ] two" });
		index.replaceFile("a.md", [c1]);
		index.replaceFile("b.md", [c2]);

		const all = [...index.all()];
		expect(all).toHaveLength(2);
		// всё, что отдаёт индекс, самосогласовано: get(t.key) === t
		for (const t of all) expect(index.get(t.key)).toBe(t);
		expect(index.resolveDep("x")).toHaveLength(2);
		expect(index.duplicateIds().get("x")).toHaveLength(2);

		index.removeFile("a.md");
		expect(index.resolveDep("x")).toHaveLength(1);
		expect([...index.all()]).toHaveLength(1);
	});
});

describe("TaskIndex: renameFile", () => {
	it("rekeys content-keys with the new path; id-keys stay stable", () => {
		const index = new TaskIndex();
		const idTask = makeTask({
			key: "id:a",
			taskId: "a",
			filePath: "old.md",
			due: "2026-08-01",
			tags: ["#tag"],
		});
		// content-key вычисляем тем же computeKey, что и продакшен (ключ — не наш контракт)
		const contentSeed = makeTask({
			key: "tmp",
			filePath: "old.md",
			description: "anon",
			rawLine: "- [ ] anon ⏳ 2026-08-02",
			scheduled: "2026-08-02",
		});
		const contentTask: Task = { ...contentSeed, key: computeKey(contentSeed) };
		index.replaceFile("old.md", [idTask, contentTask]);
		index.renameFile("old.md", "new.md");

		expect(index.fileTasks("old.md")).toEqual([]);
		const moved = index.fileTasks("new.md");
		expect(moved).toHaveLength(2);
		for (const t of moved) {
			expect(t.filePath).toBe("new.md");
			// ключ пересчитан через computeKey и самосогласован
			expect(t.key).toBe(computeKey(t));
			expect(index.get(t.key)).toBe(t);
		}

		// "id:<🆔>" не зависит от пути (контракт Task.key)
		const movedId = index.resolveDep("a");
		expect(movedId).toHaveLength(1);
		expect(movedId[0]?.key).toBe("id:a");

		// вторичные индексы перекинуты на новые ключи
		expectSameTasks(index.dateTasks("2026-08-01"), [movedId[0] as Task]);
		expect(index.dateTasks("2026-08-02")).toHaveLength(1);
		expect(index.tagTasks("#tag")).toHaveLength(1);
	});

	it("duplicate no-id lines keep their occurrenceIndex on rename (no manufactured collision)", () => {
		// регресс: renameFile пересчитывал ключи через computeKey с дефолтным
		// occurrenceIndex=0 и схлопывал одинаковые строки без 🆔 в коллизию
		const index = new TaskIndex();
		const seed = makeTask({
			key: "tmp",
			filePath: "a.md",
			description: "call mom",
			rawLine: "- [ ] call mom",
		});
		const first: Task = { ...seed, key: computeKey(seed, 0), lineStart: 1, lineEnd: 1 };
		const second: Task = { ...seed, key: computeKey(seed, 1), lineStart: 2, lineEnd: 2 };
		index.replaceFile("a.md", [first, second]);
		index.renameFile("a.md", "b.md");

		const renamedSeed = { ...seed, filePath: "b.md" };
		const expected = [computeKey(renamedSeed, 0), computeKey(renamedSeed, 1)];
		const moved = index.fileTasks("b.md");
		expect(moved.map((t) => t.key).sort()).toEqual([...expected].sort());
		// ключи в точности как у свежего парса b.md: без U+0001-уникализации
		for (const t of moved) {
			expect(t.key).not.toContain(String.fromCharCode(1));
			expect(index.get(t.key)).toBe(t);
		}
	});

	it("renaming a missing file is a harmless no-op (epoch still bumps)", () => {
		const index = new TaskIndex();
		const e0 = index.epoch;
		index.renameFile("ghost.md", "still-ghost.md");
		expect([...index.all()]).toEqual([]);
		expect(index.epoch).toBeGreaterThan(e0);
	});
});

// --- property: после произвольной последовательности replaceFile/removeFile
// вторичные индексы в точности выводимы из primary ---

const PATHS = ["a.md", "b.md", "c.md"] as const;
const DATES: IsoDate[] = ["2026-01-01", "2026-02-02", "2026-03-03"];
const IDS = ["x", "y", "z"];
const TAGS = ["#a", "#b", "#waiting"];

interface Seed {
	taskId: string | null;
	due: IsoDate | null;
	scheduled: IsoDate | null;
	start: IsoDate | null;
	tags: string[];
}

const dateArb = fc.option(fc.constantFrom(...DATES), { nil: null });
const seedArb: fc.Arbitrary<Seed> = fc.record({
	taskId: fc.option(fc.constantFrom(...IDS), { nil: null }),
	due: dateArb,
	scheduled: dateArb,
	start: dateArb,
	tags: fc.subarray(TAGS),
});
const opArb = fc.oneof(
	fc.record({
		type: fc.constant("replace" as const),
		path: fc.constantFrom(...PATHS),
		seeds: fc.array(seedArb, { maxLength: 5 }),
	}),
	fc.record({ type: fc.constant("remove" as const), path: fc.constantFrom(...PATHS) }),
);

describe("TaskIndex: property", () => {
	it("secondary indices are exactly derivable from primary after any op sequence", () => {
		fc.assert(
			fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
				const index = new TaskIndex();
				const model = new Map<string, Task[]>();
				let counter = 0;
				let lastEpoch = index.epoch;

				for (const op of ops) {
					if (op.type === "replace") {
						const tasks = op.seeds.map((s) =>
							makeTask({
								// глобально уникальные ключи; коллизии покрыты детерминированным тестом
								key: `t${counter++}`,
								filePath: op.path,
								taskId: s.taskId,
								due: s.due,
								scheduled: s.scheduled,
								start: s.start,
								tags: [...s.tags],
							}),
						);
						index.replaceFile(op.path, tasks);
						model.set(op.path, tasks);
					} else {
						index.removeFile(op.path);
						model.delete(op.path);
					}
					expect(index.epoch).toBeGreaterThan(lastEpoch);
					lastEpoch = index.epoch;
				}

				const live: Task[] = [...model.values()].flat();
				expectSameTasks(index.all(), live);
				for (const t of live) expect(index.get(t.key)).toBe(t);

				for (const path of PATHS) {
					expectSameTasks(index.fileTasks(path), model.get(path) ?? []);
				}
				for (const date of DATES) {
					expectSameTasks(
						index.dateTasks(date),
						live.filter((t) => t.due === date || t.scheduled === date || t.start === date),
					);
				}
				for (const tag of TAGS) {
					expectSameTasks(
						index.tagTasks(tag),
						live.filter((t) => t.tags.includes(tag)),
					);
				}
				const dup = index.duplicateIds();
				for (const id of IDS) {
					const carriers = live.filter((t) => t.taskId === id);
					expectSameTasks(index.resolveDep(id), carriers);
					expect(dup.has(id)).toBe(carriers.length > 1);
					if (carriers.length > 1) expect(dup.get(id)).toHaveLength(carriers.length);
				}
			}),
			{ numRuns: 200 },
		);
	});
});
