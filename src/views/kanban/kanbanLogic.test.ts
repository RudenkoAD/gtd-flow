import { describe, expect, it } from "vitest";
import type { BoardDef } from "../../core/board/boardFile";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import type { DiscoveredBoard } from "../../services/BoardService";
import { makeTask } from "../../stores/testSupport";
import { VIEW_TYPES } from "../registry";
import {
	boardFileName,
	buildColumnVMs,
	columnCaptureTransform,
	columnTaskLine,
	isFromTickler,
	moveRefusalNotice,
	pickBoardPath,
	returnFromTicklerIntent,
	uniqueBoardPath,
} from "./kanbanLogic";

const DEF: BoardDef = {
	id: "x",
	name: "X",
	groupBy: "tag",
	columns: [],
	skippedColumns: [],
	order: {},
};
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

	it("today включает NLP: 📅 перед тегом колонки", () => {
		expect(columnTaskLine("завтра купить хлеб", "#kanban/home/todo", "2026-07-22")).toBe(
			"- [ ] купить хлеб 📅 2026-07-23 #kanban/home/todo",
		);
	});

	it("строка «📅 <дата> #тег» парсится: и дата, и тег колонки на месте", () => {
		const line = columnTaskLine("завтра в 15 звонок", "#kanban/home/todo", "2026-07-22")!;
		const t = parseTaskLine(line, {
			filePath: "board.md",
			lineStart: 0,
			parentLine: null,
			heading: null,
			container: "board",
			projectActive: true,
		})!;
		expect(t.description).toBe("звонок #kanban/home/todo");
		expect(t.due).toBe("2026-07-23");
		expect(t.dueTime).toBe("15:00");
		expect(t.tags).toContain("#kanban/home/todo");
	});

	it("today=null — прежнее поведение без дат", () => {
		expect(columnTaskLine("завтра купить", "#kanban/b/todo")).toBe(
			"- [ ] завтра купить #kanban/b/todo",
		);
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

describe("drop карточки из отложенных на колонку (фидбек Б)", () => {
	it("isFromTickler: только тип тикля даёт true", () => {
		expect(isFromTickler(VIEW_TYPES.tickler)).toBe(true);
		expect(isFromTickler(VIEW_TYPES.inbox)).toBe(false);
		expect(isFromTickler(VIEW_TYPES.kanban)).toBe(false);
		expect(isFromTickler("")).toBe(false);
	});

	it("returnFromTicklerIntent: снятие 🛫 = set-date start null (как «Вернуть во входящие»)", () => {
		expect(returnFromTicklerIntent("k1")).toEqual({
			type: "set-date",
			key: "k1",
			field: "start",
			date: null,
		});
	});
});
