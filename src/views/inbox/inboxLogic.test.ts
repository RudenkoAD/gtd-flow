import { describe, expect, it } from "vitest";
import { makeTask } from "../../stores/testSupport";
import { filterTasks, inboxCaptureTransform } from "./inboxLogic";

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

describe("inboxCaptureTransform", () => {
	it("пустой и пробельный ввод → null (не пишем, поле не чистим)", () => {
		expect(inboxCaptureTransform("")).toBeNull();
		expect(inboxCaptureTransform("   \n\t ")).toBeNull();
	});

	it("непустой ввод → append строки '- [ ] <текст>' в конец файла", () => {
		const t = inboxCaptureTransform("Купить молоко");
		expect(t).not.toBeNull();
		expect(t!("- [ ] старое\n")).toBe("- [ ] старое\n- [ ] Купить молоко\n");
	});

	it("пустой файл → одна строка без ведущего перевода", () => {
		const t = inboxCaptureTransform("Первая");
		expect(t!("")).toBe("- [ ] Первая\n");
	});

	it("санитация quickCaptureLine: схлопывание пробелов и срез готового префикса", () => {
		// многострочный/пробельный ввод не разваливает файл
		expect(inboxCaptureTransform("а\n\nб   в")!("")).toBe("- [ ] а б в\n");
		// уже набранный пользователем чекбокс не даёт двойного префикса
		expect(inboxCaptureTransform("- [x] сделано")!("")).toBe("- [ ] сделано\n");
	});
});
