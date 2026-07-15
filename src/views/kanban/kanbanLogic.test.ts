import { describe, expect, it } from "vitest";
import type { BoardDef } from "../../core/board/boardFile";
import type { DiscoveredBoard } from "../../services/BoardService";
import { makeTask } from "../../stores/testSupport";
import { buildColumnVMs, moveRefusalNotice, pickBoardPath, toggleCollapsed } from "./kanbanLogic";

const DEF: BoardDef = { id: "x", name: "X", groupBy: "tag", columns: [], order: {} };
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
	it("счётчики и свёрнутость из состояния вида", () => {
		const t1 = makeTask({ filePath: "f.md", lineStart: 1 });
		const t2 = makeTask({ filePath: "f.md", lineStart: 2 });
		const vms = buildColumnVMs(
			[
				{ id: "todo", name: "Todo", match: "#t", tasks: [t1, t2] },
				{ id: "done", name: "Done", match: "status:done", tasks: [] },
			],
			{ done: true },
		);
		expect(vms.map((v) => [v.id, v.count, v.collapsed])).toEqual([
			["todo", 2, false],
			["done", 0, true],
		]);
	});
});

describe("moveRefusalNotice", () => {
	it("status-column и done-card дают понятные подсказки", () => {
		expect(moveRefusalNotice("status-column")).toBe(
			"GTD Flow: Колонка по статусу: статус меняется чекбоксом карточки",
		);
		expect(moveRefusalNotice("done-card")).toBe(
			"GTD Flow: Выполненная карточка: снимите отметку, чтобы вернуть в работу",
		);
	});

	it("прочие причины показываются как есть; undefined — общий текст", () => {
		expect(moveRefusalNotice("line-not-found")).toBe("GTD Flow: line-not-found");
		expect(moveRefusalNotice(undefined)).toBe("GTD Flow: не удалось перенести карточку");
	});
});

describe("toggleCollapsed", () => {
	it("переключает и не мутирует вход", () => {
		const initial = { a: true };
		const next = toggleCollapsed(initial, "b");
		expect(next).toEqual({ a: true, b: true });
		expect(toggleCollapsed(next, "a")).toEqual({ a: false, b: true });
		expect(initial).toEqual({ a: true });
	});
});
