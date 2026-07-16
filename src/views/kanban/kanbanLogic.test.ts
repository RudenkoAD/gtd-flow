import { describe, expect, it } from "vitest";
import type { BoardDef } from "../../core/board/boardFile";
import type { DiscoveredBoard } from "../../services/BoardService";
import { makeTask } from "../../stores/testSupport";
import {
	boardDirFromInbox,
	boardFileName,
	buildColumnVMs,
	columnCaptureTransform,
	columnTaskLine,
	moveRefusalNotice,
	pickBoardPath,
	uniqueBoardPath,
} from "./kanbanLogic";

const DEF: BoardDef = { id: "x", name: "X", groupBy: "tag", columns: [], skippedColumns: [], order: {} };
const boards: DiscoveredBoard[] = [
	{ path: "a.md", def: DEF },
	{ path: "b.md", def: DEF },
];

describe("pickBoardPath", () => {
	it("текущая доска сохраняется, пока существует", () => {
		expect(pickBoardPath(boards, "a.md", "b.md")).toBe("b.md");
	});

	it("исчезнувшая текущая уступает предпочтению из настроек", () => {
		expect(pickBoardPath(boards, "b.md", "gone.md")).toBe("b.md");
	});

	it("без текущей и предпочтения — первая; предпочтение вне списка игнорируется", () => {
		expect(pickBoardPath(boards, null, null)).toBe("a.md");
		expect(pickBoardPath(boards, "ghost.md", null)).toBe("a.md");
	});

	it("досок нет — null", () => {
		expect(pickBoardPath([], "a.md", "a.md")).toBe(null);
	});
});

describe("buildColumnVMs", () => {
	it("счётчики из состояния вида", () => {
		const t1 = makeTask({ filePath: "f.md", lineStart: 1 });
		const t2 = makeTask({ filePath: "f.md", lineStart: 2 });
		const vms = buildColumnVMs([
			{ id: "todo", name: "Todo", match: "#t", tasks: [t1, t2] },
			{ id: "done", name: "Done", match: "status:done", tasks: [] },
		]);
		expect(vms.map((v) => [v.id, v.count])).toEqual([
			["todo", 2],
			["done", 0],
		]);
	});
});

describe("buildColumnVMs match", () => {
	it("match колонки прокидывается во вью-модель (им метится новая задача)", () => {
		const vms = buildColumnVMs([
			{ id: "todo", name: "Очередь", match: "#kanban/home/todo", tasks: [] },
		]);
		expect(vms[0]!.match).toBe("#kanban/home/todo");
	});
});

describe("moveRefusalNotice", () => {
	it("причины показываются как есть; undefined — общий текст", () => {
		expect(moveRefusalNotice("line-not-found")).toBe("GTD Flow: line-not-found");
		expect(moveRefusalNotice("task-not-found")).toBe("GTD Flow: task-not-found");
		expect(moveRefusalNotice(undefined)).toBe("GTD Flow: не удалось перенести карточку");
	});
});

describe("columnTaskLine", () => {
	it("строка задачи получает тег-матч колонки в конце", () => {
		expect(columnTaskLine("купить хлеб", "#kanban/home/todo")).toBe(
			"- [ ] купить хлеб #kanban/home/todo",
		);
	});

	it("санитация как у быстрого ввода: схлопывает пробелы и срезает набранный чекбокс", () => {
		expect(columnTaskLine("  - [x]   уже   задача  ", "#kanban/b/done")).toBe(
			"- [ ] уже задача #kanban/b/done",
		);
	});

	it("пустой (или пустой после чистки) ввод → null", () => {
		expect(columnTaskLine("", "#kanban/b/todo")).toBeNull();
		expect(columnTaskLine("   ", "#kanban/b/todo")).toBeNull();
		expect(columnTaskLine("- [ ]  ", "#kanban/b/todo")).toBeNull();
	});

	it("пустой match (fail-safe) → строка без тега", () => {
		expect(columnTaskLine("задача", "")).toBe("- [ ] задача");
		expect(columnTaskLine("задача", "   ")).toBe("- [ ] задача");
	});
});

describe("columnCaptureTransform", () => {
	it("аппендит строку с тегом в конец файла доски", () => {
		const t = columnCaptureTransform("новая", "#kanban/home/doing");
		expect(t).not.toBeNull();
		expect(t!("---\ngtd-board: true\n---\n")).toBe(
			"---\ngtd-board: true\n---\n- [ ] новая #kanban/home/doing\n",
		);
	});

	it("пустой ввод → null (ничего не пишем)", () => {
		expect(columnCaptureTransform("  ", "#kanban/home/doing")).toBeNull();
	});
});

describe("boardDirFromInbox", () => {
	it("каталог первого источника входящих", () => {
		expect(boardDirFromInbox(["GTD/Inbox.md"])).toBe("GTD");
		expect(boardDirFromInbox(["a/b/c/In.md"])).toBe("a/b/c");
	});

	it("файл в корне → пустая строка; пустой список → дефолт GTD", () => {
		expect(boardDirFromInbox(["Inbox.md"])).toBe("");
		expect(boardDirFromInbox([])).toBe("GTD");
	});
});

describe("boardFileName", () => {
	it("недопустимые в имени файла символы → пробел, схлоп/обрезка", () => {
		expect(boardFileName("Работа/Дом: план?")).toBe("Работа Дом план");
		expect(boardFileName("  Проект  ")).toBe("Проект");
	});

	it("имя целиком из спецсимволов → фолбэк «Доска»", () => {
		expect(boardFileName("///")).toBe("Доска");
		expect(boardFileName("")).toBe("Доска");
	});
});

describe("uniqueBoardPath", () => {
	it("свободный путь <dir>/<имя>.md", () => {
		expect(uniqueBoardPath("GTD", "Работа", () => false)).toBe("GTD/Работа.md");
	});

	it("корень хранилища (пустой dir) — без ведущего слэша", () => {
		expect(uniqueBoardPath("", "Работа", () => false)).toBe("Работа.md");
	});

	it("занятый путь → суффикс с номером до первого свободного", () => {
		const taken = new Set(["GTD/Работа.md", "GTD/Работа 2.md"]);
		expect(uniqueBoardPath("GTD", "Работа", (p) => taken.has(p))).toBe("GTD/Работа 3.md");
	});
});
