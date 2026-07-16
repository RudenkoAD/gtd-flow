import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import type { ProjectSummary } from "../../services/ProjectService";
import { makeTask } from "../../stores/testSupport";
import {
	buildProjectRows,
	newProjectPath,
	projectDir,
	sanitizeProjectName,
} from "./projectsOverviewLogic";

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

describe("projectDir", () => {
	it("нет проектов — дефолт Projects", () => {
		expect(projectDir([])).toBe("Projects");
	});

	it("папка первого (лексикографически) проекта", () => {
		expect(projectDir(["Work/Beta.md", "Areas/Alpha.md"])).toBe("Areas");
	});

	it("проект в корне — папка пустая", () => {
		expect(projectDir(["Alpha.md"])).toBe("");
	});

	it("вложенная папка сохраняется целиком", () => {
		expect(projectDir(["GTD/Projects/Alpha.md"])).toBe("GTD/Projects");
	});
});

describe("sanitizeProjectName", () => {
	it("схлопывает пробелы и триммит", () => {
		expect(sanitizeProjectName("  Ремонт   кухни ")).toBe("Ремонт кухни");
	});

	it("вырезает символы, ломающие путь", () => {
		expect(sanitizeProjectName("a/b:c*d?e")).toBe("a b c d e");
	});

	it("срезает ведущие точки (иначе скрытый файл)", () => {
		expect(sanitizeProjectName("...секрет")).toBe("секрет");
	});

	it("пусто после чистки — null", () => {
		expect(sanitizeProjectName("   ")).toBeNull();
		expect(sanitizeProjectName("///")).toBeNull();
	});
});

describe("newProjectPath", () => {
	it("кладёт новый проект в папку существующих", () => {
		expect(newProjectPath(["Work/Beta.md"], "Гамма")).toBe("Work/Гамма.md");
	});

	it("нет проектов — Projects/<имя>.md", () => {
		expect(newProjectPath([], "Альфа")).toBe("Projects/Альфа.md");
	});

	it("проекты в корне — новый тоже в корне", () => {
		expect(newProjectPath(["Alpha.md"], "Бета")).toBe("Бета.md");
	});

	it("санитация имени применяется к пути", () => {
		expect(newProjectPath([], "a/b")).toBe("Projects/a b.md");
	});

	it("пустое имя — null (не создаём)", () => {
		expect(newProjectPath([], "   ")).toBeNull();
	});

	it("занятый путь в хранилище — суффикс « 2», « 3» (не портим чужую заметку)", () => {
		const taken = new Set(["Projects/Альфа.md", "Projects/Альфа 2.md"]);
		expect(newProjectPath([], "Альфа", (p) => taken.has(p))).toBe("Projects/Альфа 3.md");
		expect(newProjectPath([], "Бета", (p) => taken.has(p))).toBe("Projects/Бета.md");
	});
});
