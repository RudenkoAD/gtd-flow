import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../core/model/Task";
import { type NamespaceFilter } from "../core/namespace/namespace";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { FakeFeed, makeTask } from "../stores/testSupport";
import { MOVE_DEBOUNCE_MS, ProjectService } from "./ProjectService";
import type { IntentDispatcher, WritePort } from "./WritebackService";

// ---------------------------------------------------------------------------
// Обвязка (по образцу WritebackService.test.ts / BoardService.test.ts)
// ---------------------------------------------------------------------------

/** Фейковый порт записи поверх in-memory Map; пишет вызовы в общую очередь. */
class FakePort implements WritePort {
	readonly files = new Map<string, string>();
	/** Фактические записи (изменившие содержимое). */
	readonly writes: Array<{ path: string; content: string }> = [];
	calls = 0;

	constructor(private readonly queue: string[]) {}

	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		this.calls++;
		this.queue.push("process");
		const content = this.files.get(path);
		if (content === undefined) return false; // файла нет — transform не зовём (как VaultAdapter)
		const next = transform(content);
		if (next === null || next === content) return false;
		this.files.set(path, next);
		this.writes.push({ path, content: next });
		return true;
	}
}

interface Harness {
	feed: FakeFeed;
	port: FakePort;
	frontmatters: Map<string, Record<string, unknown>>;
	queue: string[];
	/** Пути файлов с флагом gtd-project (деп containerPaths); тест наполняет вручную. */
	containers: Set<string>;
	/** Пути, для которых звался ensureFile. */
	ensured: string[];
	svc: ProjectService;
	patchCount: () => number;
}

function makeHarness(
	opts: {
		today?: string;
		genId?: () => string;
		nsFilter?: () => NamespaceFilter;
		/** Тесты recovery раскладки: первые N patch-операций имитируют отказ диска. */
		failPatches?: number;
	} = {},
): Harness {
	const queue: string[] = [];
	const feed = new FakeFeed(opts.today ?? "2026-07-15");
	const port = new FakePort(queue);
	const frontmatters = new Map<string, Record<string, unknown>>();
	const containers = new Set<string>();
	const ensured: string[] = [];
	let failedPatches = opts.failPatches ?? 0;
	// dispatcher графовыми транзакциями не используется — заглушка
	const dispatcher: IntentDispatcher = { dispatch: () => Promise.resolve({ ok: true }) };
	const svc = new ProjectService({
		feed,
		write: port,
		readFrontmatter: (p) => frontmatters.get(p) ?? null,
		patchFrontmatter: async (p, fn) => {
			queue.push("patch");
			if (failedPatches > 0) {
				failedPatches--;
				throw new Error("disk-full");
			}
			// живой frontmatter: мутация как в processFrontMatter
			const fm = frontmatters.get(p) ?? {};
			fn(fm);
			frontmatters.set(p, fm);
		},
		ensureFile: async (p) => {
			queue.push("ensure");
			ensured.push(p);
		},
		containerPaths: () => [...containers],
		...(opts.nsFilter !== undefined ? { namespaceFilter: opts.nsFilter } : {}),
		dispatcher,
		todayIso: () => feed.today(),
		genId: opts.genId,
	});
	return {
		feed,
		port,
		frontmatters,
		queue,
		containers,
		ensured,
		svc,
		patchCount: () => queue.filter((q) => q === "patch").length,
	};
}

/** Файл проекта: строки → задачи (container 'project') в индекс + текст в порт. */
function loadProject(
	h: Harness,
	path: string,
	lines: string[],
	fm?: Record<string, unknown>,
): void {
	const tasks: Task[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = parseTaskLine(lines[i]!, {
			filePath: path,
			lineStart: i,
			parentLine: null,
			heading: null,
			container: "project",
			projectActive: true,
		});
		if (t !== null) tasks.push(t);
	}
	h.feed.replaceFile(path, tasks);
	h.port.files.set(path, lines.join("\n") + "\n");
	if (fm !== undefined) h.frontmatters.set(path, fm);
}

const P = "Projects/Ремонт.md";

// ---------------------------------------------------------------------------
// discoverProjects
// ---------------------------------------------------------------------------

describe("ProjectService.discoverProjects", () => {
	it("находит только файлы контейнера project; имя и статус — из frontmatter", () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] задача 🆔 aa1"], { name: "Ремонт кухни", status: "on-hold" });
		h.feed.replaceFile("notes.md", [makeTask({ filePath: "notes.md" })]); // plain — не проект

		const list = h.svc.discoverProjects();

		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ path: P, name: "Ремонт кухни", status: "on-hold" });
	});

	it("без frontmatter: имя из basename, статус active", () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] задача"]);

		const list = h.svc.discoverProjects();
		expect(list[0]).toMatchObject({ name: "Ремонт", status: "active" });
	});

	it("неизвестный статус — fail-closed on-hold (как в snapshotHelpers)", () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] задача"], { status: "чепуха" });
		expect(h.svc.discoverProjects()[0]!.status).toBe("on-hold");
	});

	it("complete: все члены DONE/CANCELLED и есть хотя бы один", () => {
		const h = makeHarness();
		loadProject(h, "a.md", ["- [x] готово ✅ 2026-07-01", "- [-] отменено"]);
		loadProject(h, "b.md", ["- [x] готово ✅ 2026-07-01", "- [ ] открыто"]);

		const byPath = new Map(h.svc.discoverProjects().map((s) => [s.path, s]));
		expect(byPath.get("a.md")!.complete).toBe(true);
		expect(byPath.get("b.md")!.complete).toBe(false);
	});

	it("stalled: есть eligible, но ни одного ready/DOING", () => {
		const h = makeHarness();
		// все eligible заблокированы (битая зависимость ⇒ blocked, fail-closed)
		loadProject(h, "stalled.md", ["- [x] A 🆔 aa1 ✅ 2026-07-01", "- [ ] B 🆔 bb2 ⛔ zz9"]);
		// есть готовый корень — не стагнация
		loadProject(h, "ready.md", ["- [ ] A 🆔 cc1", "- [ ] B 🆔 cc2 ⛔ cc1"]);
		// DOING двигает проект, даже если остальные blocked
		loadProject(h, "doing.md", ["- [/] A 🆔 dd1", "- [ ] B 🆔 dd2 ⛔ zz9"]);
		// всё выполнено — eligible нет вовсе ⇒ не stalled
		loadProject(h, "done.md", ["- [x] A ✅ 2026-07-01"]);

		const byPath = new Map(h.svc.discoverProjects().map((s) => [s.path, s]));
		expect(byPath.get("stalled.md")!.stalled).toBe(true);
		expect(byPath.get("ready.md")!.stalled).toBe(false);
		expect(byPath.get("doing.md")!.stalled).toBe(false);
		expect(byPath.get("done.md")!.stalled).toBe(false);
	});

	it("список отсортирован по пути", () => {
		const h = makeHarness();
		loadProject(h, "b.md", ["- [ ] б"]);
		loadProject(h, "a.md", ["- [ ] а"]);
		expect(h.svc.discoverProjects().map((s) => s.path)).toEqual(["a.md", "b.md"]);
	});

	it("пустой контейнер (флаг есть, задач ноль) виден через containerPaths", () => {
		// NUX: файла нет в индексе задач, приходит из containerPaths; summarize устойчив к 0 задач
		const h = makeHarness();
		h.containers.add("GTD/Пусто.md");
		h.frontmatters.set("GTD/Пусто.md", { "gtd-project": true, name: "Пустой" });

		const list = h.svc.discoverProjects();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			path: "GTD/Пусто.md",
			name: "Пустой",
			status: "active",
			complete: false,
		});
	});

	it("dedupe: файл и в индексе задач, и в containerPaths — один проект", () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] задача 🆔 aa1"], { name: "Ремонт" });
		h.containers.add(P);
		expect(h.svc.discoverProjects()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// discoverProjects — фильтр по активному пространству
// ---------------------------------------------------------------------------

describe("ProjectService.discoverProjects: фильтр по пространству", () => {
	const DEFS = [
		{ name: "Работа", root: "Work" },
		{ name: "Жизнь", root: "Личное" },
	];

	function seedTwoProjects(h: Harness): void {
		h.containers.add("Work/Проекты/Релиз.md");
		h.containers.add("Личное/Проекты/Отпуск.md");
		h.frontmatters.set("Work/Проекты/Релиз.md", { "gtd-project": true, name: "Релиз" });
		h.frontmatters.set("Личное/Проекты/Отпуск.md", { "gtd-project": true, name: "Отпуск" });
	}

	it("активное именованное пространство показывает только свои проекты", () => {
		let active = "Работа";
		const h = makeHarness({ nsFilter: () => ({ active, defs: DEFS }) });
		seedTwoProjects(h);

		expect(h.svc.discoverProjects().map((s) => s.path)).toEqual(["Work/Проекты/Релиз.md"]);
		active = "Жизнь";
		expect(h.svc.discoverProjects().map((s) => s.path)).toEqual(["Личное/Проекты/Отпуск.md"]);
	});

	it("пустой defs ⇒ фильтр прозрачен (оба проекта)", () => {
		const h = makeHarness({ nsFilter: () => ({ active: "Работа", defs: [] }) });
		seedTwoProjects(h);
		expect(h.svc.discoverProjects()).toHaveLength(2);
	});

	it("явный filter (пофайловый вид) ПЕРЕБИВАЕТ инжектированный namespaceFilter", () => {
		// инжектированный — «Работа», но вид передаёт локальный «Жизнь»
		const h = makeHarness({ nsFilter: () => ({ active: "Работа", defs: DEFS }) });
		seedTwoProjects(h);
		expect(h.svc.discoverProjects({ active: "Жизнь", defs: DEFS }).map((s) => s.path)).toEqual([
			"Личное/Проекты/Отпуск.md",
		]);
	});

	it("gtd-namespace override уводит проект в другое пространство", () => {
		const h = makeHarness({ nsFilter: () => ({ active: "Жизнь", defs: DEFS }) });
		h.containers.add("Work/Проекты/Личный.md");
		h.frontmatters.set("Work/Проекты/Личный.md", {
			"gtd-project": true,
			"gtd-namespace": "Жизнь",
			name: "Личный",
		});
		expect(h.svc.discoverProjects().map((s) => s.path)).toEqual(["Work/Проекты/Личный.md"]);
	});
});

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe("ProjectService.createProject", () => {
	it("ensureFile + frontmatter gtd-project и name; строго ensure→patch", async () => {
		const h = makeHarness();

		const res = await h.svc.createProject("GTD/Ремонт.md", "Ремонт кухни");

		expect(res).toEqual({ ok: true, path: "GTD/Ремонт.md" });
		expect(h.ensured).toEqual(["GTD/Ремонт.md"]);
		expect(h.queue).toEqual(["ensure", "patch"]);
		expect(h.frontmatters.get("GTD/Ремонт.md")).toEqual({
			"gtd-project": true,
			name: "Ремонт кухни",
		});
	});

	it("созданный проект сразу виден discovery через containerPaths", async () => {
		const h = makeHarness();
		await h.svc.createProject("P.md", "Проект");
		h.containers.add("P.md");
		const list = h.svc.discoverProjects();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ path: "P.md", name: "Проект", status: "active" });
	});

	it("идемпотентно: существующий gtd-project файл не перезаписывается", async () => {
		const h = makeHarness();
		h.frontmatters.set("P.md", { "gtd-project": true, name: "Старое", status: "on-hold" });

		const res = await h.svc.createProject("P.md", "Новое");

		expect(res).toEqual({ ok: true, path: "P.md" });
		expect(h.frontmatters.get("P.md")).toEqual({
			"gtd-project": true,
			name: "Старое",
			status: "on-hold",
		});
	});

	it("пустое имя — отказ без ensureFile/записи", async () => {
		const h = makeHarness();
		expect(await h.svc.createProject("P.md", "   ")).toEqual({
			ok: false,
			reason: "empty-name",
		});
		expect(h.ensured).toEqual([]);
		expect(h.patchCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

describe("ProjectService.model", () => {
	it("null для файла-не-проекта и для неизвестного пути", () => {
		const h = makeHarness();
		h.feed.replaceFile("notes.md", [makeTask({ filePath: "notes.md" })]);
		expect(h.svc.model("notes.md")).toBeNull();
		expect(h.svc.model("нет.md")).toBeNull();
	});

	it("узлы/рёбра/issues из graphEngine + нормализация layout из frontmatter", () => {
		const h = makeHarness();
		loadProject(
			h,
			P,
			["- [x] A 🆔 aa1 ✅ 2026-07-10", "- [ ] B 🆔 bb2 ⛔ aa1", "- [ ] C 🆔 cc3 ⛔ bb2,qq9"],
			{
				layout: {
					aa1: { x: 0, y: 0 },
					bb2: { x: 260, y: -80 },
					zzz: { x: 1, y: 1 }, // не член — вычищается
					cc3: "мусор", // невалидная позиция — в missing
				},
			},
		);

		const m = h.svc.model(P)!;

		expect(m.nodes.map((n) => [n.id, n.state])).toEqual([
			["aa1", "done"],
			["bb2", "ready"],
			["cc3", "blocked"],
		]);
		expect(m.edges).toEqual([
			{ from: "aa1", to: "bb2" },
			{ from: "bb2", to: "cc3" },
		]);
		expect(m.issues).toEqual([expect.objectContaining({ kind: "broken-dep", depId: "qq9" })]);
		expect(m.layout).toEqual({ aa1: { x: 0, y: 0 }, bb2: { x: 260, y: -80 } });
	});

	it("cross-file зависимость — ghost-узел; layout адресует только членов", () => {
		const h = makeHarness();
		h.feed.replaceFile("Другое.md", [
			makeTask({ filePath: "Другое.md", taskId: "ext1", key: "id:ext1" }),
		]);
		loadProject(h, P, ["- [ ] M 🆔 mm1 ⛔ ext1"], {
			layout: { mm1: { x: 0, y: 0 }, ext1: { x: 9, y: 9 } },
		});

		const m = h.svc.model(P)!;

		expect(m.nodes.map((n) => [n.id, n.ghost])).toEqual([
			["mm1", false],
			["ext1", true],
		]);
		expect(m.edges).toEqual([{ from: "ext1", to: "mm1" }]);
		expect(m.layout).toEqual({ mm1: { x: 0, y: 0 } }); // ext1 — не член, выброшен
	});

	it("пустой файл-проект (gtd-project в frontmatter, задач нет) — пустая модель, не null", () => {
		const h = makeHarness();
		h.frontmatters.set(P, { "gtd-project": true });
		expect(h.svc.model(P)).toEqual({ nodes: [], edges: [], issues: [], layout: {} });
	});

	it("today приходит из todayIso: 🛫 в будущем — deferred, после смены дня — ready", () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] X 🆔 xx1 🛫 2026-08-01"]);

		expect(h.svc.model(P)!.nodes[0]!.state).toBe("deferred");
		h.feed.rollover("2026-08-02");
		expect(h.svc.model(P)!.nodes[0]!.state).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// wouldCreateCycle
// ---------------------------------------------------------------------------

describe("ProjectService.wouldCreateCycle", () => {
	it("возвращает путь цикла по текущему индексу; безопасное ребро — null", () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2 ⛔ aa1", "- [ ] C 🆔 cc3 ⛔ bb2"]);

		expect(h.svc.wouldCreateCycle(P, "aa1", "cc3")).toBeNull();
		expect(h.svc.wouldCreateCycle(P, "bb2", "aa1")).toEqual(["aa1", "bb2"]);
		expect(h.svc.wouldCreateCycle(P, "cc3", "aa1")).toEqual(["aa1", "bb2", "cc3"]);
	});
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe("ProjectService.connect", () => {
	it("happy: ⛔-список цели += fromId одной записью", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2 ⛔ aa1", "- [ ] C 🆔 cc3"]);

		const res = await h.svc.connect(P, "bb2", "cc3");

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toBe(
			"- [ ] A 🆔 aa1\n- [ ] B 🆔 bb2 ⛔ aa1\n- [ ] C 🆔 cc3 ⛔ bb2\n",
		);
		expect(h.port.writes).toHaveLength(1);
	});

	it("append к существующему списку: ⛔ aa1 → ⛔ aa1,cc3", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2 ⛔ aa1", "- [ ] C 🆔 cc3"]);

		const res = await h.svc.connect(P, "cc3", "bb2");

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toContain("- [ ] B 🆔 bb2 ⛔ aa1,cc3");
	});

	it("цикл: отказ с путём ДО записи (порт не тронут)", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2 ⛔ aa1"]);

		const res = await h.svc.connect(P, "bb2", "aa1");

		expect(res).toEqual({ ok: false, reason: "cycle", cyclePath: ["aa1", "bb2"] });
		expect(h.port.calls).toBe(0);
	});

	it("само-ребро — отказ без записи", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1"]);

		const res = await h.svc.connect(P, "aa1", "aa1");

		expect(res).toEqual({ ok: false, reason: "self" });
		expect(h.port.calls).toBe(0);
	});

	it("дубль по индексу — no-op {ok:true} без обращения к порту", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2 ⛔ aa1"]);

		const res = await h.svc.connect(P, "aa1", "bb2");

		expect(res).toEqual({ ok: true });
		expect(h.port.calls).toBe(0);
	});

	it("дубль по фактическому содержимому (индекс отстал) — no-op {ok:true} без записи", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2"]);
		h.port.files.set(P, "- [ ] A 🆔 aa1\n- [ ] B 🆔 bb2 ⛔ aa1\n");

		const res = await h.svc.connect(P, "aa1", "bb2");

		expect(res).toEqual({ ok: true });
		expect(h.port.writes).toHaveLength(0);
	});

	it("концы обязаны быть членами проекта с 🆔 (авторинг только внутри проекта)", async () => {
		const h = makeHarness();
		h.feed.replaceFile("Другое.md", [
			makeTask({ filePath: "Другое.md", taskId: "ext1", key: "id:ext1" }),
		]);
		loadProject(h, P, ["- [ ] A 🆔 aa1"]);

		expect(await h.svc.connect(P, "ext1", "aa1")).toEqual({
			ok: false,
			reason: "source-not-found",
		});
		expect(await h.svc.connect(P, "aa1", "ext1")).toEqual({
			ok: false,
			reason: "target-not-found",
		});
		expect(h.port.calls).toBe(0);
	});

	it("fail-closed при дублях 🆔 среди членов", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] A' 🆔 aa1", "- [ ] B 🆔 bb2"]);

		const res = await h.svc.connect(P, "aa1", "bb2");

		expect(res).toEqual({ ok: false, reason: "duplicate-id" });
		expect(h.port.calls).toBe(0);
	});

	it("гонка в окне реиндексации: цикл ловится по фактическому содержимому файла", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb1"]);

		// Первое ребро записано в файл; индекс НАРОЧНО не обновляем —
		// имитация дебаунса реиндексации (два быстрых connect подряд с полотна)
		expect(await h.svc.connect(P, "aa1", "bb1")).toEqual({ ok: true });
		const res = await h.svc.connect(P, "bb1", "aa1");

		expect(res).toEqual({ ok: false, reason: "cycle", cyclePath: ["aa1", "bb1"] });
		// файл не тронут вторым connect — цикла A↔B на диске нет
		expect(h.port.files.get(P)).toBe("- [ ] A 🆔 aa1\n- [ ] B 🆔 bb1 ⛔ aa1\n");
		expect(h.port.writes).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe("ProjectService.disconnect", () => {
	it("убирает ровно fromId из многоэлементного списка", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2", "- [ ] C 🆔 cc3 ⛔ bb2,aa1"]);

		const res = await h.svc.disconnect(P, "bb2", "cc3");

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toContain("- [ ] C 🆔 cc3 ⛔ aa1");
	});

	it("последняя зависимость: пустой список удаляет поле ⛔ целиком", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2 ⛔ aa1"]);

		const res = await h.svc.disconnect(P, "aa1", "bb2");

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toBe("- [ ] A 🆔 aa1\n- [ ] B 🆔 bb2\n");
	});

	it("ребра нет — no-op {ok:true} без записи", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [ ] B 🆔 bb2"]);

		const res = await h.svc.disconnect(P, "aa1", "bb2");

		expect(res).toEqual({ ok: true });
		expect(h.port.writes).toHaveLength(0);
	});

	it("цель не найдена — отказ без записи", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1"]);

		expect(await h.svc.disconnect(P, "aa1", "нет")).toEqual({
			ok: false,
			reason: "target-not-found",
		});
		expect(h.port.calls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// addNode
// ---------------------------------------------------------------------------

describe("ProjectService.addNode", () => {
	it("двухфазность: строка с eager 🆔 и ➕ после последней задачи, затем layout", async () => {
		const h = makeHarness({ genId: () => "gg1" });
		loadProject(h, P, ["# Проект", "", "- [ ] A 🆔 aa1", "", "Примечание"], {});

		const res = await h.svc.addNode(P, "новая", 10, 20);

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toBe(
			"# Проект\n\n- [ ] A 🆔 aa1\n- [ ] новая 🆔 gg1 ➕ 2026-07-15\n\nПримечание\n",
		);
		expect(h.frontmatters.get(P)!["layout"]).toEqual({ gg1: { x: 10, y: 20 } });
		// строго: сначала строка (processFile), потом позиция (patchFrontmatter)
		expect(h.queue).toEqual(["process", "patch"]);
	});

	it("файл без задач: строка аппендится в конец", async () => {
		const h = makeHarness({ genId: () => "gg1" });
		h.port.files.set(P, "");

		const res = await h.svc.addNode(P, "первая", 0, 0);

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toBe("- [ ] первая 🆔 gg1 ➕ 2026-07-15\n");
	});

	it("eager 🆔: занятый в индексе id пропускается", async () => {
		let n = 0;
		const ids = ["aa1", "bb2"];
		const h = makeHarness({ genId: () => ids[n++ % ids.length]! });
		loadProject(h, P, ["- [ ] A 🆔 aa1"]);

		const res = await h.svc.addNode(P, "новая", 1, 2);

		expect(res).toEqual({ ok: true });
		expect(h.port.files.get(P)).toContain("🆔 bb2");
		expect(h.frontmatters.get(P)!["layout"]).toEqual({ bb2: { x: 1, y: 2 } });
	});

	it("генератор зациклился на занятом id → id-collision, ноль записей", async () => {
		const h = makeHarness({ genId: () => "aa1" });
		loadProject(h, P, ["- [ ] A 🆔 aa1"]);

		const res = await h.svc.addNode(P, "новая", 1, 2);

		expect(res).toEqual({ ok: false, reason: "id-collision" });
		expect(h.port.calls).toBe(0);
		expect(h.patchCount()).toBe(0);
	});

	it("файла нет → file-not-found, layout не трогаем", async () => {
		const h = makeHarness({ genId: () => "gg1" });

		const res = await h.svc.addNode(P, "новая", 1, 2);

		expect(res).toEqual({ ok: false, reason: "file-not-found" });
		expect(h.patchCount()).toBe(0);
	});

	it("пустой/многострочный текст — invalid-text без записей", async () => {
		const h = makeHarness({ genId: () => "gg1" });
		h.port.files.set(P, "");

		expect(await h.svc.addNode(P, "   ", 0, 0)).toEqual({ ok: false, reason: "invalid-text" });
		expect(await h.svc.addNode(P, "a\nb", 0, 0)).toEqual({ ok: false, reason: "invalid-text" });
		expect(h.port.calls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

describe("ProjectService.deleteNode", () => {
	it("одна транзакция: строка + вычистка 🆔 из всех ⛔; layout и unblocked", async () => {
		const h = makeHarness();
		loadProject(
			h,
			P,
			[
				"- [ ] A 🆔 aa1",
				"- [ ] B 🆔 bb2 ⛔ aa1",
				"- [ ] C 🆔 cc3 ⛔ aa1,dd4",
				"- [ ] D 🆔 dd4",
			],
			{ layout: { aa1: { x: 0, y: 0 }, bb2: { x: 1, y: 1 } } },
		);

		const res = await h.svc.deleteNode(P, "aa1");

		// B разблокировался; C всё ещё ждёт dd4 — не считается
		expect(res).toEqual({ ok: true, unblocked: 1 });
		expect(h.port.files.get(P)).toBe("- [ ] B 🆔 bb2\n- [ ] C 🆔 cc3 ⛔ dd4\n- [ ] D 🆔 dd4\n");
		expect(h.port.writes).toHaveLength(1); // строка и все ⛔ — одной записью
		expect(h.frontmatters.get(P)!["layout"]).toEqual({ bb2: { x: 1, y: 1 } });
	});

	it("done-зависимые не входят в unblocked", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1", "- [x] B 🆔 bb2 ⛔ aa1 ✅ 2026-07-01"]);

		const res = await h.svc.deleteNode(P, "aa1");
		expect(res).toEqual({ ok: true, unblocked: 0 });
	});

	it("узел без 🆔 адресуется своим key (content-key)", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] безайди", "- [ ] сосед 🆔 aa1"]);
		const victim = h.feed
			.getIndex()
			.fileTasks(P)
			.find((t) => t.taskId === null)!;

		const res = await h.svc.deleteNode(P, victim.key);

		expect(res).toEqual({ ok: true, unblocked: 0 });
		expect(h.port.files.get(P)).toBe("- [ ] сосед 🆔 aa1\n");
	});

	it("неизвестный узел → node-not-found без записей", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1"]);

		expect(await h.svc.deleteNode(P, "нет")).toEqual({ ok: false, reason: "node-not-found" });
		expect(h.port.calls).toBe(0);
	});

	it("строка уже исчезла → line-not-found, layout не трогаем", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 aa1"], { layout: { aa1: { x: 0, y: 0 } } });
		h.port.files.set(P, "просто текст\n");

		const res = await h.svc.deleteNode(P, "aa1");

		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(h.patchCount()).toBe(0);
		expect(h.frontmatters.get(P)!["layout"]).toEqual({ aa1: { x: 0, y: 0 } });
	});

	it("дубль-носители 🆔 (след sync-схождения): удаляется только строка — рёбра ⛔ и layout выжившего целы", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 n1", "- [ ] A-копия 🆔 n1", "- [ ] C 🆔 c1 ⛔ n1"], {
			layout: { n1: { x: 3, y: 4 }, c1: { x: 5, y: 6 } },
		});

		const res = await h.svc.deleteNode(P, "n1");

		// выживший носитель n1 держит ребро C→n1: ⛔ не вычищен, C по-прежнему blocked
		expect(res).toEqual({ ok: true, unblocked: 0 });
		expect(h.port.files.get(P)).toBe("- [ ] A-копия 🆔 n1\n- [ ] C 🆔 c1 ⛔ n1\n");
		// layout выжившего не удалён — patchFrontmatter вовсе не звался
		expect(h.patchCount()).toBe(0);
		expect(h.frontmatters.get(P)!["layout"]).toEqual({
			n1: { x: 3, y: 4 },
			c1: { x: 5, y: 6 },
		});
	});

	it("дублей нет — вычистка ⛔ и layout идёт как раньше (негативный контроль)", async () => {
		const h = makeHarness();
		loadProject(h, P, ["- [ ] A 🆔 n1", "- [ ] C 🆔 c1 ⛔ n1"], {
			layout: { n1: { x: 3, y: 4 }, c1: { x: 5, y: 6 } },
		});

		const res = await h.svc.deleteNode(P, "n1");

		expect(res).toEqual({ ok: true, unblocked: 1 });
		expect(h.port.files.get(P)).toBe("- [ ] C 🆔 c1\n");
		expect(h.frontmatters.get(P)!["layout"]).toEqual({ c1: { x: 5, y: 6 } });
	});
});

// ---------------------------------------------------------------------------
// moveNodes — коалесценция с дебаунсом
// ---------------------------------------------------------------------------

describe("ProjectService.moveNodes", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("вызовы вспышки коалесцируются в одну patchFrontmatter; поздняя позиция побеждает", async () => {
		const h = makeHarness();
		h.frontmatters.set(P, {});

		const p1 = h.svc.moveNodes(P, [{ id: "a", x: 1, y: 2 }]);
		const p2 = h.svc.moveNodes(P, [
			{ id: "b", x: 3, y: 4 },
			{ id: "a", x: 9, y: 9 },
		]);

		expect(p1).toBe(p2); // одна вспышка — один общий Promise
		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS - 1);
		expect(h.patchCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await p1;

		expect(h.patchCount()).toBe(1);
		expect(h.frontmatters.get(P)!["layout"]).toEqual({
			a: { x: 9, y: 9 },
			b: { x: 3, y: 4 },
		});
	});

	it("каждый вызов перезапускает дебаунс", async () => {
		const h = makeHarness();
		h.frontmatters.set(P, {});

		void h.svc.moveNodes(P, [{ id: "a", x: 1, y: 1 }]);
		await vi.advanceTimersByTimeAsync(200);
		const p = h.svc.moveNodes(P, [{ id: "a", x: 2, y: 2 }]);
		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS - 1);
		expect(h.patchCount()).toBe(0); // таймер сброшен вторым вызовом
		await vi.advanceTimersByTimeAsync(1);
		await p;

		expect(h.patchCount()).toBe(1);
		expect(h.frontmatters.get(P)!["layout"]).toEqual({ a: { x: 2, y: 2 } });
	});

	it("коалесценция по path: разные проекты — независимые батчи", async () => {
		const h = makeHarness();
		h.frontmatters.set("a.md", {});
		h.frontmatters.set("b.md", {});

		const pa = h.svc.moveNodes("a.md", [{ id: "x", x: 1, y: 1 }]);
		const pb = h.svc.moveNodes("b.md", [{ id: "y", x: 2, y: 2 }]);
		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS);
		await Promise.all([pa, pb]);

		expect(h.patchCount()).toBe(2);
		expect(h.frontmatters.get("a.md")!["layout"]).toEqual({ x: { x: 1, y: 1 } });
		expect(h.frontmatters.get("b.md")!["layout"]).toEqual({ y: { x: 2, y: 2 } });
	});

	it("чужие записи layout сохраняются", async () => {
		const h = makeHarness();
		h.frontmatters.set(P, { layout: { old: { x: 5, y: 5 } } });

		const p = h.svc.moveNodes(P, [{ id: "a", x: 1, y: 1 }]);
		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS);
		await p;

		expect(h.frontmatters.get(P)!["layout"]).toEqual({
			old: { x: 5, y: 5 },
			a: { x: 1, y: 1 },
		});
	});

	it("flushPending пишет немедленно; таймер после этого не даёт второй записи", async () => {
		const h = makeHarness();
		h.frontmatters.set(P, {});

		const p = h.svc.moveNodes(P, [{ id: "a", x: 1, y: 1 }]);
		await h.svc.flushPending();
		await p;
		expect(h.patchCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS);
		expect(h.patchCount()).toBe(1); // сброшенный батч не повторяется
	});

	it("после отказа patchFrontmatter сохраняет позиции и повторяет их при следующем жесте", async () => {
		const h = makeHarness({ failPatches: 1 });
		h.frontmatters.set(P, {});

		const failed = h.svc.moveNodes(P, [{ id: "a", x: 1, y: 1 }]);
		const failure = expect(failed).rejects.toThrow("disk-full");
		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS);
		await failure;

		const retried = h.svc.moveNodes(P, [{ id: "b", x: 2, y: 2 }]);
		await vi.advanceTimersByTimeAsync(MOVE_DEBOUNCE_MS);
		await retried;
		expect(h.frontmatters.get(P)!["layout"]).toEqual({
			a: { x: 1, y: 1 },
			b: { x: 2, y: 2 },
		});
	});
});

// ---------------------------------------------------------------------------
// setProjectStatus
// ---------------------------------------------------------------------------

describe("ProjectService.setProjectStatus", () => {
	it("пишет status в frontmatter, не трогая прочие ключи", async () => {
		const h = makeHarness();
		h.frontmatters.set(P, { "gtd-project": true, name: "Ремонт", status: "active" });

		await h.svc.setProjectStatus(P, "done");

		expect(h.frontmatters.get(P)).toEqual({
			"gtd-project": true,
			name: "Ремонт",
			status: "done",
		});
	});
});
