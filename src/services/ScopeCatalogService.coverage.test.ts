import { describe, expect, it } from "vitest";
import { SCOPE_CATALOG_PATH, ScopeCatalogService } from "./ScopeCatalogService";

class Storage {
	readonly files = new Map<string, string>();

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}
}

describe("ScopeCatalogService guard rails", () => {
	it("requires loading, validates names and IDs, and keeps returned catalogs isolated", async () => {
		const storage = new Storage();
		const service = new ScopeCatalogService(storage, { countTasksWithScope: () => 0 });
		expect(service.isLoaded()).toBe(false);
		expect(service.current()).toEqual({ schemaVersion: 1, scopes: [] });
		await expect(service.create("Work")).rejects.toThrow("scope-catalog-not-loaded");
		await service.load();
		expect(service.isLoaded()).toBe(true);
		await expect(
			service.initialize([{ id: "work", name: "Work", order: 0, archived: false }]),
		).resolves.toMatchObject({
			scopes: [expect.objectContaining({ id: "work" })],
		});
		await expect(service.initialize([])).rejects.toThrow("scope-catalog-already-initialized");
		await expect(service.create(" work ")).rejects.toThrow("scope-name-already-exists");
		await expect(service.create(" ")).rejects.toThrow("invalid-scope-name");
		await expect(service.create("x".repeat(81))).rejects.toThrow("invalid-scope-name");
		await expect(service.rename("bad id", "Other")).rejects.toThrow("invalid-scope-id");
		await expect(service.rename("missing", "Other")).rejects.toThrow("scope-not-found");
		await expect(service.reorder(["work", "work"])).rejects.toThrow(
			"scope-order-must-contain-every-scope-once",
		);

		const snapshot = service.current();
		snapshot.scopes[0]!.name = "Mutated caller value";
		expect(service.current().scopes[0]!.name).toBe("Work");
		await service.delete("work");
		expect(service.current().scopes).toEqual([]);
		expect(JSON.parse(storage.files.get(SCOPE_CATALOG_PATH)!)).toEqual({
			schemaVersion: 1,
			scopes: [],
		});
	});
});
