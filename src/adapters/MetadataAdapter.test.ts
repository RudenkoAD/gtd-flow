/**
 * MetadataAdapter на синтетическом app: импорт 'obsidian' в адаптере строго
 * type-only, поэтому тестируем в голом node структурными двойниками
 * vault/metadataCache. Покрытие — регрессии этапа 9: изоляция ошибок
 * первичного скана, гонка rename→delete, ленивая обратная карта
 * findByFrontmatterValue, гейт onResolved/isResolved.
 */
import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";
import type { FileSnapshot } from "../services/types";
import { MetadataAdapter } from "./MetadataAdapter";

// --- синтетика: файлы, шины событий, app ---

type Handler = (...args: never[]) => void;
type AnyHandler = (...args: unknown[]) => void;

class FakeBus {
	private handlers = new Map<string, Set<AnyHandler>>();

	on(name: string, cb: Handler): { name: string; cb: AnyHandler } {
		let set = this.handlers.get(name);
		if (set === undefined) {
			set = new Set();
			this.handlers.set(name, set);
		}
		const h = cb as AnyHandler;
		set.add(h);
		return { name, cb: h };
	}

	offref(ref: { name: string; cb: AnyHandler }): void {
		this.handlers.get(ref.name)?.delete(ref.cb);
	}

	emit(name: string, ...args: unknown[]): void {
		for (const cb of [...(this.handlers.get(name) ?? [])]) cb(...args);
	}
}

interface FakeFile {
	path: string;
	extension: string;
}

const md = (path: string): FakeFile => ({ path, extension: "md" });

interface FakeEntry {
	content?: string;
	fm?: Record<string, unknown>;
}

function makeApp(files: Record<string, FakeEntry>) {
	const store = new Map<string, FakeEntry>(Object.entries(files));
	const vaultBus = new FakeBus();
	const cacheBus = new FakeBus();
	let cacheCalls = 0;

	const vault = {
		on: (n: string, cb: Handler) => vaultBus.on(n, cb),
		offref: (r: { name: string; cb: AnyHandler }) => vaultBus.offref(r),
		getMarkdownFiles: () => [...store.keys()].sort().map(md),
		getFileByPath: (p: string) => (store.has(p) ? md(p) : null),
		cachedRead: (f: FakeFile) => {
			const e = store.get(f.path);
			return e === undefined
				? Promise.reject(new Error(`ENOENT: ${f.path}`))
				: Promise.resolve(e.content ?? "");
		},
	};
	const metadataCache = {
		on: (n: string, cb: Handler) => cacheBus.on(n, cb),
		offref: (r: { name: string; cb: AnyHandler }) => cacheBus.offref(r),
		getFileCache: (f: FakeFile) => {
			cacheCalls++;
			const e = store.get(f.path);
			if (e === undefined) return null;
			return e.fm === undefined ? {} : { frontmatter: e.fm };
		},
	};
	const app = { vault, metadataCache };
	const plugin = {
		app,
		registerEvent: () => undefined,
		registerInterval: (id: number) => id,
	} as unknown as Plugin;
	return { app, plugin, store, vaultBus, cacheBus, cacheCalls: () => cacheCalls };
}

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

// --- первичный скан: изоляция ошибок ---

describe("initialScan", () => {
	it("нечитаемый файл пропускается, остальные сканируются, скан не падает", async () => {
		const h = makeApp({
			"a.md": { content: "- [ ] a" },
			"b.md": { content: "- [ ] b" },
			"c.md": { content: "- [ ] c" },
		});
		// список файлов снят один раз (как в Obsidian), затем b.md исчезает —
		// cachedRead по нему отвергнется посреди скана
		const files = h.app.vault.getMarkdownFiles();
		h.app.vault.getMarkdownFiles = () => files;
		h.store.delete("b.md");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const adapter = new MetadataAdapter(h.plugin);

		const paths: string[] = [];
		for await (const snap of adapter.initialScan()) paths.push(snap.path);

		expect(paths).toEqual(["a.md", "c.md"]);
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(String(errSpy.mock.calls[0]?.[0])).toContain("b.md");
		errSpy.mockRestore();
	});
});

// --- гонка rename → delete ---

describe("onRenamed", () => {
	it("обычный rename доносит свежий снапшот нового пути", async () => {
		const h = makeApp({ "new.md": { content: "- [ ] жив", fm: { "gtd-project": true } } });
		const adapter = new MetadataAdapter(h.plugin);
		const calls: Array<{ old: string; snap: FileSnapshot }> = [];
		adapter.onRenamed((old, snap) => calls.push({ old, snap }));

		h.vaultBus.emit("rename", md("new.md"), "old.md");
		await tick();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.old).toBe("old.md");
		expect(calls[0]?.snap.path).toBe("new.md");
		expect(calls[0]?.snap.content).toBe("- [ ] жив");
		expect(calls[0]?.snap.context.container).toBe("project");
	});

	it("delete прилетел, пока читали: чтение успело — задачи не воскрешают", async () => {
		const h = makeApp({ "b.md": { content: "- [ ] зомби" } });
		let release!: (v: string) => void;
		h.app.vault.cachedRead = () => new Promise<string>((res) => (release = res));
		const adapter = new MetadataAdapter(h.plugin);
		const calls: Array<{ old: string; snap: FileSnapshot }> = [];
		adapter.onRenamed((old, snap) => calls.push({ old, snap }));

		h.vaultBus.emit("rename", md("b.md"), "a.md"); // rename a.md → b.md, чтение зависло
		h.store.delete("b.md"); // sync удалил b.md до завершения чтения
		release("- [ ] зомби"); // чтение вернулось из кэша уже удалённого файла
		await tick();

		// пустой снапшот: handleRenamed вычистит a.md, не добавив призраков в b.md
		expect(calls).toHaveLength(1);
		expect(calls[0]?.old).toBe("a.md");
		expect(calls[0]?.snap.path).toBe("b.md");
		expect(calls[0]?.snap.content).toBe("");
		expect(calls[0]?.snap.listItems).toEqual([]);
	});

	it("delete прилетел, пока читали: чтение отвергнуто — пустой снапшот, без unhandled rejection", async () => {
		const h = makeApp({ "b.md": { content: "- [ ] x" } });
		let reject!: (e: Error) => void;
		h.app.vault.cachedRead = () => new Promise<string>((_res, rej) => (reject = rej));
		const adapter = new MetadataAdapter(h.plugin);
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown): void => {
			unhandled.push(e);
		};
		process.on("unhandledRejection", onUnhandled);
		const calls: Array<{ old: string; snap: FileSnapshot }> = [];
		adapter.onRenamed((old, snap) => calls.push({ old, snap }));

		try {
			h.vaultBus.emit("rename", md("b.md"), "a.md");
			h.store.delete("b.md");
			reject(new Error("ENOENT: b.md"));
			await tick();
			await tick();

			expect(calls).toHaveLength(1);
			expect(calls[0]?.old).toBe("a.md");
			expect(calls[0]?.snap.listItems).toEqual([]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

// --- обратная карта frontmatter ---

describe("findByFrontmatterValue", () => {
	it("наименьший путь среди носителей; число и строка сходятся через String()", () => {
		const h = makeApp({
			"z.md": { fm: { "gtd-card-of": 123 } },
			"cards/a.md": { fm: { "gtd-card-of": "123" } },
			"other.md": { fm: { title: "x" } },
			"plain.md": {},
		});
		const adapter = new MetadataAdapter(h.plugin);
		expect(adapter.findByFrontmatterValue("gtd-card-of", "123")).toBe("cards/a.md");
		expect(adapter.findByFrontmatterValue("gtd-card-of", 123)).toBe("cards/a.md");
		expect(adapter.findByFrontmatterValue("gtd-card-of", "999")).toBeNull();
	});

	it("повторные запросы не сканируют хранилище заново (O(1) после первого)", () => {
		const h = makeApp({
			"a.md": { fm: { "gtd-card-of": "t1" } },
			"b.md": {},
			"c.md": {},
		});
		const adapter = new MetadataAdapter(h.plugin);
		adapter.findByFrontmatterValue("gtd-card-of", "t1"); // первый — полный обход
		const after = h.cacheCalls();
		for (let i = 0; i < 50; i++) adapter.findByFrontmatterValue("gtd-card-of", "t1");
		expect(h.cacheCalls()).toBe(after); // регрессия: было 50 × файлы вызовов getFileCache
	});

	it("карта поддерживается инкрементально: changed / delete / rename", () => {
		const h = makeApp({
			"a.md": { fm: { "gtd-card-of": "t1" } },
			"b.md": { fm: { "gtd-card-of": "t1" } },
		});
		const adapter = new MetadataAdapter(h.plugin);
		const find = (v: unknown): string | null => adapter.findByFrontmatterValue("gtd-card-of", v);
		expect(find("t1")).toBe("a.md");

		// удаление наименьшего носителя → следующий
		h.store.delete("a.md");
		h.vaultBus.emit("delete", md("a.md"));
		expect(find("t1")).toBe("b.md");

		// значение сменилось правкой файла
		h.store.set("b.md", { fm: { "gtd-card-of": "t2" } });
		h.cacheBus.emit("changed", md("b.md"), "", { frontmatter: { "gtd-card-of": "t2" } });
		expect(find("t1")).toBeNull();
		expect(find("t2")).toBe("b.md");

		// frontmatter убрали вовсе
		h.store.set("b.md", {});
		h.cacheBus.emit("changed", md("b.md"), "", {});
		expect(find("t2")).toBeNull();
	});

	it("rename переносит носителя на новый путь", () => {
		const h = makeApp({ "cards/old.md": { fm: { "gtd-card-of": "t1" } } });
		const adapter = new MetadataAdapter(h.plugin);
		expect(adapter.findByFrontmatterValue("gtd-card-of", "t1")).toBe("cards/old.md");

		h.store.delete("cards/old.md");
		h.store.set("cards/new.md", { fm: { "gtd-card-of": "t1" } });
		h.vaultBus.emit("rename", md("cards/new.md"), "cards/old.md");

		expect(adapter.findByFrontmatterValue("gtd-card-of", "t1")).toBe("cards/new.md");
		expect(adapter.findByFrontmatterValue("gtd-card-of", "t1")).not.toBe("cards/old.md");
	});
});

// --- обратная карта frontmatter: все пути ---

describe("pathsByFrontmatterValue", () => {
	it("все носители значения, отсортированы лексикографически", () => {
		const h = makeApp({
			"z.md": { fm: { "gtd-board": true } },
			"a.md": { fm: { "gtd-board": true } },
			"m.md": { fm: { "gtd-board": true } },
			"other.md": { fm: { "gtd-board": false } },
			"plain.md": {},
		});
		const adapter = new MetadataAdapter(h.plugin);
		expect(adapter.pathsByFrontmatterValue("gtd-board", true)).toEqual(["a.md", "m.md", "z.md"]);
	});

	it("нет носителей — пустой массив", () => {
		const h = makeApp({ "a.md": { fm: { title: "x" } } });
		const adapter = new MetadataAdapter(h.plugin);
		expect(adapter.pathsByFrontmatterValue("gtd-board", true)).toEqual([]);
	});

	it("делит ленивый индекс с findByFrontmatterValue: первый запрос строит, дальше O(1)", () => {
		const h = makeApp({
			"a.md": { fm: { "gtd-project": true } },
			"b.md": { fm: { "gtd-project": true } },
			"c.md": {},
		});
		const adapter = new MetadataAdapter(h.plugin);
		adapter.pathsByFrontmatterValue("gtd-project", true); // первый — полный обход
		const after = h.cacheCalls();
		for (let i = 0; i < 50; i++) adapter.pathsByFrontmatterValue("gtd-project", true);
		expect(h.cacheCalls()).toBe(after);
		// find и paths делят одну карту — find тоже без нового обхода
		expect(adapter.findByFrontmatterValue("gtd-project", true)).toBe("a.md");
		expect(h.cacheCalls()).toBe(after);
	});

	it("инкрементальность: changed / delete добавляют и убирают пути", () => {
		const h = makeApp({
			"a.md": { fm: { "gtd-board": true } },
			"b.md": { fm: { "gtd-board": true } },
		});
		const adapter = new MetadataAdapter(h.plugin);
		const paths = (): string[] => adapter.pathsByFrontmatterValue("gtd-board", true);
		expect(paths()).toEqual(["a.md", "b.md"]);

		// новый файл-контейнер появился правкой
		h.store.set("c.md", { fm: { "gtd-board": true } });
		h.cacheBus.emit("changed", md("c.md"), "", { frontmatter: { "gtd-board": true } });
		expect(paths()).toEqual(["a.md", "b.md", "c.md"]);

		// удаление носителя
		h.store.delete("a.md");
		h.vaultBus.emit("delete", md("a.md"));
		expect(paths()).toEqual(["b.md", "c.md"]);
	});
});

// --- гейт resolved ---

describe("onResolved / isResolved", () => {
	it("колбэк по событию 'resolved' — ровно один раз", () => {
		const h = makeApp({});
		const adapter = new MetadataAdapter(h.plugin);
		expect(adapter.isResolved()).toBe(false);
		let n = 0;
		adapter.onResolved(() => n++);
		expect(n).toBe(0); // до resolve колбэк не зовётся

		h.cacheBus.emit("resolved");
		h.cacheBus.emit("resolved"); // повторные resolve (после правок) не дублируют

		expect(n).toBe(1);
		expect(adapter.isResolved()).toBe(true);
	});

	it("кэш уже готов (initialized): колбэк синхронно — плагин включили посреди сессии", () => {
		const h = makeApp({});
		(h.app.metadataCache as unknown as { initialized?: boolean }).initialized = true;
		const adapter = new MetadataAdapter(h.plugin);
		expect(adapter.isResolved()).toBe(true);
		let n = 0;
		adapter.onResolved(() => n++);
		expect(n).toBe(1);
	});
});
