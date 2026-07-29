import { describe, expect, it } from "vitest";
import { SCOPE_CATALOG_PATH, ScopeCatalogService } from "./ScopeCatalogService";

class MemoryStorage {
	readonly files = new Map<string, string>();
	throwAfterWriteOnce = false;

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		if (this.throwAfterWriteOnce) {
			this.throwAfterWriteOnce = false;
			throw new Error("scope-write-ack-lost");
		}
	}
}

function service(storage = new MemoryStorage(), references: Record<string, number> = {}) {
	return {
		storage,
		service: new ScopeCatalogService(storage, {
			countTasksWithScope: (scopeId) => references[scopeId] ?? 0,
		}),
	};
}

describe("ScopeCatalogService", () => {
	it("distinguishes a missing synced catalog from an empty catalog", async () => {
		const fixture = service();
		await expect(fixture.service.load()).resolves.toMatchObject({
			exists: false,
			catalog: { schemaVersion: 1, scopes: [] },
		});
		await fixture.service.initialize([{ id: "work", name: "Work", order: 0, archived: false }]);
		expect(JSON.parse(fixture.storage.files.get(SCOPE_CATALOG_PATH)!)).toEqual({
			schemaVersion: 1,
			scopes: [{ id: "work", name: "Work", order: 0, archived: false }],
		});
	});

	it("creates stable IDs, renames without changing IDs, and archives", async () => {
		const fixture = service();
		await fixture.service.load();
		const created = await fixture.service.create("Deep Work");
		expect(created.id).toBe("deep-work");
		const renamed = await fixture.service.rename(created.id, "Focused work");
		expect(renamed).toMatchObject({ id: "deep-work", name: "Focused work" });
		await expect(fixture.service.setArchived(created.id, true)).resolves.toMatchObject({
			id: "deep-work",
			archived: true,
		});
	});

	it("blocks duplicate names and deletion while tasks reference a scope", async () => {
		const fixture = service(undefined, { work: 2 });
		await fixture.service.load();
		await fixture.service.initialize([
			{ id: "work", name: "Work", order: 0, archived: false },
			{ id: "life", name: "Life", order: 1, archived: false },
		]);
		await expect(fixture.service.rename("life", "work")).rejects.toThrow(
			"scope-name-already-exists",
		);
		await expect(fixture.service.delete("work")).rejects.toThrow("scope-is-referenced:2");
	});

	it("fails closed on malformed synced JSON", async () => {
		const fixture = service();
		fixture.storage.files.set(SCOPE_CATALOG_PATH, "{not json");
		const loaded = await fixture.service.load();
		expect(loaded.exists).toBe(true);
		expect(loaded.catalog.scopes).toEqual([]);
		expect(loaded.diagnostics[0]?.code).toBe("invalid-catalog");
		await expect(fixture.service.create("Work")).rejects.toThrow("scope-catalog-invalid");
		expect(fixture.storage.files.get(SCOPE_CATALOG_PATH)).toBe("{not json");
	});

	it("does not overwrite a synced catalog changed since load", async () => {
		const fixture = service();
		await fixture.service.load();
		await fixture.service.initialize([{ id: "work", name: "Work", order: 0, archived: false }]);
		const remote = JSON.stringify({
			schemaVersion: 1,
			scopes: [{ id: "remote", name: "Remote", order: 0, archived: false }],
		});
		fixture.storage.files.set(SCOPE_CATALOG_PATH, remote);

		await expect(fixture.service.create("Life")).rejects.toThrow("scope-catalog-changed");
		expect(fixture.storage.files.get(SCOPE_CATALOG_PATH)).toBe(remote);
	});

	it("accepts a committed atomic write whose acknowledgement was lost", async () => {
		const fixture = service();
		await fixture.service.load();
		fixture.storage.throwAfterWriteOnce = true;
		await expect(fixture.service.create("Work")).resolves.toMatchObject({
			id: "work",
		});
		await expect(fixture.service.create("Life")).resolves.toMatchObject({
			id: "life",
		});
		expect(fixture.service.current().scopes.map((scope) => scope.id)).toEqual(["work", "life"]);
	});

	it("requires a complete reorder and persists only after successful validation", async () => {
		const fixture = service();
		await fixture.service.load();
		await fixture.service.initialize([
			{ id: "work", name: "Work", order: 0, archived: false },
			{ id: "life", name: "Life", order: 1, archived: false },
		]);
		await expect(fixture.service.reorder(["work"])).rejects.toThrow(
			"scope-order-must-contain-every-scope-once",
		);
		await fixture.service.reorder(["life", "work"]);
		expect(fixture.service.current().scopes).toEqual([
			{ id: "work", name: "Work", order: 1, archived: false },
			{ id: "life", name: "Life", order: 0, archived: false },
		]);
	});
});
