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

	it.each([
		["пустой файл", ""],
		["только пробелы и перевод строки", "   \n"],
	])("лечит %s: это оборванная запись, а не повреждённый каталог", async (_label, content) => {
		const fixture = service();
		fixture.storage.files.set(SCOPE_CATALOG_PATH, content);

		const loaded = await fixture.service.load();

		expect(loaded.exists).toBe(false);
		expect(loaded.catalog.scopes).toEqual([]);
		expect(loaded.diagnostics.map((item) => item.code)).toEqual(["empty-catalog-healed"]);
		expect(fixture.service.isMutationSafe()).toBe(true);
		await expect(fixture.service.create("Work")).resolves.toMatchObject({ id: "work" });
		expect(JSON.parse(fixture.storage.files.get(SCOPE_CATALOG_PATH)!)).toEqual({
			schemaVersion: 1,
			scopes: [{ id: "work", name: "Work", order: 0, archived: false }],
		});
	});

	it("пересоздаёт повреждённый каталог, сохранив старый файл рядом", async () => {
		const fixture = service();
		fixture.storage.files.set(SCOPE_CATALOG_PATH, "{oops");
		await fixture.service.load();
		expect(fixture.service.isMutationSafe()).toBe(false);

		const recreated = await fixture.service.recreate(new Date(2026, 7, 2, 9, 5, 3));

		expect(recreated.backupPath).toBe(`${SCOPE_CATALOG_PATH}.bak-20260802-090503`);
		expect(fixture.storage.files.get(recreated.backupPath!)).toBe("{oops");
		expect(JSON.parse(fixture.storage.files.get(SCOPE_CATALOG_PATH)!)).toEqual({
			schemaVersion: 1,
			scopes: [],
		});
		expect(fixture.service.isMutationSafe()).toBe(true);
		await expect(fixture.service.create("Work")).resolves.toMatchObject({ id: "work" });
	});

	it("не затирает первый бэкап и не плодит его там, где спасать нечего", async () => {
		const fixture = service();
		fixture.storage.files.set(SCOPE_CATALOG_PATH, "{oops");
		await fixture.service.load();
		const stamp = new Date(2026, 7, 2, 9, 5, 3);

		const first = await fixture.service.recreate(stamp);
		const second = await fixture.service.recreate(stamp);
		const third = await fixture.service.recreate(stamp);

		expect(first.backupPath).toBe(`${SCOPE_CATALOG_PATH}.bak-20260802-090503`);
		// второй вызов спасает уже пустой валидный каталог, третий — тоже
		expect(second.backupPath).toBe(`${SCOPE_CATALOG_PATH}.bak-20260802-090503-1`);
		expect(third.backupPath).toBe(`${SCOPE_CATALOG_PATH}.bak-20260802-090503-2`);
		expect(fixture.storage.files.get(first.backupPath!)).toBe("{oops");
	});

	it("пересоздание на свежем vault не создаёт бэкап пустоты", async () => {
		const fixture = service();
		await fixture.service.load();

		const recreated = await fixture.service.recreate(new Date(2026, 7, 2, 9, 5, 3));

		expect(recreated.backupPath).toBeNull();
		expect([...fixture.storage.files.keys()]).toEqual([SCOPE_CATALOG_PATH]);
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
