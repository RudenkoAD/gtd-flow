import { beforeEach, describe, expect, it } from "vitest";
import type { BoardDef } from "../core/board/boardFile";
import type { Task } from "../core/model/Task";
import { FakeFeed, makeTask } from "../stores/testSupport";
import {
	BoardService,
	insertIntoColumnOrder,
	normalizeOrder,
	secureBoardIdSuffix,
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
	/** Очередь ответов для компенсационных многошаговых операций. */
	results: IntentResult[] = [];
	onDispatch: (() => void) | null = null;

	constructor(private readonly queue: string[]) {}

	dispatch(intent: unknown): Promise<IntentResult> {
		this.intents.push(intent);
		this.queue.push("dispatch");
		this.onDispatch?.();
		return Promise.resolve(this.results.shift() ?? this.result);
	}
}

interface Harness {
	feed: FakeFeed;
	dispatcher: FakeDispatcher;
	queue: string[];
	frontmatters: Map<string, Record<string, unknown>>;
	patched: Array<{ path: string; fm: Record<string, unknown> }>;
	/** Пути файлов с флагом gtd-board (деп containerPaths); тест наполняет вручную. */
	containers: Set<string>;
	/** Пути, для которых звался ensureFile. */
	ensured: string[];
	/** Управляемый отказ записи frontmatter (проверяет rollback moveCard). */
	patchFailures: { remaining: number };
	service: BoardService;
}

function sequentialBoardIdSuffix(): () => string {
	let sequence = 0;
	return () => `test${++sequence}`;
}

function boardIdSuffixes(...suffixes: string[]): () => string {
	let index = 0;
	return () => suffixes[Math.min(index++, suffixes.length - 1)]!;
}

function makeHarness(
	_legacyPathFilter?: () => unknown,
	genBoardIdSuffix: () => string = sequentialBoardIdSuffix(),
): Harness {
	const queue: string[] = [];
	const feed = new FakeFeed("2026-07-15");
	const dispatcher = new FakeDispatcher(queue);
	const frontmatters = new Map<string, Record<string, unknown>>();
	const patched: Array<{ path: string; fm: Record<string, unknown> }> = [];
	const containers = new Set<string>();
	const ensured: string[] = [];
	const patchFailures = { remaining: 0 };
	const service = new BoardService({
		feed,
		dispatcher,
		readFrontmatter: (path) => frontmatters.get(path) ?? null,
		patchFrontmatter: async (path, fn) => {
			queue.push("patch");
			if (patchFailures.remaining > 0) {
				patchFailures.remaining--;
				throw new Error("disk-full");
			}
			// живой frontmatter: мутация как в processFrontMatter
			const fm = frontmatters.get(path) ?? {};
			fn(fm);
			frontmatters.set(path, fm);
			patched.push({ path, fm });
		},
		ensureFile: async (path) => {
			queue.push("ensure");
			ensured.push(path);
		},
		containerPaths: () => [...containers],
		genBoardIdSuffix,
	});
	return {
		feed,
		dispatcher,
		queue,
		frontmatters,
		patched,
		containers,
		ensured,
		patchFailures,
		service,
	};
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

describe("secureBoardIdSuffix", () => {
	it("uses getRandomValues to produce a tag-safe UUID v4 when randomUUID is unavailable", () => {
		const suffix = secureBoardIdSuffix({
			getRandomValues: (bytes) => {
				for (let i = 0; i < bytes.length; i++) bytes[i] = i;
				return bytes;
			},
		});
		expect(suffix).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
		expect(suffix).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	});

	it("does not fall back to Math.random when secure Web Crypto is unavailable", () => {
		expect(() => secureBoardIdSuffix({})).toThrow("secure-board-id-generator-unavailable");
	});
});

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

	it("пустой контейнер (флаг есть, задач ноль) виден discovery через containerPaths", () => {
		// NUX: файла нет в индексе задач, но он помечен gtd-board — приходит из containerPaths
		h.containers.add("GTD/Empty.md");
		h.frontmatters.set("GTD/Empty.md", {
			"gtd-board": true,
			id: "empty",
			columns: [{ id: "todo", match: "#kanban/empty/todo" }],
		});

		const { boards, errors } = h.service.discoverBoards();
		expect(errors).toEqual([]);
		expect(boards).toHaveLength(1);
		expect(boards[0]!.path).toBe("GTD/Empty.md");
	});

	it("dedupe: файл и в индексе задач, и в containerPaths — одна доска", () => {
		h.feed.replaceFile("GTD/Board.md", [
			boardTask({ filePath: "GTD/Board.md", container: "board" }),
		]);
		h.containers.add("GTD/Board.md");
		h.frontmatters.set("GTD/Board.md", {
			"gtd-board": true,
			id: "dev",
			columns: [{ id: "todo", match: "#kanban/dev/todo" }],
		});

		const { boards } = h.service.discoverBoards();
		expect(boards).toHaveLength(1);
	});

	it("пустой контейнер с битым frontmatter по-прежнему уходит в errors", () => {
		h.containers.add("bad.md");
		h.frontmatters.set("bad.md", { "gtd-board": true }); // нет id и columns

		const { boards, errors } = h.service.discoverBoards();
		expect(boards).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.error).toMatch(/columns/);
	});
});

// ---------------------------------------------------------------------------
// discoverBoards — фильтр по активному пространству
// ---------------------------------------------------------------------------

describe("BoardService.discoverBoards: фильтр по пространству", () => {
	const DEFS = [
		{ name: "Работа", root: "Work" },
		{ name: "Жизнь", root: "Личное" },
	];

	function seedTwoBoards(h: Harness): void {
		h.containers.add("Work/Доски/Спринт.md");
		h.containers.add("Личное/Доски/Дом.md");
		h.frontmatters.set("Work/Доски/Спринт.md", {
			"gtd-board": true,
			id: "sprint",
			columns: [{ id: "todo", match: "#kanban/sprint/todo" }],
		});
		h.frontmatters.set("Личное/Доски/Дом.md", {
			"gtd-board": true,
			id: "home",
			columns: [{ id: "todo", match: "#kanban/home/todo" }],
		});
	}

	it("обнаруживает доски глобально, независимо от старого активного пространства", () => {
		let active = "Работа";
		const h = makeHarness(() => ({ active, defs: DEFS }));
		seedTwoBoards(h);

		expect(
			h.service
				.discoverBoards()
				.boards.map((b) => b.path)
				.sort(),
		).toEqual(["Work/Доски/Спринт.md", "Личное/Доски/Дом.md"].sort());
		active = "Жизнь";
		expect(
			h.service
				.discoverBoards()
				.boards.map((b) => b.path)
				.sort(),
		).toEqual(["Work/Доски/Спринт.md", "Личное/Доски/Дом.md"].sort());
	});

	it("пустой defs ⇒ фильтр прозрачен (обе доски)", () => {
		const h = makeHarness(() => ({ active: "Работа", defs: [] }));
		seedTwoBoards(h);
		expect(h.service.discoverBoards().boards).toHaveLength(2);
	});

	it("discoverBoards не принимает path-based filter", () => {
		const h = makeHarness(() => ({ active: "Работа", defs: DEFS }));
		seedTwoBoards(h);
		expect(
			h.service
				.discoverBoards()
				.boards.map((b) => b.path)
				.sort(),
		).toEqual(["Work/Доски/Спринт.md", "Личное/Доски/Дом.md"].sort());
	});

	it("legacy gtd-namespace не влияет на обнаружение доски", () => {
		const h = makeHarness(() => ({ active: "Жизнь", defs: DEFS }));
		h.containers.add("Work/Доски/Личная.md");
		h.frontmatters.set("Work/Доски/Личная.md", {
			"gtd-board": true,
			"gtd-namespace": "Жизнь",
			id: "personal",
			columns: [{ id: "todo", match: "#kanban/personal/todo" }],
		});
		// физически в Work/, но override → видна в «Жизни»
		expect(h.service.discoverBoards().boards.map((b) => b.path)).toEqual([
			"Work/Доски/Личная.md",
		]);
	});

	it("createBoard видит id ВСЕХ пространств (уникальность #kanban/<id> глобальна)", async () => {
		const h = makeHarness(
			() => ({ active: "Работа", defs: DEFS }),
			boardIdSuffixes("taken", "fresh"),
		);
		seedTwoBoards(h);
		// Есть доска в «Жизни» с ровно тем id, который первым предложил генератор.
		// createBoard обязан увидеть её несмотря на active namespace «Работа».
		h.frontmatters.set("Личное/Доски/Дом.md", {
			"gtd-board": true,
			id: "home-taken",
			columns: [{ id: "todo", match: "#kanban/home-taken/todo" }],
		});
		const res = await h.service.createBoard("Work/Доски/home.md", "home");
		expect(res.ok).toBe(true);
		const created = h.frontmatters.get("Work/Доски/home.md")!;
		expect(created["id"]).toBe("home-fresh");
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
		const a = boardTask({
			filePath: "x.md",
			taskId: "a",
			key: "id:a",
			tags: ["#kanban/dev/todo"],
		});
		const b = boardTask({
			filePath: "x.md",
			taskId: "b",
			key: "id:b",
			tags: ["#kanban/dev/todo"],
		});
		const c = boardTask({
			filePath: "x.md",
			taskId: "c",
			key: "id:c",
			tags: ["#kanban/dev/doing"],
		});
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
			boardTask({
				filePath: "x.md",
				key: "t",
				start: "2026-08-01",
				tags: ["#kanban/dev/todo"],
			}),
			boardTask({ filePath: "x.md", key: "ok", tags: ["#kanban/dev/todo"] }),
			boardTask({
				filePath: "x.md",
				key: "done",
				statusChar: "x",
				tags: ["#kanban/dev/todo"],
			}),
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
			boardTask({
				filePath: "b.md",
				key: "own",
				container: "board",
				tags: ["#kanban/dev/todo"],
			}),
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
			boardTask({
				filePath: "x.md",
				taskId: id,
				key: "id:" + id,
				tags: ["#kanban/dev/todo"],
			});
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
			ensureFile: async () => undefined,
			containerPaths: () => [],
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

	it("отказ записи order компенсирует уже перенесённый тег колонки", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({ filePath: "x.md", taskId: "a", key: "id:a", tags: ["#kanban/dev/todo"] }),
		]);
		h.patchFailures.remaining = 1;

		const res = await h.service.moveCard("Board.md", TAG_BOARD, "id:a", "doing", 0);

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("order-write-failed");
		expect(h.dispatcher.intents).toEqual([
			{
				type: "move-column",
				key: "id:a",
				fromTag: "#kanban/dev/todo",
				toTag: "#kanban/dev/doing",
				index: 0,
			},
			{
				type: "move-column",
				key: "id:a",
				fromTag: "#kanban/dev/doing",
				toTag: "#kanban/dev/todo",
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// moveCardFromTickler — составная операция с компенсацией
// ---------------------------------------------------------------------------

describe("BoardService.moveCardFromTickler", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});

	it("снимает 🛫 и переносит тег/порядок как одну логическую операцию", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({
				filePath: "x.md",
				taskId: "a",
				key: "id:a",
				start: "2026-07-20",
				startTime: "09:30",
				startTimeEnd: "10:00",
				tags: ["#kanban/dev/todo"],
			}),
		]);

		const res = await h.service.moveCardFromTickler("Board.md", TAG_BOARD, "id:a", "doing", 0);

		expect(res).toEqual({ ok: true });
		expect(h.dispatcher.intents).toEqual([
			{ type: "set-date", key: "id:a", field: "start", date: null },
			{
				type: "move-column",
				key: "id:a",
				fromTag: "#kanban/dev/todo",
				toTag: "#kanban/dev/doing",
				index: 0,
			},
		]);
		expect(h.frontmatters.get("Board.md")!["order"]).toEqual({ doing: ["a"] });
	});

	it("если перенос колонки отклонён, восстанавливает полный 🛫 вместо скрытой полузадачи", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({
				filePath: "x.md",
				taskId: "a",
				key: "id:a",
				start: "2026-07-20",
				startTime: "09:30",
				startTimeEnd: "10:00",
				tags: ["#kanban/dev/todo"],
			}),
		]);
		h.dispatcher.results = [
			{ ok: true },
			{ ok: false, reason: "line-not-found" },
			{ ok: true },
		];

		const res = await h.service.moveCardFromTickler("Board.md", TAG_BOARD, "id:a", "doing", 0);

		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(h.dispatcher.intents).toEqual([
			{ type: "set-date", key: "id:a", field: "start", date: null },
			{
				type: "move-column",
				key: "id:a",
				fromTag: "#kanban/dev/todo",
				toTag: "#kanban/dev/doing",
				index: 0,
			},
			{
				type: "set-date",
				key: "id:a",
				field: "start",
				date: "2026-07-20",
				time: "09:30",
				timeEnd: "10:00",
			},
		]);
		expect(h.patched).toEqual([]);
	});

	it("отказ записи order компенсирует и тег, и 🛫", async () => {
		h.feed.replaceFile("x.md", [
			boardTask({
				filePath: "x.md",
				taskId: "a",
				key: "id:a",
				start: "2026-07-20",
				tags: ["#kanban/dev/todo"],
			}),
		]);
		h.patchFailures.remaining = 1;

		const res = await h.service.moveCardFromTickler("Board.md", TAG_BOARD, "id:a", "doing", 0);

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("order-write-failed");
		expect(h.dispatcher.intents).toEqual([
			{ type: "set-date", key: "id:a", field: "start", date: null },
			{
				type: "move-column",
				key: "id:a",
				fromTag: "#kanban/dev/todo",
				toTag: "#kanban/dev/doing",
				index: 0,
			},
			{
				type: "move-column",
				key: "id:a",
				fromTag: "#kanban/dev/doing",
				toTag: "#kanban/dev/todo",
			},
			{
				type: "set-date",
				key: "id:a",
				field: "start",
				date: "2026-07-20",
				time: null,
				timeEnd: null,
			},
		]);
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
		expect(cols[2]).toEqual({
			id: "v-rabote",
			name: "В работе",
			match: "#kanban/dev/v-rabote",
		});
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

describe("BoardService.deleteColumn", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		h.frontmatters.set("Board.md", {
			"gtd-board": true,
			id: "dev",
			columns: [
				{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
				{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
				{ id: "done", name: "Done", match: "#kanban/dev/done" },
			],
			order: { todo: ["a"], doing: ["b"], done: ["c"] },
		});
	});

	it("убирает колонку из columns[] и ключ из order{}; прочее не тронуто", async () => {
		const res = await h.service.deleteColumn("Board.md", "doing");
		expect(res).toEqual({ ok: true, colId: "doing" });
		const fm = h.frontmatters.get("Board.md")!;
		expect(fm["columns"]).toEqual([
			{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
			{ id: "done", name: "Done", match: "#kanban/dev/done" },
		]);
		expect(fm["order"]).toEqual({ todo: ["a"], done: ["c"] });
	});

	it("несуществующая колонка / нет доски — отказ без записей", async () => {
		expect(await h.service.deleteColumn("Board.md", "ghost")).toEqual({
			ok: false,
			reason: "column-not-found",
		});
		expect(await h.service.deleteColumn("gone.md", "todo")).toEqual({
			ok: false,
			reason: "board-not-found",
		});
		expect(h.patched).toEqual([]);
	});
});

describe("BoardService.moveColumn", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		h.frontmatters.set("Board.md", {
			"gtd-board": true,
			id: "dev",
			columns: [
				{ id: "todo", name: "Todo", match: "#kanban/dev/todo" },
				{ id: "doing", name: "Doing", match: "#kanban/dev/doing" },
				{ id: "done", name: "Done", match: "#kanban/dev/done" },
			],
		});
	});

	const ids = (): string[] =>
		(h.frontmatters.get("Board.md")!["columns"] as Array<Record<string, unknown>>).map(
			(c) => c["id"] as string,
		);

	it("двигает вправо (+1)", async () => {
		const res = await h.service.moveColumn("Board.md", "todo", 1);
		expect(res).toEqual({ ok: true, colId: "todo" });
		expect(ids()).toEqual(["doing", "todo", "done"]);
	});

	it("двигает влево (-1)", async () => {
		await h.service.moveColumn("Board.md", "done", -1);
		expect(ids()).toEqual(["todo", "done", "doing"]);
	});

	it("кламп на левом краю — no-op {ok:true} без записи", async () => {
		const res = await h.service.moveColumn("Board.md", "todo", -1);
		expect(res).toEqual({ ok: true, colId: "todo" });
		expect(h.patched).toEqual([]);
		expect(ids()).toEqual(["todo", "doing", "done"]);
	});

	it("кламп на правом краю — no-op {ok:true} без записи", async () => {
		const res = await h.service.moveColumn("Board.md", "done", 1);
		expect(res).toEqual({ ok: true, colId: "done" });
		expect(h.patched).toEqual([]);
	});

	it("несуществующая колонка / нет доски — отказ", async () => {
		expect(await h.service.moveColumn("Board.md", "ghost", 1)).toEqual({
			ok: false,
			reason: "column-not-found",
		});
		expect(await h.service.moveColumn("gone.md", "todo", 1)).toEqual({
			ok: false,
			reason: "board-not-found",
		});
		expect(h.patched).toEqual([]);
	});
});

describe("BoardService.createBoard", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});

	it("ensureFile + frontmatter gtd-board с тремя дефолтными тег-колонками", async () => {
		const res = await h.service.createBoard("GTD/Моя доска.md", "Моя доска");
		expect(res).toEqual({ ok: true, path: "GTD/Моя доска.md" });
		expect(h.ensured).toEqual(["GTD/Моя доска.md"]);
		// ensureFile строго до записи frontmatter
		expect(h.queue).toEqual(["ensure", "patch"]);
		const fm = h.frontmatters.get("GTD/Моя доска.md")!;
		expect(fm["gtd-board"]).toBe(true);
		expect(fm["id"]).toBe("moya-doska-test1");
		expect(fm["name"]).toBe("Моя доска");
		expect(fm["columns"]).toEqual([
			{ id: "todo", name: "Очередь", match: "#kanban/moya-doska-test1/todo" },
			{ id: "doing", name: "В работе", match: "#kanban/moya-doska-test1/doing" },
			{ id: "done", name: "Готово", match: "#kanban/moya-doska-test1/done" },
		]);
	});

	it("созданная доска сразу парсится parseBoardFrontmatter без ошибок", async () => {
		await h.service.createBoard("B.md", "Dev");
		h.containers.add("B.md");
		const { boards, errors } = h.service.discoverBoards();
		expect(errors).toEqual([]);
		expect(boards).toHaveLength(1);
		expect(boards[0]!.def.columns.map((c) => c.id)).toEqual(["todo", "doing", "done"]);
	});

	it("id-fallback 'board' при имени без ASCII/кириллицы (эмодзи)", async () => {
		await h.service.createBoard("B.md", "🔥🔥");
		const fm = h.frontmatters.get("B.md")!;
		expect(fm["id"]).toBe("board-test1");
		expect(fm["name"]).toBe("🔥🔥");
	});

	it("идемпотентно: существующий gtd-board файл не перезаписывается", async () => {
		h.frontmatters.set("B.md", {
			"gtd-board": true,
			id: "custom",
			name: "Кастом",
			columns: [{ id: "x", name: "X", match: "#kanban/custom/x" }],
			order: { x: ["z"] },
		});
		const res = await h.service.createBoard("B.md", "Новое имя");
		expect(res).toEqual({ ok: true, path: "B.md" });
		// пользовательские колонки/порядок/имя целы
		expect(h.frontmatters.get("B.md")).toEqual({
			"gtd-board": true,
			id: "custom",
			name: "Кастом",
			columns: [{ id: "x", name: "X", match: "#kanban/custom/x" }],
			order: { x: ["z"] },
		});
	});

	it("пустое имя — отказ без ensureFile/записи", async () => {
		expect(await h.service.createBoard("B.md", "   ")).toEqual({
			ok: false,
			reason: "empty-name",
		});
		expect(h.ensured).toEqual([]);
		expect(h.patched).toEqual([]);
	});

	it("unavailable secure generator fails closed without frontmatter write", async () => {
		h = makeHarness(undefined, () => {
			throw new Error("secure-board-id-generator-unavailable");
		});
		expect(await h.service.createBoard("B.md", "Релиз")).toEqual({
			ok: false,
			reason: "id-generation-failed",
		});
		expect(h.patched).toEqual([]);
	});

	it("same-process collision suffix retry остаётся безопасным", async () => {
		h = makeHarness(undefined, boardIdSuffixes("same", "same", "next"));
		const [first, second] = await Promise.all([
			h.service.createBoard("A.md", "Релиз"),
			h.service.createBoard("B.md", "Релиз"),
		]);
		expect(first).toEqual({ ok: true, path: "A.md" });
		expect(second).toEqual({ ok: true, path: "B.md" });
		expect(h.frontmatters.get("A.md")?.["id"]).toBe("reliz-same");
		expect(h.frontmatters.get("B.md")?.["id"]).toBe("reliz-next");
	});

	it("повторно проверяет id внутри commit и retry-ит, если внешняя доска появилась после scan", async () => {
		const frontmatters = new Map<string, Record<string, unknown>>();
		const containers = new Set<string>();
		let injected = false;
		const service = new BoardService({
			feed: h.feed,
			dispatcher: h.dispatcher,
			readFrontmatter: (path) => frontmatters.get(path) ?? null,
			patchFrontmatter: async (path, fn) => {
				if (!injected) {
					injected = true;
					containers.add("External.md");
					frontmatters.set("External.md", {
						"gtd-board": true,
						id: "reliz-race",
						columns: [{ id: "todo", match: "#kanban/reliz-race/todo" }],
					});
				}
				const fm = frontmatters.get(path) ?? {};
				fn(fm);
				frontmatters.set(path, fm);
			},
			ensureFile: async () => undefined,
			containerPaths: () => [...containers],
			genBoardIdSuffix: boardIdSuffixes("race", "fresh"),
		});

		expect(await service.createBoard("Mine.md", "Релиз")).toEqual({
			ok: true,
			path: "Mine.md",
		});
		expect(frontmatters.get("Mine.md")?.["id"]).toBe("reliz-fresh");
	});

	it("independent stale services give same-named boards distinct ids and #kanban tags", async () => {
		const makeStaleService = (
			frontmatters: Map<string, Record<string, unknown>>,
			suffix: string,
		) =>
			new BoardService({
				feed: h.feed,
				dispatcher: h.dispatcher,
				// Each device has the same stale empty discovery when it creates its board.
				readFrontmatter: (path) => frontmatters.get(path) ?? null,
				patchFrontmatter: async (path, fn) => {
					const fm = frontmatters.get(path) ?? {};
					fn(fm);
					frontmatters.set(path, fm);
				},
				ensureFile: async () => undefined,
				containerPaths: () => [],
				genBoardIdSuffix: () => suffix,
			});

		const work = new Map<string, Record<string, unknown>>();
		const personal = new Map<string, Record<string, unknown>>();
		const left = makeStaleService(work, "device-a");
		const right = makeStaleService(personal, "device-b");

		await Promise.all([
			left.createBoard("Work/Доски/Релиз.md", "Релиз"),
			right.createBoard("Personal/Boards/Release.md", "Релиз"),
		]);

		const leftId = work.get("Work/Доски/Релиз.md")!["id"] as string;
		const rightId = personal.get("Personal/Boards/Release.md")!["id"] as string;
		expect(leftId).toBe("reliz-device-a");
		expect(rightId).toBe("reliz-device-b");
		expect(leftId).not.toBe(rightId);
		expect(work.get("Work/Доски/Релиз.md")!["columns"]).toContainEqual({
			id: "todo",
			name: "Очередь",
			match: "#kanban/reliz-device-a/todo",
		});
		expect(personal.get("Personal/Boards/Release.md")!["columns"]).toContainEqual({
			id: "todo",
			name: "Очередь",
			match: "#kanban/reliz-device-b/todo",
		});
	});

	it("generator collision retries a known id, then fails closed after the bounded limit", async () => {
		h = makeHarness(undefined, boardIdSuffixes("taken", "fresh"));
		h.containers.add("Existing.md");
		h.frontmatters.set("Existing.md", {
			"gtd-board": true,
			id: "reliz-taken",
			columns: [{ id: "todo", match: "#kanban/reliz-taken/todo" }],
		});

		expect(await h.service.createBoard("Mine.md", "Релиз")).toEqual({
			ok: true,
			path: "Mine.md",
		});
		expect(h.frontmatters.get("Mine.md")?.["id"]).toBe("reliz-fresh");

		let attempts = 0;
		h = makeHarness(undefined, () => {
			attempts++;
			return "taken";
		});
		h.containers.add("Existing.md");
		h.frontmatters.set("Existing.md", {
			"gtd-board": true,
			id: "reliz-taken",
			columns: [{ id: "todo", match: "#kanban/reliz-taken/todo" }],
		});

		expect(await h.service.createBoard("Mine.md", "Релиз")).toEqual({
			ok: false,
			reason: "id-allocation-conflict",
		});
		expect(attempts).toBe(32);
		expect(h.patched).toEqual([]);
	});
});

describe("BoardService.renameBoard", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		h.frontmatters.set("Board.md", {
			"gtd-board": true,
			id: "dev",
			name: "Dev",
			columns: [{ id: "todo", name: "Todo", match: "#kanban/dev/todo" }],
		});
	});

	it("меняет только name; id и колонки не тронуты", async () => {
		const res = await h.service.renameBoard("Board.md", "Разработка");
		expect(res).toEqual({ ok: true });
		expect(h.frontmatters.get("Board.md")).toEqual({
			"gtd-board": true,
			id: "dev",
			name: "Разработка",
			columns: [{ id: "todo", name: "Todo", match: "#kanban/dev/todo" }],
		});
	});

	it("пустое имя / нет доски — отказ без записи", async () => {
		expect(await h.service.renameBoard("Board.md", "  ")).toEqual({
			ok: false,
			reason: "empty-name",
		});
		expect(await h.service.renameBoard("gone.md", "X")).toEqual({
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
			makeTask({
				filePath: "x.md",
				lineStart: i,
				...(id !== null ? { taskId: id, key: "id:" + id } : {}),
			}),
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
