import { describe, expect, it } from "vitest";
import { makeTask } from "../../stores/testSupport";
import { filterTasks } from "./inboxLogic";

const tasks = [
	makeTask({ filePath: "a.md", description: "Купить Молоко", tags: [] }),
	makeTask({ filePath: "a.md", description: "позвонить маме", tags: ["#family"] }),
	makeTask({ filePath: "b.md", description: "report Q3", tags: ["#Work/office"] }),
];

describe("filterTasks", () => {
	it("пустой и пробельный запрос возвращают исходный массив как есть", () => {
		expect(filterTasks(tasks, "")).toBe(tasks);
		expect(filterTasks(tasks, "   ")).toBe(tasks);
	});

	it("подстрока в описании без учёта регистра (латиница и кириллица)", () => {
		expect(filterTasks(tasks, "REPORT")).toEqual([tasks[2]]);
		expect(filterTasks(tasks, "молоко")).toEqual([tasks[0]]);
	});

	it("ищет и по тегам", () => {
		expect(filterTasks(tasks, "family")).toEqual([tasks[1]]);
		expect(filterTasks(tasks, "#work")).toEqual([tasks[2]]);
	});

	it("нет совпадений — пустой список", () => {
		expect(filterTasks(tasks, "ничего-такого")).toEqual([]);
	});

	it("порядок исходной сортировки сохраняется", () => {
		expect(filterTasks(tasks, "о")).toEqual([tasks[0], tasks[1]]); // «Молоко», «позвонить»
	});
});
