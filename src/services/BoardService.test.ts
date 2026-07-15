import { beforeEach, describe, expect, it } from "vitest";
import type { BoardDef } from "../core/board/boardFile";
import type { Task } from "../core/model/Task";
import { FakeFeed, makeTask } from "../stores/testSupport";
import {
	BoardService,
	insertIntoColumnOrder,
	normalizeOrder,
	slugifyColumnName,
	uniqueColId,
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
	skippedColumns: [],
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

	it("упразднённая status-колонка не валит доску, но поверхностится как warning", () => {
		h.feed.replaceFile("GTD/Board.md", [
			boardTask({ filePath: "GTD/Board.md", container: "board" }),
		]);
		h.frontmatters.set("GTD/Board.md", {
			"gtd-board": true,
			id: "dev",
			columns: [
				{ id: "todo", match: "#kanban/dev/todo" },
				{ id: "done", name: "Готово", match: "status:done" },
			],
		});

		const { boards, errors } = h.service.discoverBoards();
		expect(boards).toHaveLength(1);
		expect(boards[0]!.def.columns.map((c) => c.id)).toEqual(["todo"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.path).toBe("GTD/Board.md");
		expect(errors[0]!.error).toMatch(/status-матчи упразднены/);
	});

	it("несколько задач одного файла дают одну доску; пути отсортированы", () => {
		for (const p of ["b.md", "a.md"]) {
			h.feed.replaceFile(p, [
				boardTask({ filePath: p, container: "board", lineStart: 1 }),
				boardTask({ filePath: p, container: "board", lineStart: 2, description: "две" }),
			]);
			h.frontmatters.set(p, { id: p, columns: [{ id: "c", match: "#c" }] });
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

	it("done и cancelled видны в своей тег-колонке (зачёркнутость — дело TaskCard)", () => {
		// раунд 3: колонки развязаны со статусом — выполненная/отменённая карточка
		// остаётся в своей тег-колонке, а не уходит с доски
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", key: "d", statusChar: "x", tags: ["#kanban/dev/todo"] }),
			boardTask({ filePath: "x.md", key: "c", statusChar: "-", tags: ["#kanban/dev/doing"] }),
			boardTask({ filePath: "x.md", key: "a", tags: ["#kanban/dev/todo"] }),
		]);
		const model = h.service.boardModel("Board.md", TAG_BOARD);
		expect(model.columns[0]!.tasks.map((t) => t.key).sort()).toEqual(["a", "d"]);
		expect(model.columns[1]!.tasks.map((t) => t.key)).toEqual(["c"]);
	});

	it("TICKLER (🛫 в будущем) спрятан; задачи прочих статусов видны", () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", key: "t", start: "2026-08-01", tags: ["#kanban/dev/todo"] }),
			boardTask({ filePath: "x.md", key: "ok", tags: ["#kanban/dev/todo"] }),
			boardTask({ filePath: "x.md", key: "done", statusChar: "x", tags: ["#kanban/dev/todo"] }),
		]);
		const model = h.service.boardModel("Board.md", TAG_BOARD);
		expect(model.columns[0]!.tasks.map((t) => t.key).sort()).toEqual(["done", "ok"]);
	});

	it("scope: задача с тегом ДРУГОЙ доски не попадает", () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", key: "mine", tags: ["#kanban/dev/todo"] }),
			boardTask({ filePath: "x.md", key: "alien", tags: ["#kanban/other/todo"] }),
		]);
		const model = h.service.boardModel("Board.md", TAG_BOARD);
		expect(model.columns[0]!.tasks.map((t) => t.key)).toEqual(["mine"]);
	});

	it("чужая задача из другого файла без тега колонки не протекает на доску", () => {
		// живой баг: «пометил в календаре сделанной → появилась на чужой доске»
		h.feed.replaceFile("b.md", [
			boardTask({ filePath: "b.md", key: "own", container: "board", tags: ["#kanban/dev/todo"] }),
		]);
		h.feed.replaceFile("other.md", [
			boardTask({ filePath: "other.md", key: "foreign", statusChar: "x" }),
		]);
		const model = h.service.boardModel("b.md", TAG_BOARD);
		expect(model.columns[0]!.tasks.map((t) => t.key)).toEqual(["own"]);
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

	it("done-карточку можно перетащить в другую тег-колонку (статус не трогается)", async () => {
		// раунд 3: колонки развязаны со статусом — перенос выражает только теги
		const t = boardTask({
			filePath: "x.md",
			taskId: "a",
			key: "id:a",
			statusChar: "x",
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
		// статус/даты в интенте отсутствуют — перенос не выражает done/undone
		expect(h.dispatcher.intents[0]).not.toHaveProperty("date");
		expect(h.dispatcher.intents[0]).not.toHaveProperty("toStatusChar");
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({ doing: ["a"] });
	});

	it("отменённую (-) карточку тоже можно перетащить", async () => {
		const t = boardTask({
			filePath: "x.md",
			taskId: "a",
			key: "id:a",
			statusChar: "-",
			tags: ["#kanban/dev/todo"],
		});
		h.feed.replaceFile("x.md", [t]);

		const res = await h.service.moveCard("Board.md", TAG_BOARD, "id:a", "doing", 0);
		expect(res.ok).toBe(true);
		expect(h.queue).toEqual(["dispatch", "patch"]);
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

	it("память вписанных 🆔 (knownTaskId) спасает фазу порядка при протухшем индексе", async () => {
		// Регрессия живой верификации: drag из входящих — индекс ещё без 🆔,
		// но WritebackService помнит id, который сам записал в строку.
		const bare = boardTask({ filePath: "x.md", key: "x.md#L0", tags: ["#kanban/dev/todo"] });
		h.feed.replaceFile("x.md", [bare]);
		const service = new BoardService({
			feed: h.feed,
			dispatcher: { dispatch: async () => ({ ok: true }) },
			readFrontmatter: () => null,
			patchFrontmatter: async (path, fn) => {
				const fm: Record<string, unknown> = {};
				fn(fm);
				h.patched.push({ path, fm });
			},
			knownTaskId: (key) => (key === "x.md#L0" ? "sb9khe" : null),
		});

		const res = await service.moveCard("Board.md", TAG_BOARD, "x.md#L0", "doing", 0);
		expect(res.ok).toBe(true);
		expect(h.patched).toHaveLength(1);
		expect(h.patched[0]?.fm["order"]).toEqual({ doing: ["sb9khe"] });
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
// addColumn / renameColumn
// ---------------------------------------------------------------------------

describe("BoardService.addColumn", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		h.frontmatters.set("Board.md", {
			"gtd-board": true,
			id: "dev",
			columns: [
				{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
				{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
			],
			order: { todo: ["a"] },
		});
	});

	it("добавляет колонку с tag-match и пустым order", async () => {
		const res = await h.service.addColumn("Board.md", "Review");
		expect(res).toEqual({ ok: true, colId: "review" });
		const fm = h.frontmatters.get("Board.md")!;
		expect(fm["columns"]).toEqual([
			{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
			{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
			{ id: "review", name: "Review", match: "#kanban/dev/review" },
		]);
		// существующий порядок не тронут, новой колонке — пустой список
		expect(fm["order"]).toEqual({ todo: ["a"], review: [] });
	});

	it("кириллическое имя транслитерируется в slug", async () => {
		const res = await h.service.addColumn("Board.md", "В работе");
		expect(res).toEqual({ ok: true, colId: "v-rabote" });
		const cols = h.frontmatters.get("Board.md")!["columns"] as Array<Record<string, unknown>>;
		expect(cols[2]).toEqual({ id: "v-rabote", name: "В работе", match: "#kanban/dev/v-rabote" });
	});

	it("коллизия id разрешается суффиксом", async () => {
		const res = await h.service.addColumn("Board.md", "Todo");
		expect(res).toEqual({ ok: true, colId: "todo-2" });
	});

	it("имя без ASCII/кириллицы — fallback colN", async () => {
		const res = await h.service.addColumn("Board.md", "🔥🔥");
		expect(res).toEqual({ ok: true, colId: "col1" });
		const cols = h.frontmatters.get("Board.md")!["columns"] as Array<Record<string, unknown>>;
		expect(cols[2]!["match"]).toBe("#kanban/dev/col1");
	});

	it("на status-доске новая колонка ВСЁ РАВНО tag-match (смешанные match допустимы)", async () => {
		h.frontmatters.set("st.md", {
			id: "st",
			"group-by": "status",
			columns: [{ id: "todo", match: "status:todo" }],
		});
		const res = await h.service.addColumn("st.md", "Ожидает");
		expect(res).toEqual({ ok: true, colId: "ozhidaet" });
		const cols = h.frontmatters.get("st.md")!["columns"] as Array<Record<string, unknown>>;
		expect(cols[1]!["match"]).toBe("#kanban/st/ozhidaet");
		// order отсутствовал во frontmatter — создаётся с пустым списком
		expect(h.frontmatters.get("st.md")!["order"]).toEqual({ ozhidaet: [] });
	});

	it("нет frontmatter / битая доска / пустое имя — отказ без записей", async () => {
		expect(await h.service.addColumn("gone.md", "X")).toEqual({
			ok: false,
			reason: "board-not-found",
		});
		h.frontmatters.set("bad.md", { "gtd-board": true }); // нет id и columns
		const bad = await h.service.addColumn("bad.md", "X");
		expect(bad.ok).toBe(false);
		expect(bad.reason).toMatch(/columns/);
		expect(await h.service.addColumn("Board.md", "   ")).toEqual({
			ok: false,
			reason: "empty-name",
		});
		expect(h.patched).toEqual([]);
	});
});

describe("BoardService.renameColumn", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		h.frontmatters.set("Board.md", {
			id: "dev",
			columns: [
				{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
				{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
			],
		});
	});

	it("меняет только display name — match и id не тронуты", async () => {
		const res = await h.service.renameColumn("Board.md", "todo", "Очередь");
		expect(res).toEqual({ ok: true, colId: "todo" });
		expect(h.frontmatters.get("Board.md")!["columns"]).toEqual([
			{ id: "todo", name: "Очередь", match: "#kanban/dev/todo" },
			{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
		]);
	});

	it("несуществующая колонка / пустое имя / нет доски — отказ без записей", async () => {
		expect(await h.service.renameColumn("Board.md", "ghost", "X")).toEqual({
			ok: false,
			reason: "column-not-found",
		});
		expect(await h.service.renameColumn("Board.md", "todo", "  ")).toEqual({
			ok: false,
			reason: "empty-name",
		});
		expect(await h.service.renameColumn("gone.md", "todo", "X")).toEqual({
			ok: false,
			reason: "board-not-found",
		});
		expect(h.patched).toEqual([]);
	});
});

describe("slugifyColumnName / uniqueColId", () => {
	it("латиница, пробелы и мусорные символы", () => {
		expect(slugifyColumnName("In Progress")).toBe("in-progress");
		expect(slugifyColumnName("  Done!!  ")).toBe("done");
		expect(slugifyColumnName("a--b__c")).toBe("a-b-c");
	});

	it("кириллица по таблице, включая шипящие и мягкий знак", () => {
		expect(slugifyColumnName("Ждущие")).toBe("zhduschie");
		expect(slugifyColumnName("Проверь ёж")).toBe("prover-ezh");
		expect(slugifyColumnName("Юля")).toBe("yulya");
	});

	it("пусто/эмодзи → пустой slug; uniqueColId даёт colN", () => {
		expect(slugifyColumnName("🔥")).toBe("");
		expect(uniqueColId("🔥", new Set())).toBe("col1");
		expect(uniqueColId("🔥", new Set(["col1", "col2"]))).toBe("col3");
	});

	it("коллизии получают числовой суффикс", () => {
		expect(uniqueColId("Todo", new Set(["doing"]))).toBe("todo");
		expect(uniqueColId("Todo", new Set(["todo"]))).toBe("todo-2");
		expect(uniqueColId("Todo", new Set(["todo", "todo-2"]))).toBe("todo-3");
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

describe("normalizeOrder", () => {
	it("normalizeOrder терпит мусор в frontmatter", () => {
		expect(normalizeOrder(undefined)).toEqual({});
		expect(normalizeOrder([1, 2])).toEqual({});
		expect(normalizeOrder({ a: ["x", 5, "y"], b: "no" })).toEqual({ a: ["x", "y"] });
	});
});
