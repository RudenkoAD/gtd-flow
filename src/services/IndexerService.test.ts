import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContext, IsoDate } from "../core/model/Task";
import { computeKey } from "../core/parser/taskKey";
import { IndexerService, type IndexerDeps } from "./IndexerService";
import type { ClockPort, FileSnapshot, SnapshotListItem, VaultEvents } from "./types";

// --- синтетика: события, часы, снапшоты ---

class FakeEvents implements VaultEvents {
	private changed = new Set<(s: FileSnapshot) => void>();
	private deleted = new Set<(p: string) => void>();
	private renamed = new Set<(o: string, s: FileSnapshot) => void>();

	onChanged(cb: (s: FileSnapshot) => void): () => void {
		this.changed.add(cb);
		return () => {
			this.changed.delete(cb);
		};
	}
	onDeleted(cb: (p: string) => void): () => void {
		this.deleted.add(cb);
		return () => {
			this.deleted.delete(cb);
		};
	}
	onRenamed(cb: (o: string, s: FileSnapshot) => void): () => void {
		this.renamed.add(cb);
		return () => {
			this.renamed.delete(cb);
		};
	}

	emitChanged(s: FileSnapshot): void {
		for (const cb of [...this.changed]) cb(s);
	}
	emitDeleted(p: string): void {
		for (const cb of [...this.deleted]) cb(p);
	}
	emitRenamed(o: string, s: FileSnapshot): void {
		for (const cb of [...this.renamed]) cb(o, s);
	}
}

class FakeClock implements ClockPort {
	private cbs = new Set<() => void>();
	constructor(public today: IsoDate = "2026-07-15") {}

	todayIso(): IsoDate {
		return this.today;
	}
	onDayRollover(cb: () => void): () => void {
		this.cbs.add(cb);
		return () => {
			this.cbs.delete(cb);
		};
	}
	roll(next: IsoDate): void {
		this.today = next;
		for (const cb of [...this.cbs]) cb();
	}
}

const TASK_RE = /^\s*- \[(.)\] /;

/** Снапшот из текста: каждая строка вида "- [x] …" становится пунктом-задачей. */
function mkSnap(path: string, content: string, context?: Partial<FileContext>): FileSnapshot {
	const listItems: SnapshotListItem[] = [];
	content.split("\n").forEach((line, i) => {
		const m = TASK_RE.exec(line);
		if (m !== null)
			listItems.push({ lineStart: i, lineEnd: i, taskChar: m[1]!, parentLine: null, heading: null });
	});
	return { path, content, listItems, context: { path, container: "plain", ...context } };
}

async function* scanOf(...snaps: FileSnapshot[]): AsyncIterable<FileSnapshot> {
	for (const s of snaps) yield s;
}

interface Harness {
	events: FakeEvents;
	clock: FakeClock;
	indexer: IndexerService;
}

function makeIndexer(over?: Partial<IndexerDeps>): Harness {
	const events = new FakeEvents();
	const clock = new FakeClock();
	const indexer = new IndexerService({
		events,
		clock,
		initialScan: () => scanOf(),
		debounceMs: 100,
		...over,
	});
	return { events, clock, indexer };
}

function descriptions(indexer: IndexerService): string[] {
	return [...indexer.getIndex().all()].map((t) => t.description).sort();
}

afterEach(() => {
	vi.useRealTimers();
});

// --- первичный скан ---

describe("первичное наполнение", () => {
	it("чанки: уведомления по мере наполнения, onReady в конце", async () => {
		const snaps = [1, 2, 3, 4, 5].map((n) => mkSnap(`f${n}.md`, `- [ ] task ${n}`));
		let ready = 0;
		const epochsAtNotify: number[] = [];
		const { indexer } = makeIndexer({
			initialScan: () => scanOf(...snaps),
			chunkSize: 2,
			onReady: () => ready++,
		});
		indexer.onChange(() => epochsAtNotify.push(indexer.getEpoch()));

		await indexer.start();

		expect(ready).toBe(1);
		// 5 файлов чанками по 2: notify после 2-го, 4-го и финальный
		expect(epochsAtNotify).toEqual([2, 4, 5]);
		expect(descriptions(indexer)).toEqual(["task 1", "task 2", "task 3", "task 4", "task 5"]);
	});

	it("повторный start() — no-op", async () => {
		const { indexer } = makeIndexer({ initialScan: () => scanOf(mkSnap("a.md", "- [ ] x")) });
		await indexer.start();
		const epoch = indexer.getEpoch();
		await indexer.start();
		expect(indexer.getEpoch()).toBe(epoch);
	});

	it("сбой скана не отключает индекс: onReady срабатывает на собранной части", async () => {
		// регрессия: cachedRead падает (файл удалён sync-клиентом посреди скана) —
		// раньше start() отвергался, onReady не звался, гейт регулярных не открывался
		async function* failing(): AsyncIterable<FileSnapshot> {
			yield mkSnap("ok.md", "- [ ] выжил");
			throw new Error("ENOENT: файл исчез между getMarkdownFiles и чтением");
		}
		let ready = 0;
		let notified = 0;
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { indexer } = makeIndexer({ initialScan: () => failing(), onReady: () => ready++ });
		indexer.onChange(() => notified++);

		await expect(indexer.start()).resolves.toBeUndefined();

		expect(ready).toBe(1);
		expect(notified).toBeGreaterThan(0);
		expect(descriptions(indexer)).toEqual(["выжил"]);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("dispose во время скана прерывает наполнение без onReady", async () => {
		let ready = 0;
		const h = makeIndexer({
			initialScan: () => scanOf(...[1, 2, 3, 4].map((n) => mkSnap(`f${n}.md`, `- [ ] t${n}`))),
			chunkSize: 1,
			onReady: () => ready++,
		});
		h.indexer.onChange(() => h.indexer.dispose()); // умираем на первом же чанке
		await h.indexer.start();
		expect(ready).toBe(0);
		expect(descriptions(h.indexer).length).toBeLessThan(4);
	});
});

// --- парсинг снапшота ---

describe("indexSnapshot", () => {
	it("контекст пункта (heading, parentLine, lineEnd) попадает в задачу", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		const snap: FileSnapshot = {
			path: "a.md",
			content: "# H\n- [ ] parent\n- [ ] wrapped\n  хвост строки",
			listItems: [
				{ lineStart: 1, lineEnd: 1, taskChar: " ", parentLine: null, heading: "H" },
				{ lineStart: 2, lineEnd: 3, taskChar: " ", parentLine: 1, heading: "H" },
				{ lineStart: 3, lineEnd: 3, taskChar: null, parentLine: 2, heading: "H" }, // не задача
			],
			context: { path: "a.md", container: "plain" },
		};
		events.emitChanged(snap);
		vi.advanceTimersByTime(100);

		const tasks = indexer.getIndex().fileTasks("a.md");
		expect(tasks).toHaveLength(2);
		const wrapped = tasks.find((t) => t.description === "wrapped");
		expect(wrapped?.heading).toBe("H");
		expect(wrapped?.parentLine).toBe(1);
		expect(wrapped?.lineEnd).toBe(3);
	});

	it("проектный контекст: status on-hold гасит projectActive", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		events.emitChanged(
			mkSnap("p.md", "- [ ] в проекте", { container: "project", projectStatus: "on-hold" }),
		);
		vi.advanceTimersByTime(100);
		const [t] = indexer.getIndex().fileTasks("p.md");
		expect(t?.container).toBe("project");
		expect(t?.projectActive).toBe(false);
	});

	it("одинаковые строки без 🆔 получают occurrenceIndex 0/1/2 в порядке файла", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		events.emitChanged(mkSnap("d.md", "- [ ] dup\n- [ ] другое\n- [ ] dup\n- [ ] dup"));
		vi.advanceTimersByTime(100);

		const dups = indexer
			.getIndex()
			.fileTasks("d.md")
			.filter((t) => t.description === "dup")
			.sort((a, b) => a.lineStart - b.lineStart);
		expect(dups.map((t) => t.key)).toEqual([
			computeKey({ taskId: null, filePath: "d.md", description: "dup" }, 0),
			computeKey({ taskId: null, filePath: "d.md", description: "dup" }, 1),
			computeKey({ taskId: null, filePath: "d.md", description: "dup" }, 2),
		]);
	});

	it("occurrence-ключи стабильны при переиндексации того же содержимого", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		const content = "- [ ] dup\n- [ ] dup";
		events.emitChanged(mkSnap("d.md", content));
		vi.advanceTimersByTime(100);
		const before = indexer.getIndex().fileTasks("d.md").map((t) => t.key).sort();

		events.emitChanged(mkSnap("d.md", content));
		vi.advanceTimersByTime(100);
		const after = indexer.getIndex().fileTasks("d.md").map((t) => t.key).sort();
		expect(after).toEqual(before);
	});
});

// --- дребезг ---

describe("debounce", () => {
	it("серия правок одного файла схлопывается: индексируется последний снапшот", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer({ debounceMs: 100 });
		const epoch0 = indexer.getEpoch();

		events.emitChanged(mkSnap("a.md", "- [ ] v1"));
		vi.advanceTimersByTime(50);
		events.emitChanged(mkSnap("a.md", "- [ ] v2"));
		vi.advanceTimersByTime(99);
		expect(descriptions(indexer)).toEqual([]); // дребезг ещё не истёк

		vi.advanceTimersByTime(1);
		expect(descriptions(indexer)).toEqual(["v2"]);
		expect(indexer.getEpoch()).toBe(epoch0 + 1); // одна замена, не две
	});

	it("разные файлы дебаунсятся независимо", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		events.emitChanged(mkSnap("a.md", "- [ ] a"));
		vi.advanceTimersByTime(60);
		events.emitChanged(mkSnap("b.md", "- [ ] b"));
		vi.advanceTimersByTime(40);
		expect(descriptions(indexer)).toEqual(["a"]); // a созрел, b ещё нет
		vi.advanceTimersByTime(60);
		expect(descriptions(indexer)).toEqual(["a", "b"]);
	});
});

// --- удаление и переименование ---

describe("delete / rename", () => {
	it("удаление убирает задачи файла и гасит отложенную переиндексацию", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		events.emitChanged(mkSnap("a.md", "- [ ] жив"));
		vi.advanceTimersByTime(100);
		expect(descriptions(indexer)).toEqual(["жив"]);

		events.emitChanged(mkSnap("a.md", "- [ ] зомби"));
		events.emitDeleted("a.md");
		vi.advanceTimersByTime(1000);
		expect(descriptions(indexer)).toEqual([]);
	});

	it("rename: id-ключ стабилен, content-ключи переезжают на новый путь", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		const content = "- [ ] с айди 🆔 abc\n- [ ] dup\n- [ ] dup";
		events.emitChanged(mkSnap("old.md", content));
		vi.advanceTimersByTime(100);
		expect(indexer.getIndex().get("id:abc")).toBeDefined();

		events.emitRenamed("old.md", mkSnap("new/dir.md", content));

		expect(indexer.getIndex().fileTasks("old.md")).toEqual([]);
		const byId = indexer.getIndex().get("id:abc");
		expect(byId?.filePath).toBe("new/dir.md");
		const dupKeys = indexer
			.getIndex()
			.fileTasks("new/dir.md")
			.filter((t) => t.description === "dup")
			.sort((a, b) => a.lineStart - b.lineStart)
			.map((t) => t.key);
		expect(dupKeys).toEqual([
			computeKey({ taskId: null, filePath: "new/dir.md", description: "dup" }, 0),
			computeKey({ taskId: null, filePath: "new/dir.md", description: "dup" }, 1),
		]);
	});

	it("rename доносит новый fileContext свежим снапшотом", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		events.emitChanged(mkSnap("a.md", "- [ ] т"));
		vi.advanceTimersByTime(100);
		expect(indexer.getIndex().fileTasks("a.md")[0]?.container).toBe("plain");

		events.emitRenamed(
			"a.md",
			mkSnap("proj/a.md", "- [ ] т", { container: "project", projectStatus: "archived" }),
		);
		const [t] = indexer.getIndex().fileTasks("proj/a.md");
		expect(t?.container).toBe("project");
		expect(t?.projectActive).toBe(false);
	});

	it("rename гасит отложенную переиндексацию старого пути", () => {
		vi.useFakeTimers();
		const { events, indexer } = makeIndexer();
		events.emitChanged(mkSnap("a.md", "- [ ] призрак"));
		events.emitRenamed("a.md", mkSnap("b.md", "- [ ] настоящий"));
		vi.advanceTimersByTime(1000);

		expect(indexer.getIndex().fileTasks("a.md")).toEqual([]);
		expect(descriptions(indexer)).toEqual(["настоящий"]);
	});
});

// --- часы и эпоха ---

describe("часы", () => {
	it("смена дня: bump эпохи + notify, today() отдаёт новую дату", () => {
		const { clock, indexer } = makeIndexer();
		let notified = 0;
		indexer.onChange(() => notified++);
		const epoch0 = indexer.getEpoch();

		clock.roll("2026-07-16");

		expect(indexer.getEpoch()).toBe(epoch0 + 1);
		expect(notified).toBe(1);
		expect(indexer.today()).toBe("2026-07-16");
	});

	it("эпоха монотонна сквозь правки и смены дня", () => {
		vi.useFakeTimers();
		const { events, clock, indexer } = makeIndexer();
		const seen: number[] = [indexer.getEpoch()];
		events.emitChanged(mkSnap("a.md", "- [ ] x"));
		vi.advanceTimersByTime(100);
		seen.push(indexer.getEpoch());
		clock.roll("2026-07-16");
		seen.push(indexer.getEpoch());
		events.emitDeleted("a.md");
		seen.push(indexer.getEpoch());
		for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
	});
});

// --- подписки и dispose ---

describe("подписки", () => {
	it("onChange возвращает отписку", () => {
		const { clock, indexer } = makeIndexer();
		let n = 0;
		const off = indexer.onChange(() => n++);
		clock.roll("2026-07-16");
		off();
		clock.roll("2026-07-17");
		expect(n).toBe(1);
	});

	it("после dispose события и смена дня игнорируются", () => {
		vi.useFakeTimers();
		const { events, clock, indexer } = makeIndexer();
		let notified = 0;
		indexer.onChange(() => notified++);
		indexer.dispose();

		events.emitChanged(mkSnap("a.md", "- [ ] x"));
		vi.advanceTimersByTime(1000);
		clock.roll("2026-07-16");

		expect(descriptions(indexer)).toEqual([]);
		expect(indexer.getEpoch()).toBe(0);
		expect(notified).toBe(0);
	});
});

describe("зеркала внешних календарей (gtd-external + gtd-events)", () => {
	it("индексируются как события (container events) и несут маркер external", async () => {
		const snap = mkSnap(
			"GTD/External/Google.md",
			"- [ ] Внешняя встреча 📅 2026-07-20 10:00-11:00 🆔 ext1",
			{ container: "events", external: true },
		);
		const { indexer } = makeIndexer({ initialScan: () => scanOf(snap) });
		await indexer.start();

		const tasks = indexer.getIndex().fileTasks("GTD/External/Google.md");
		expect(tasks).toHaveLength(1);
		// подхватывается пайплайном событий БЕЗ изменений (container events) …
		expect(tasks[0]!.container).toBe("events");
		// … и несёт read-only маркер (для меню/защиты write-back)
		expect(tasks[0]!.external).toBe(true);
		expect(tasks[0]!.due).toBe("2026-07-20");
	});

	it("обычный файл событий БЕЗ gtd-external — external не проставлен", async () => {
		const snap = mkSnap("GTD/Events.md", "- [ ] Своё событие 📅 2026-07-20 🆔 own1", {
			container: "events",
		});
		const { indexer } = makeIndexer({ initialScan: () => scanOf(snap) });
		await indexer.start();
		const t = indexer.getIndex().fileTasks("GTD/Events.md")[0]!;
		expect(t.container).toBe("events");
		expect(t.external).toBeUndefined();
	});
});
