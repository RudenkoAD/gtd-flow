import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import { diffFile } from "./diffFile";

function makeTask(over: Partial<Task> & { key: string }): Task {
	return {
		taskId: null,
		filePath: "f.md",
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
		...over,
	};
}

describe("diffFile", () => {
	it("detects added tasks", () => {
		const a = makeTask({ key: "a" });
		const b = makeTask({ key: "b" });
		const diff = diffFile([a], [a, b]);
		expect(diff.added).toEqual([b]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);
	});

	it("detects removed tasks", () => {
		const a = makeTask({ key: "a" });
		const b = makeTask({ key: "b" });
		const diff = diffFile([a, b], [b]);
		expect(diff.removed).toEqual([a]);
		expect(diff.added).toEqual([]);
		expect(diff.changed).toEqual([]);
	});

	it("detects changed tasks by rawLine under the same key", () => {
		const before = makeTask({ key: "a", rawLine: "- [ ] task" });
		const after = makeTask({ key: "a", rawLine: "- [x] task ✅ 2026-07-15", statusChar: "x" });
		const diff = diffFile([before], [after]);
		expect(diff.changed).toEqual([{ before, after }]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	it("line shift without text change is NOT a change", () => {
		const before = makeTask({ key: "a", lineStart: 3, lineEnd: 3 });
		const after = makeTask({ key: "a", lineStart: 10, lineEnd: 10 });
		const diff = diffFile([before], [after]);
		expect(diff.changed).toEqual([]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	it("mixed diff: add + remove + change at once", () => {
		const stays = makeTask({ key: "s" });
		const goes = makeTask({ key: "g" });
		const editedBefore = makeTask({ key: "e", rawLine: "- [ ] x" });
		const editedAfter = makeTask({ key: "e", rawLine: "- [ ] x 📅 2026-08-01", due: "2026-08-01" });
		const fresh = makeTask({ key: "f" });

		const diff = diffFile([stays, goes, editedBefore], [stays, editedAfter, fresh]);
		expect(diff.added).toEqual([fresh]);
		expect(diff.removed).toEqual([goes]);
		expect(diff.changed).toEqual([{ before: editedBefore, after: editedAfter }]);
	});

	it("both empty: empty diff", () => {
		const diff = diffFile([], []);
		expect(diff).toEqual({ added: [], removed: [], changed: [] });
	});
});
