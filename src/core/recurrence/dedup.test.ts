import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import { classifyDuplicates, type DuplicateCarrier } from "./dedup";

const CANONICAL =
	"- [ ] Review priorities #review 🔺 🛫 2026-07-28 ➕ 2026-08-03 🧬 rev-prio 🆔 rev-prio-20260731";

function makeCopy(over: Partial<Task> = {}): Task {
	return {
		key: "id:rev-prio-20260731",
		taskId: "rev-prio-20260731",
		filePath: "GTD/Inbox.md",
		lineStart: 10,
		lineEnd: 10,
		parentLine: null,
		heading: null,
		description: "Review priorities",
		rawLine: CANONICAL,
		statusChar: " ",
		due: null,
		scheduled: null,
		start: "2026-07-28",
		created: "2026-08-03",
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
		spawnedFrom: "rev-prio",
		priority: "highest",
		dependsOn: [],
		excludedDates: [],
		location: null,
		durationMinutes: null,
		cognitiveIntensity: null,
		emotionalIntensity: null,
		physicalIntensity: null,
		scopeId: null,
		tags: ["#review"],
		container: "plain",
		projectActive: true,
		...over,
	};
}

function carrier(task: Task, canonicalLine: string = CANONICAL): DuplicateCarrier {
	return { task, canonicalLine };
}

describe("classifyDuplicates — four outcomes", () => {
	it("single carrier: keep it, remove nothing", () => {
		const only = makeCopy();
		const res = classifyDuplicates([carrier(only)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(only);
		expect(res.remove).toEqual([]);
	});

	it("all pristine: deterministic winner by (filePath, lineStart)", () => {
		const a = makeCopy({ filePath: "GTD/Inbox.md", lineStart: 10 });
		const b = makeCopy({ filePath: "GTD/Inbox.md", lineStart: 4 });
		const c = makeCopy({ filePath: "GTD/Archive.md", lineStart: 99 });
		const res = classifyDuplicates([carrier(a), carrier(b), carrier(c)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(c); // "GTD/Archive.md" < "GTD/Inbox.md"
		expect(res.remove).toEqual([b, a]); // затем по lineStart
	});

	it("all pristine, same file: lower lineStart wins", () => {
		const a = makeCopy({ lineStart: 12 });
		const b = makeCopy({ lineStart: 5 });
		const res = classifyDuplicates([carrier(a), carrier(b)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(b);
		expect(res.remove).toEqual([a]);
	});

	it("exactly one modified wins over pristine copies", () => {
		const done = makeCopy({
			statusChar: "x",
			rawLine: CANONICAL.replace("- [ ]", "- [x]") + " ✅ 2026-08-04",
		});
		const p1 = makeCopy({ filePath: "GTD/Inbox 2.md" });
		const p2 = makeCopy({ lineStart: 42 });
		const res = classifyDuplicates([carrier(p1), carrier(done), carrier(p2)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(done);
		expect(res.remove).toEqual([p1, p2]);
	});

	it("a text edit alone (status still ' ') counts as modified", () => {
		const edited = makeCopy({ rawLine: CANONICAL + " добавил заметку" });
		const pristine = makeCopy();
		const res = classifyDuplicates([carrier(edited), carrier(pristine)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(edited);
		expect(res.remove).toEqual([pristine]);
	});

	it(">=2 modified: conflict, nothing is ever removed", () => {
		const doneHere = makeCopy({
			statusChar: "x",
			rawLine: CANONICAL.replace("- [ ]", "- [x]"),
		});
		const editedThere = makeCopy({
			filePath: "GTD/Inbox 2.md",
			rawLine: CANONICAL + " и ещё",
		});
		const untouched = makeCopy({ lineStart: 77 });
		const res = classifyDuplicates([
			carrier(doneHere),
			carrier(editedThere),
			carrier(untouched),
		]);
		if (!("conflict" in res)) throw new Error("expected conflict outcome");
		expect(res.conflict).toEqual([doneHere, editedThere]); // нетронутая не в конфликте, но и не удаляется
	});
});

describe("classifyDuplicates — pristine detection details", () => {
	it("tolerates trailing whitespace differences", () => {
		const a = makeCopy({ rawLine: CANONICAL + "   ", lineStart: 3 });
		const b = makeCopy({ lineStart: 8 });
		const res = classifyDuplicates([carrier(a), carrier(b)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(a); // оба нетронуты → победитель по lineStart
		expect(res.remove).toEqual([b]);
	});

	it("a status flip alone (rawLine unchanged) counts as modified", () => {
		// теоретический случай: statusChar расходится с rawLine — верим statusChar
		const flipped = makeCopy({ statusChar: "/" });
		const pristine = makeCopy({ lineStart: 20 });
		const res = classifyDuplicates([carrier(flipped), carrier(pristine)]);
		if (!("keep" in res)) throw new Error("expected resolved outcome");
		expect(res.keep).toBe(flipped);
		expect(res.remove).toEqual([pristine]);
	});

	it("two devices converge on the same winner regardless of carrier order", () => {
		const a = makeCopy({ filePath: "GTD/Inbox.md", lineStart: 10 });
		const b = makeCopy({ filePath: "GTD/Inbox.md", lineStart: 4 });
		const r1 = classifyDuplicates([carrier(a), carrier(b)]);
		const r2 = classifyDuplicates([carrier(b), carrier(a)]);
		if (!("keep" in r1) || !("keep" in r2)) throw new Error("expected resolved outcomes");
		expect(r1.keep).toBe(r2.keep);
	});

	it("empty input yields an empty conflict (degenerate)", () => {
		const res = classifyDuplicates([]);
		expect("conflict" in res && res.conflict).toEqual([]);
	});
});
