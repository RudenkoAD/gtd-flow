import { beforeEach, describe, expect, it } from "vitest";
import type { BoardDef } from "../core/board/boardFile";
import type { Task } from "../core/model/Task";
import { FakeFeed, makeTask } from "../stores/testSupport";
import {
	BoardService,
	insertIntoColumnOrder,
	inScope,
	normalizeOrder,
} from "./BoardService";
import type { IntentDispatcher, IntentResult } from "./WritebackService";

// ---------------------------------------------------------------------------
// Обвязка
// ---------------------------------------------------------------------------

/** Диспетчер-регистратор: пишет вызовы в общую очередь (двухфазность moveCard). */
class FakeDispatcher implements IntentDispatcher {
	intents: unknown[] = [];
	result: IntentResult = { ok: true };
	onDispatch: (() => void) | null = null;

	constructor(private readonly queue: string[]) {}

	dispatch(intent: unknown): Promise<IntentResult> {
		this.intents.push(intent);
		this.queue.push("dispatch");
		this.onDispatch?.();
		return Promise.resolve(this.result);
	}
}

interface Harness {
	feed: FakeFeed;
	dispatcher: FakeDispatcher;
	queue: string[];
	frontmatters: Map<string, Record<string, unknown>>;
	patched: Array<{ path: string; fm: Record<string, unknown> }>;
	service: BoardService;
}

function makeHarness(): Harness {
	const queue: string[] = [];
	const feed = new FakeFeed("2026-07-15");
	const dispatcher = new FakeDispatcher(queue);
	const frontmatters = new Map<string, Record<string, unknown>>();
	const patched: Array<{ path: string; fm: Record<string, unknown> }> = [];
	const service = new BoardService({
		feed,
		dispatcher,
		readFrontmatter: (path) => frontmatters.get(path) ?? null,
		patchFrontmatter: async (path, fn) => {
			queue.push("patch");
			// живой frontmatter: мутация как в processFrontMatter
			const fm = frontmatters.get(path) ?? {};
			fn(fm);
			frontmatters.set(path, fm);
			patched.push({ path, fm });
		},
	});
	return { feed, dispatcher, queue, frontmatters, patched, service };
}

const TAG_BOARD: BoardDef = {
	id: "dev",
	name: "Dev",
	groupBy: "tag",
	columns: [
		{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
		{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
	],
	order: {},
};

const STATUS_BOARD: BoardDef = {
	id: "st",
	name: "Статусы",
	groupBy: "status",
	columns: [
		{ id: "todo", name: "Todo", match: "status:todo" },
		{ id: "doing", name: "Doing", match: "status:doing" },
		{ id: "done", name: "Done", match: "status:done" },
	],
	order: {},
};

function boardTask(over: Partial<Task> & { filePath: string }): Task {
	return makeTask(over);
}

// ---------------------------------------------------------------------------
// discoverBoards
// ---------------------------------------------------------------------------

describe("BoardService.discoverBoards", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});

	it("находит файлы контейнера board и парсит их frontmatter", () => {
		h.feed.replaceFile("GTD/Board.md", [
			boardTask({ filePath: "GTD/Board.md", container: "board" }),
		]);
		h.feed.replaceFile("notes.md", [boardTask({ filePath: "notes.md" })]);
		h.frontmatters.set("GTD/Board.md", {
			"gtd-board": true,
			id: "dev",
			columns: [{ id: "todo", match: "#kanban/dev/todo" }],
		});

		const { boards, errors } = h.service.discoverBoards();
		expect(errors).toEqual([]);
		expect(boards).toHaveLength(1);
		expect(boards[0]!.path).toBe("GTD/Board.md");
		expect(boards[0]!.def.id).toBe("dev");
	});

	it("битый frontmatter и отсутствие frontmatter собираются в errors", () => {
		h.feed.replaceFile("bad.md", [boardTask({ filePath: "bad.md", container: "board" })]);
		h.feed.replaceFile("gone.md", [boardTask({ filePath: "gone.md", container: "board" })]);
		h.frontmatters.set("bad.md", { "gtd-board": true }); // нет id и columns

		const { boards, errors } = h.service.discoverBoards();
		expect(boards).toEqual([]);
		expect(errors.map((e) => e.path).sort()).toEqual(["bad.md", "gone.md"]);
		expect(errors.find((e) => e.path === "bad.md")!.error).toMatch(/columns/);
	});

	it("несколько задач одного файла дают одну доску; пути отсортированы", () => {
		for (const p of ["b.md", "a.md"]) {
			h.feed.replaceFile(p, [
				boardTask({ filePath: p, container: "board", lineStart: 1 }),
				boardTask({ filePath: p, container: "board", lineStart: 2, description: "две" }),
			]);
			h.frontmatters.set(p, { id: p, columns: [{ id: "c", match: "status:todo" }] });
		}
		const { boards } = h.service.discoverBoards();
		expect(boards.map((b) => b.path)).toEqual(["a.md", "b.md"]);
	});
});

// ---------------------------------------------------------------------------
// boardModel
// ---------------------------------------------------------------------------

describe("BoardService.boardModel", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});

	it("раскладывает активные задачи по колонкам и применяет order", () => {
		const a = boardTask({ filePath: "x.md", taskId: "a", key: "id:a", tags: ["#kanban/dev/todo"] });
		const b = boardTask({ filePath: "x.md", taskId: "b", key: "id:b", tags: ["#kanban/dev/todo"] });
		const c = boardTask({ filePath: "x.md", taskId: "c", key: "id:c", tags: ["#kanban/dev/doing"] });
		const off = boardTask({ filePath: "x.md", key: "off", tags: [] }); // без тега — не на доске
		h.feed.replaceFile("x.md", [a, b, c, off]);

		const def: BoardDef = { ...TAG_BOARD, order: { todo: ["b", "a"] } };
		const model = h.service.boardModel("Board.md", def);
		expect(model.columns.map((col) => col.id)).toEqual(["todo", "doing"]);
		expect(model.columns[0]!.tasks.map((t) => t.taskId)).toEqual(["b", "a"]);
		expect(model.columns[1]!.tasks.map((t) => t.taskId)).toEqual(["c"]);
	});

	it("scope 'path:' сужает охват по префиксу пути", () => {
		h.feed.replaceFile("GTD/work.md", [
			boardTask({ filePath: "GTD/work.md", tags: ["#kanban/dev/todo"] }),
		]);
		h.feed.replaceFile("other.md", [
			boardTask({ filePath: "other.md", tags: ["#kanban/dev/todo"] }),
		]);

		const def: BoardDef = { ...TAG_BOARD, scope: "path:GTD/" };
		const model = h.service.boardModel("Board.md", def);
		expect(model.columns[0]!.tasks.map((t) => t.filePath)).toEqual(["GTD/work.md"]);
	});

	it("неактивные задачи не попадают на тег-доску: done уходит с доски, tickler спрятан", () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", key: "d", statusChar: "x", tags: ["#kanban/dev/todo"] }),
			boardTask({ filePath: "x.md", key: "t", start: "2026-08-01", tags: ["#kanban/dev/todo"] }),
			boardTask({ filePath: "x.md", key: "ok", tags: ["#kanban/dev/todo"] }),
		]);
		const model = h.service.boardModel("Board.md", TAG_BOARD);
		expect(model.columns[0]!.tasks.map((t) => t.key)).toEqual(["ok"]);
	});

	it("доска со status:done показывает выполненные в done-колонке", () => {
		h.feed.replaceFile("b.md", [
			boardTask({ filePath: "b.md", key: "w", container: "board" }),
			boardTask({ filePath: "b.md", key: "g", container: "board", statusChar: "/" }),
			boardTask({ filePath: "b.md", key: "d", container: "board", statusChar: "x" }),
			boardTask({ filePath: "b.md", key: "c", container: "board", statusChar: "-" }),
		]);
		const model = h.service.boardModel("b.md", STATUS_BOARD);
		expect(model.columns.map((col) => col.tasks.map((t) => t.key))).toEqual([
			["w"],
			["g"],
			["d"], // cancelled 'c' не попадает никуда
		]);
	});

	it("TEMPLATE/DETAIL не протекают на статус-доску даже выполненными", () => {
		h.feed.replaceFile("tpl.md", [
			boardTask({ filePath: "tpl.md", key: "tpl", container: "recurring", statusChar: "x" }),
			boardTask({ filePath: "tpl.md", key: "card", container: "card", statusChar: "x" }),
		]);
		const model = h.service.boardModel("b.md", STATUS_BOARD);
		expect(model.columns[2]!.tasks).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// moveCard
// ---------------------------------------------------------------------------

describe("BoardService.moveCard", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});

	it("двухфазность: сначала dispatch move-column, потом patch frontmatter", async () => {
		const t = boardTask({
			filePath: "x.md",
			taskId: "a",
			key: "id:a",
			tags: ["#kanban/dev/todo"],
		});
		h.feed.replaceFile("x.md", [t]);

		const res = await h.service.moveCard("Board.md", TAG_BOARD, "id:a", "doing", 0);
		expect(res.ok).toBe(true);
		expect(h.queue).toEqual(["dispatch", "patch"]);
		expect(h.dispatcher.intents[0]).toEqual({
			type: "move-column",
			key: "id:a",
			fromTag: "#kanban/dev/todo",
			toTag: "#kanban/dev/doing",
			index: 0,
		});
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({ doing: ["a"] });
	});

	it("вставка в позицию между существующими карточками колонки", async () => {
		const mk = (id: string, tag: string): Task =>
			boardTask({ filePath: "x.md", taskId: id, key: "id:" + id, tags: [tag] });
		h.feed.replaceFile("x.md", [
			mk("a", "#kanban/dev/doing"),
			mk("b", "#kanban/dev/doing"),
			mk("m", "#kanban/dev/todo"),
		]);
		h.frontmatters.set("Board.md", { order: { doing: ["a", "b"] } });

		const def: BoardDef = { ...TAG_BOARD, order: { doing: ["a", "b"] } };
		await h.service.moveCard("Board.md", def, "id:m", "doing", 1);
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({ doing: ["a", "m", "b"] });
	});

	it("отказ фазы 1 отменяет фазу 2", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", taskId: "a", key: "id:a", tags: ["#kanban/dev/todo"] }),
		]);
		h.dispatcher.result = { ok: false, reason: "line-not-found" };

		const res = await h.service.moveCard("Board.md", TAG_BOARD, "id:a", "doing", 0);
		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(h.queue).toEqual(["dispatch"]);
		expect(h.patched).toEqual([]);
	});

	it("group-by: status — intent несёт toStatusChar и дату для ✅ (как set-status), теги не трогаются", async () => {
		h.feed.replaceFile("b.md", [
			boardTask({ filePath: "b.md", taskId: "a", key: "id:a", container: "board" }),
		]);
		await h.service.moveCard("b.md", STATUS_BOARD, "id:a", "done", 0);
		expect(h.dispatcher.intents[0]).toEqual({
			type: "move-column",
			key: "id:a",
			fromTag: null,
			toTag: null,
			toStatusChar: "x",
			date: "2026-07-15",
			index: 0,
		});
		expect(h.frontmatters.get("b.md")!["order"]).toEqual({ done: ["a"] });
	});

	it("drag из Done в Todo несёт дату — трансформ снимет устаревший ✅ теми же правилами, что set-status", async () => {
		// регресс: раньше intent шёл без date и move-column менял только статус,
		// оставляя ✅ на незакрытой строке (или [x] без ✅ при drag в Done)
		h.feed.replaceFile("b.md", [
			boardTask({ filePath: "b.md", taskId: "a", key: "id:a", container: "board", statusChar: "x" }),
		]);
		await h.service.moveCard("b.md", STATUS_BOARD, "id:a", "todo", 0);
		expect(h.dispatcher.intents[0]).toEqual({
			type: "move-column",
			key: "id:a",
			fromTag: null,
			toTag: null,
			toStatusChar: " ",
			date: "2026-07-15",
			index: 0,
		});
	});

	it("тег-доска: intent без date — статус и даты ✅/❌ не трогаются", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", taskId: "a", key: "id:a", tags: ["#kanban/dev/todo"] }),
		]);
		await h.service.moveCard("Board.md", TAG_BOARD, "id:a", "doing", 0);
		expect(h.dispatcher.intents[0]).not.toHaveProperty("date");
		expect(h.dispatcher.intents[0]).not.toHaveProperty("toStatusChar");
	});

	it("drop в ту же колонку = только перестановка порядка, без intent", async () => {
		const mk = (id: string): Task =>
			boardTask({ filePath: "x.md", taskId: id, key: "id:" + id, tags: ["#kanban/dev/todo"] });
		h.feed.replaceFile("x.md", [mk("a"), mk("b"), mk("c")]);
		const def: BoardDef = { ...TAG_BOARD, order: { todo: ["a", "b", "c"] } };

		// перенос 'a' под 'c': видимый индекс 3 (считая саму 'a')
		await h.service.moveCard("Board.md", def, "id:a", "todo", 3);
		expect(h.queue).toEqual(["patch"]);
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({ todo: ["b", "c", "a"] });
	});

	it("задача без 🆔: после фазы 1 id перечитывается из feed", async () => {
		const bare = boardTask({ filePath: "x.md", key: "x.md#L0", tags: ["#kanban/dev/todo"] });
		h.feed.replaceFile("x.md", [bare]);
		// симуляция ленивой вставки 🆔 write-back-ом: к моменту фазы 2 индекс уже перечитан
		h.dispatcher.onDispatch = () => {
			h.feed.replaceFile("x.md", [{ ...bare, taskId: "fresh" }]);
		};

		await h.service.moveCard("Board.md", TAG_BOARD, "x.md#L0", "doing", 0);
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({ doing: ["fresh"] });
	});

	it("🆔 так и не появился (дебаунс реиндексации) — порядок не пишем, но intent прошёл", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", key: "x.md#L0", tags: ["#kanban/dev/todo"] }),
		]);
		const res = await h.service.moveCard("Board.md", TAG_BOARD, "x.md#L0", "doing", 0);
		expect(res.ok).toBe(true);
		expect(h.queue).toEqual(["dispatch"]);
		expect(h.patched).toEqual([]);
	});

	it("неизвестная задача или колонка — отказ без записей", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", taskId: "a", key: "id:a", tags: ["#kanban/dev/todo"] }),
		]);
		expect(await h.service.moveCard("B.md", TAG_BOARD, "id:ghost", "doing", 0)).toEqual({
			ok: false,
			reason: "task-not-found",
		});
		expect(await h.service.moveCard("B.md", TAG_BOARD, "id:a", "ghost", 0)).toEqual({
			ok: false,
			reason: "column-not-found",
		});
		expect(h.queue).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// reorderCard
// ---------------------------------------------------------------------------

describe("BoardService.reorderCard", () => {
	it("пишет порядок через patchOrder, вычищая id из прочих колонок", async () => {
		const h = makeHarness();
		h.frontmatters.set("Board.md", { order: { todo: ["a", "b"], doing: ["c"] } });
		await h.service.reorderCard("Board.md", "doing", ["b", "c"]);
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({
			todo: ["a"],
			doing: ["b", "c"],
		});
	});
});

// ---------------------------------------------------------------------------
// чистые помощники
// ---------------------------------------------------------------------------

describe("insertIntoColumnOrder", () => {
	const vis = (ids: Array<string | null>): Task[] =>
		ids.map((id, i) =>
			makeTask({ filePath: "x.md", lineStart: i, ...(id !== null ? { taskId: id, key: "id:" + id } : {}) }),
		);

	it("вставляет id на видимую позицию", () => {
		expect(insertIntoColumnOrder(vis(["a", "b"]), "m", 1)).toEqual(["a", "m", "b"]);
	});

	it("перенос внутри колонки вниз: собственная позиция не считается", () => {
		expect(insertIntoColumnOrder(vis(["a", "b", "c"]), "a", 3)).toEqual(["b", "c", "a"]);
	});

	it("задачи без 🆔 не управляют позицией, но участвуют в видимом индексе", () => {
		// видимый список: [a, <без id>, b]; вставка на видимую позицию 2 → между «без id» и b
		expect(insertIntoColumnOrder(vis(["a", null, "b"]), "m", 2)).toEqual(["a", "m", "b"]);
	});

	it("индекс за пределами списка кладёт в конец", () => {
		expect(insertIntoColumnOrder(vis(["a"]), "m", 99)).toEqual(["a", "m"]);
	});
});

describe("inScope / normalizeOrder", () => {
	it("без scope и с не-path scope — всё в охвате", () => {
		const t = makeTask({ filePath: "any.md" });
		expect(inScope(t, undefined)).toBe(true);
		expect(inScope(t, "#sometag")).toBe(true);
		expect(inScope(t, "path:other/")).toBe(false);
	});

	it("normalizeOrder терпит мусор в frontmatter", () => {
		expect(normalizeOrder(undefined)).toEqual({});
		expect(normalizeOrder([1, 2])).toEqual({});
		expect(normalizeOrder({ a: ["x", 5, "y"], b: "no" })).toEqual({ a: ["x", "y"] });
	});
});
