import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import type { ProjectSummary } from "../../services/ProjectService";
import { makeTask } from "../../stores/testSupport";
import { buildProjectRows } from "./projectsOverviewLogic";

function summary(over: Partial<ProjectSummary> & { path: string }): ProjectSummary {
	return {
		name: over.path,
		status: "active",
		complete: false,
		stalled: false,
		...over,
	};
}

/** Задачи файла с заданными статус-символами (container роли не играет для прогресса). */
function member(path: string, statusChar: string, line: number): Task {
	return makeTask({ filePath: path, container: "project", statusChar, lineStart: line });
}

describe("buildProjectRows", () => {
	it("прогресс = (done + cancelled) / total, в процентах округлённо", () => {
		const tasks: Record<string, Task[]> = {
			"P.md": [
				member("P.md", "x", 1), // done
				member("P.md", "-", 2), // cancelled — считается выполненным
				member("P.md", " ", 3), // active
			],
		};
		const [row] = buildProjectRows([summary({ path: "P.md" })], (p) => tasks[p] ?? []);
		expect(row!.done).toBe(2);
		expect(row!.total).toBe(3);
		expect(row!.pct).toBe(67); // round(2/3*100)
	});

	it("пустой проект — 0/0 и 0%", () => {
		const [row] = buildProjectRows([summary({ path: "Empty.md" })], () => []);
		expect(row!.done).toBe(0);
		expect(row!.total).toBe(0);
		expect(row!.pct).toBe(0);
	});

	it("флаги complete/stalled берутся из сводки, не пересчитываются", () => {
		const [row] = buildProjectRows(
			[summary({ path: "P.md", complete: true, stalled: true })],
			() => [member("P.md", " ", 1)], // члены не выполнены — но флаги из сводки
		);
		expect(row!.complete).toBe(true);
		expect(row!.stalled).toBe(true);
	});

	it("сортировка: active первыми, затем on-hold, done, archived; внутри статуса — по имени", () => {
		const summaries: ProjectSummary[] = [
			summary({ path: "z", name: "Zeta", status: "archived" }),
			summary({ path: "a", name: "Alpha", status: "done" }),
			summary({ path: "b", name: "Beta", status: "active" }),
			summary({ path: "c", name: "Gamma", status: "active" }),
			summary({ path: "d", name: "Delta", status: "on-hold" }),
		];
		const rows = buildProjectRows(summaries, () => []);
		expect(rows.map((r) => r.name)).toEqual(["Beta", "Gamma", "Delta", "Alpha", "Zeta"]);
	});
});
