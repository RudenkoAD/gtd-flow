import { describe, expect, it } from "vitest";
import {
	activeScopes,
	createScopeCatalog,
	isActiveScopeId,
	isScopeId,
	parseScopeCatalog,
	scopeById,
	scopeIdCandidate,
	uniqueScopeId,
} from "./scope";

describe("scope IDs", () => {
	it.each(["work", "life-admin", "scope_2", "a", "a1"])("accepts %s", (id) => {
		expect(isScopeId(id)).toBe(true);
	});

	it.each(["", "Work", "-work", "work-", "two words", "жизнь", "a".repeat(65)])(
		"rejects %s",
		(id) => {
			expect(isScopeId(id)).toBe(false);
		},
	);

	it("creates readable collision-free candidates", () => {
		expect(scopeIdCandidate("Deep Work")).toBe("deep-work");
		expect(scopeIdCandidate("Жизнь")).toBe("scope");
		expect(uniqueScopeId("Deep Work", new Set(["deep-work", "deep-work-2"]))).toBe(
			"deep-work-3",
		);
	});
});

describe("scope catalog", () => {
	it("sorts active scopes and still resolves archived scopes", () => {
		const catalog = createScopeCatalog([
			{ id: "archive", name: "Archive", order: 0, archived: true },
			{ id: "life", name: "Life", order: 2, archived: false },
			{ id: "work", name: "Work", order: 1, archived: false },
		]);
		expect(activeScopes(catalog).map((scope) => scope.id)).toEqual(["work", "life"]);
		expect(scopeById(catalog, "archive")?.name).toBe("Archive");
		expect(isActiveScopeId(catalog, "archive")).toBe(false);
		expect(isActiveScopeId(catalog, "work")).toBe(true);
	});

	it("parses untrusted synced JSON and keeps the first duplicate", () => {
		const parsed = parseScopeCatalog({
			schemaVersion: 1,
			scopes: [
				{ id: "work", name: "Work", order: 1, archived: false },
				{ id: "work", name: "Other", order: 2, archived: false },
				{ id: "life", name: "work", order: 3, archived: false },
				{ id: "bad id", name: "Bad", order: 4, archived: false },
			],
		});
		expect(parsed.catalog.scopes).toEqual([
			{ id: "work", name: "Work", order: 1, archived: false },
		]);
		expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"duplicate-id",
			"duplicate-name",
			"invalid-scope",
		]);
	});

	it("fails closed on unsupported schemas", () => {
		const parsed = parseScopeCatalog({ schemaVersion: 99, scopes: [] });
		expect(parsed.catalog.scopes).toEqual([]);
		expect(parsed.diagnostics).toHaveLength(1);
	});

	it("rejects duplicate display orders in synced catalogs", () => {
		const parsed = parseScopeCatalog({
			schemaVersion: 1,
			scopes: [
				{ id: "work", name: "Work", order: 0, archived: false },
				{ id: "life", name: "Life", order: 0, archived: false },
			],
		});
		expect(parsed.catalog.scopes).toEqual([
			{ id: "work", name: "Work", order: 0, archived: false },
		]);
		expect(parsed.diagnostics).toEqual([
			expect.objectContaining({ code: "duplicate-order", order: 0 }),
		]);
	});
});
