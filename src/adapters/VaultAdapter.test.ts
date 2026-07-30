import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { VaultAdapter } from "./VaultAdapter";
import { createMemoryDataAdapter } from "../testing/memoryDataAdapter";

interface MemoryFile {
	path: string;
	extension: string;
}

/**
 * Фейк, воспроизводящий главное свойство настоящего Obsidian: скрытые
 * (точечные) пути НЕ попадают в индекс Vault. Всё, что живёт в `.gtd-flow/**`,
 * видно только через `vault.adapter`.
 */
class IndexedMemoryVault {
	readonly data = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly adapter = createMemoryDataAdapter(this.data, this.folders);
	createCalls = 0;

	private hidden(path: string): boolean {
		return path.split("/").some((segment) => segment.startsWith("."));
	}

	getFileByPath(path: string): MemoryFile | null {
		if (this.hidden(path) || !this.data.has(path)) return null;
		return { path, extension: path.split(".").pop() ?? "" };
	}

	getAbstractFileByPath(path: string): { path: string } | null {
		if (this.hidden(path)) return null;
		return this.getFileByPath(path) ?? (this.folders.has(path) ? { path } : null);
	}

	getFiles(): MemoryFile[] {
		return [...this.data.keys()]
			.filter((path) => !this.hidden(path))
			.sort()
			.map((path) => ({ path, extension: path.split(".").pop() ?? "" }));
	}

	async read(target: MemoryFile): Promise<string> {
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		return content;
	}

	async process(target: MemoryFile, transform: (content: string) => string): Promise<void> {
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		this.data.set(target.path, transform(content));
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async create(path: string, content: string): Promise<MemoryFile> {
		this.createCalls += 1;
		if (this.data.has(path)) throw new Error(`vault-file-exists:${path}`);
		this.data.set(path, content);
		return { path, extension: path.split(".").pop() ?? "" };
	}

	async delete(target: MemoryFile): Promise<void> {
		this.data.delete(target.path);
	}
}

function createAdapter(): { vault: IndexedMemoryVault; adapter: VaultAdapter } {
	const vault = new IndexedMemoryVault();
	return { vault, adapter: new VaultAdapter({ vault } as unknown as App) };
}

const CATALOG = ".gtd-flow/config/scopes.json";

describe("VaultAdapter and hidden .gtd-flow paths", () => {
	it("reads back what it wrote, though the vault index never sees the file", async () => {
		const { vault, adapter } = createAdapter();

		await adapter.writeAtomic(CATALOG, "{}");

		expect(vault.getFileByPath(CATALOG)).toBeNull();
		expect(vault.createCalls).toBe(0);
		expect(await adapter.read(CATALOG)).toBe("{}");
	});

	it("survives a second write to the same hidden path", async () => {
		const { adapter } = createAdapter();

		await adapter.writeAtomic(CATALOG, "{}");
		await expect(adapter.writeAtomic(CATALOG, '{"v":2}')).resolves.toBeUndefined();

		expect(await adapter.read(CATALOG)).toBe('{"v":2}');
	});

	it("lists hidden records recursively for the synced repositories", async () => {
		const { adapter } = createAdapter();
		await adapter.writeNew(".gtd-flow/ai/feedback/2026/01/a.json", "a");
		await adapter.writeNew(".gtd-flow/ai/feedback/2026/02/b.json", "b");
		await adapter.writeNew("Inbox.md", "- [ ] task");

		expect(await adapter.list(".gtd-flow/ai/feedback")).toEqual([
			".gtd-flow/ai/feedback/2026/01/a.json",
			".gtd-flow/ai/feedback/2026/02/b.json",
		]);
		expect(await adapter.list(".gtd-flow/ai/missing")).toEqual([]);
	});

	it("rejects an immutable record whose hidden path is taken", async () => {
		const { adapter } = createAdapter();
		const path = ".gtd-flow/ai/feedback/event.json";
		await adapter.writeNew(path, "first");

		await expect(adapter.writeNew(path, "second")).rejects.toThrow(`vault-file-exists:${path}`);
		expect(await adapter.read(path)).toBe("first");
	});

	it("removes and compare-and-sets hidden records", async () => {
		const { adapter } = createAdapter();
		const path = ".gtd-flow/ai/migrations/run.json";

		expect(await adapter.compareAndSet(path, null, "one")).toBe(true);
		expect(await adapter.compareAndSet(path, "other", "two")).toBe(false);
		expect(await adapter.compareAndSet(path, "one", "two")).toBe(true);
		expect(await adapter.read(path)).toBe("two");

		expect(await adapter.compareAndSet(path, "two", null)).toBe(true);
		expect(await adapter.read(path)).toBeNull();

		await adapter.writeAtomic(path, "again");
		await adapter.remove(path);
		expect(await adapter.read(path)).toBeNull();
		await expect(adapter.remove(path)).resolves.toBeUndefined();
	});

	it("serializes concurrent create-if-absent on the same hidden path", async () => {
		const { adapter } = createAdapter();
		const path = ".gtd-flow/ai/runs/run-1.json";

		const results = await Promise.allSettled([
			adapter.writeNew(path, "first"),
			adapter.writeNew(path, "second"),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});

	it("keeps regular notes on the TFile API", async () => {
		const { vault, adapter } = createAdapter();

		await adapter.writeAtomic("Projects/Note.md", "body");

		expect(vault.createCalls).toBe(1);
		expect(vault.getFileByPath("Projects/Note.md")).not.toBeNull();
		expect(await adapter.list("Projects")).toEqual(["Projects/Note.md"]);
	});
});
