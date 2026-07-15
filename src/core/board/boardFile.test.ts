import { describe, expect, it } from "vitest";
import { isBoardError, parseBoardFrontmatter, parseMatchSpec } from "./boardFile";

const validFm = (): Record<string, unknown> => ({
	"gtd-board": true,
	id: "work",
	name: "Work board",
	"group-by": "tag",
	scope: "#work",
	columns: [
		{ id: "todo", name: "To do", match: "#kanban/work/todo" },
		{ id: "doing", match: "#kanban/work/doing" },
		{ id: "done", name: "Done", match: "#kanban/work/done" },
	],
	order: {
		todo: ["t1", "t2"],
		doing: [],
		ghost: ["t9"],
	},
});

describe("parseBoardFrontmatter: valid input", () => {
	it("parses a full board definition", () => {
		const res = parseBoardFrontmatter(validFm());
		expect(isBoardError(res)).toBe(false);
		if (isBoardError(res)) return;
		expect(res.id).toBe("work");
		expect(res.name).toBe("Work board");
		expect(res.groupBy).toBe("tag");
		expect(res.scope).toBe("#work");
		expect(res.columns).toEqual([
			{ id: "todo", name: "To do", match: "#kanban/work/todo" },
			{ id: "doing", name: "doing", match: "#kanban/work/doing" }, // name по умолчанию = id
			{ id: "done", name: "Done", match: "#kanban/work/done" },
		]);
		expect(res.skippedColumns).toEqual([]);
		// order неизвестной колонки молча выброшен (ренормализация)
		expect(res.order).toEqual({ todo: ["t1", "t2"], doing: [] });
	});

	it("defaults: name falls back to id, groupBy to 'tag', order to {}", () => {
		const res = parseBoardFrontmatter({
			id: "b1",
			columns: [{ id: "c1", match: "#x" }],
		});
		expect(isBoardError(res)).toBe(false);
		if (isBoardError(res)) return;
		expect(res.name).toBe("b1");
		expect(res.groupBy).toBe("tag");
		expect(res.order).toEqual({});
		expect(res.skippedColumns).toEqual([]);
		expect(res.scope).toBeUndefined();
	});

	it("accepts groupBy 'status' via either key spelling (метаданные, колонки — теги)", () => {
		const a = parseBoardFrontmatter({ id: "b", columns: [{ id: "c", match: "#c" }], "group-by": "status" });
		const b = parseBoardFrontmatter({ id: "b", columns: [{ id: "c", match: "#c" }], groupBy: "status" });
		if (isBoardError(a) || isBoardError(b)) throw new Error("expected valid boards");
		expect(a.groupBy).toBe("status");
		expect(b.groupBy).toBe("status");
	});
});

describe("parseBoardFrontmatter: упразднённые status-колонки (раунд 3)", () => {
	it("status-матч не валит доску — колонка пропускается в skippedColumns", () => {
		const res = parseBoardFrontmatter({
			id: "b",
			columns: [
				{ id: "todo", match: "#kanban/b/todo" },
				{ id: "done", name: "Готово", match: "status:done" },
			],
		});
		expect(isBoardError(res)).toBe(false);
		if (isBoardError(res)) return;
		expect(res.columns.map((c) => c.id)).toEqual(["todo"]);
		expect(res.skippedColumns).toHaveLength(1);
		expect(res.skippedColumns[0]!.id).toBe("done");
		expect(res.skippedColumns[0]!.name).toBe("Готово");
		expect(res.skippedColumns[0]!.reason).toMatch(/status-матчи упразднены/);
	});

	it("order упразднённой колонки отбрасывается (ренормализация)", () => {
		const res = parseBoardFrontmatter({
			id: "b",
			columns: [
				{ id: "todo", match: "#kanban/b/todo" },
				{ id: "done", match: "status:done" },
			],
			order: { todo: ["t1"], done: ["d1"] },
		});
		if (isBoardError(res)) throw new Error("expected valid board");
		expect(res.order).toEqual({ todo: ["t1"] });
	});
});

describe("parseBoardFrontmatter: malformed input", () => {
	it("missing id", () => {
		const fm = validFm();
		delete fm["id"];
		const res = parseBoardFrontmatter(fm);
		expect(isBoardError(res)).toBe(true);
		if (!isBoardError(res)) return;
		expect(res.messages.some((m) => m.includes("'id'"))).toBe(true);
	});

	it("missing or empty columns", () => {
		for (const columns of [undefined, [], "cols", 42]) {
			const res = parseBoardFrontmatter({ id: "b", columns });
			expect(isBoardError(res)).toBe(true);
		}
	});

	it("column without id or match, and invalid match spec", () => {
		const res = parseBoardFrontmatter({
			id: "b",
			columns: [{ name: "x" }, { id: "c1", match: "tag-without-hash" }, { id: "c2", match: "plain" }],
		});
		expect(isBoardError(res)).toBe(true);
		if (!isBoardError(res)) return;
		expect(res.messages.length).toBeGreaterThanOrEqual(3);
	});

	it("duplicate column ids", () => {
		const res = parseBoardFrontmatter({
			id: "b",
			columns: [
				{ id: "c", match: "#a" },
				{ id: "c", match: "#b" },
			],
		});
		expect(isBoardError(res)).toBe(true);
		if (!isBoardError(res)) return;
		expect(res.messages.some((m) => m.includes("duplicate column id"))).toBe(true);
	});

	it("invalid group-by value", () => {
		const res = parseBoardFrontmatter({
			id: "b",
			columns: [{ id: "c", match: "#a" }],
			"group-by": "priority",
		});
		expect(isBoardError(res)).toBe(true);
	});

	it("order of wrong shape", () => {
		const notMap = parseBoardFrontmatter({ id: "b", columns: [{ id: "c", match: "#a" }], order: "xx" });
		expect(isBoardError(notMap)).toBe(true);

		const notArray = parseBoardFrontmatter({ id: "b", columns: [{ id: "c", match: "#a" }], order: { c: "t1" } });
		expect(isBoardError(notArray)).toBe(true);

		const nonString = parseBoardFrontmatter({ id: "b", columns: [{ id: "c", match: "#a" }], order: { c: ["t1", 5] } });
		expect(isBoardError(nonString)).toBe(true);
	});

	it("non-string scope", () => {
		const res = parseBoardFrontmatter({ id: "b", columns: [{ id: "c", match: "#a" }], scope: 7 });
		expect(isBoardError(res)).toBe(true);
	});

	it("collects several errors at once", () => {
		const res = parseBoardFrontmatter({ columns: [{ id: "c", match: "bad" }], "group-by": "nope" });
		expect(isBoardError(res)).toBe(true);
		if (!isBoardError(res)) return;
		expect(res.messages.length).toBeGreaterThanOrEqual(3);
	});
});

describe("parseMatchSpec", () => {
	it("parses tag specs (без ведущего #)", () => {
		expect(parseMatchSpec("#kanban/w/todo")).toEqual({ kind: "tag", tag: "kanban/w/todo" });
		expect(parseMatchSpec("#work")).toEqual({ kind: "tag", tag: "work" });
	});

	it("rejects garbage и упразднённые status-матчи", () => {
		expect(parseMatchSpec("#")).toBeNull();
		expect(parseMatchSpec("status:todo")).toBeNull();
		expect(parseMatchSpec("status:done")).toBeNull();
		expect(parseMatchSpec("plain")).toBeNull();
		expect(parseMatchSpec("")).toBeNull();
	});
});
