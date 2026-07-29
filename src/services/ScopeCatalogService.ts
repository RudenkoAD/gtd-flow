import {
	createScopeCatalog,
	isScopeId,
	parseScopeCatalog,
	scopeById,
	uniqueScopeId,
	type ParsedScopeCatalog,
	type ScopeCatalog,
	type ScopeDef,
} from "../core/scope/scope";

export const SCOPE_CATALOG_PATH = ".gtd-flow/config/scopes.json";

export interface ScopeCatalogStorage {
	read(path: string): Promise<string | null>;
	writeAtomic(path: string, content: string): Promise<void>;
}

export interface ScopeReferenceCounter {
	countTasksWithScope(scopeId: string): number;
}

export interface ScopeCatalogLoadResult extends ParsedScopeCatalog {
	exists: boolean;
}

/**
 * Owns the synced scope catalog. Credentials and runtime-only indexes must use
 * different, local-only storage and cannot pass through this service.
 */
export class ScopeCatalogService {
	private catalog: ScopeCatalog = createScopeCatalog();
	private loaded = false;
	private mutationSafe = false;
	private persistedRaw: string | null = null;

	constructor(
		private readonly storage: ScopeCatalogStorage,
		private readonly references: ScopeReferenceCounter,
	) {}

	current(): ScopeCatalog {
		return createScopeCatalog(this.catalog.scopes);
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	async load(): Promise<ScopeCatalogLoadResult> {
		const raw = await this.storage.read(SCOPE_CATALOG_PATH);
		this.loaded = true;
		this.persistedRaw = raw;
		if (raw === null) {
			this.catalog = createScopeCatalog();
			this.mutationSafe = true;
			return { exists: false, catalog: this.current(), diagnostics: [] };
		}
		let decoded: unknown;
		try {
			decoded = JSON.parse(raw);
		} catch {
			this.catalog = createScopeCatalog();
			this.mutationSafe = false;
			return {
				exists: true,
				catalog: this.current(),
				diagnostics: [
					{ code: "invalid-catalog", message: "scope catalog is not valid JSON" },
				],
			};
		}
		const parsed = parseScopeCatalog(decoded);
		this.catalog = parsed.catalog;
		this.mutationSafe = parsed.diagnostics.length === 0;
		return { exists: true, catalog: this.current(), diagnostics: parsed.diagnostics };
	}

	async initialize(scopes: readonly ScopeDef[]): Promise<ScopeCatalog> {
		this.requireMutationSafe();
		if (this.catalog.scopes.length > 0) throw new Error("scope-catalog-already-initialized");
		const parsed = parseScopeCatalog({ schemaVersion: 1, scopes });
		if (parsed.diagnostics.length > 0 || parsed.catalog.scopes.length !== scopes.length) {
			throw new Error("invalid-scope-catalog");
		}
		await this.persist(parsed.catalog);
		return this.current();
	}

	async create(name: string): Promise<ScopeDef> {
		this.requireMutationSafe();
		const cleanName = validateScopeName(name);
		if (this.catalog.scopes.some((scope) => equalScopeNames(scope.name, cleanName))) {
			throw new Error("scope-name-already-exists");
		}
		const id = uniqueScopeId(cleanName, new Set(this.catalog.scopes.map((scope) => scope.id)));
		const maxOrder = this.catalog.scopes.reduce(
			(maximum, scope) => Math.max(maximum, scope.order),
			-1,
		);
		const scope: ScopeDef = {
			id,
			name: cleanName,
			order: maxOrder + 1,
			archived: false,
		};
		await this.persist(createScopeCatalog([...this.catalog.scopes, scope]));
		return { ...scope };
	}

	async rename(id: string, name: string): Promise<ScopeDef> {
		this.requireMutationSafe();
		const existing = this.requiredScope(id);
		const cleanName = validateScopeName(name);
		if (
			this.catalog.scopes.some(
				(scope) => scope.id !== id && equalScopeNames(scope.name, cleanName),
			)
		) {
			throw new Error("scope-name-already-exists");
		}
		const updated = { ...existing, name: cleanName };
		await this.replace(updated);
		return { ...updated };
	}

	async setArchived(id: string, archived: boolean): Promise<ScopeDef> {
		this.requireMutationSafe();
		const existing = this.requiredScope(id);
		const updated = { ...existing, archived };
		await this.replace(updated);
		return { ...updated };
	}

	async reorder(ids: readonly string[]): Promise<ScopeCatalog> {
		this.requireMutationSafe();
		if (
			ids.length !== this.catalog.scopes.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => scopeById(this.catalog, id) === null)
		) {
			throw new Error("scope-order-must-contain-every-scope-once");
		}
		const order = new Map(ids.map((id, index) => [id, index]));
		const next = this.catalog.scopes.map((scope) => ({
			...scope,
			order: order.get(scope.id)!,
		}));
		await this.persist(createScopeCatalog(next));
		return this.current();
	}

	async delete(id: string): Promise<void> {
		this.requireMutationSafe();
		this.requiredScope(id);
		const references = this.references.countTasksWithScope(id);
		if (references > 0) throw new Error(`scope-is-referenced:${references}`);
		await this.persist(
			createScopeCatalog(this.catalog.scopes.filter((scope) => scope.id !== id)),
		);
	}

	private requiredScope(id: string): ScopeDef {
		if (!isScopeId(id)) throw new Error("invalid-scope-id");
		const scope = scopeById(this.catalog, id);
		if (scope === null) throw new Error("scope-not-found");
		return scope;
	}

	private async replace(updated: ScopeDef): Promise<void> {
		await this.persist(
			createScopeCatalog(
				this.catalog.scopes.map((scope) => (scope.id === updated.id ? updated : scope)),
			),
		);
	}

	private async persist(catalog: ScopeCatalog): Promise<void> {
		const parsed = parseScopeCatalog(catalog);
		if (
			parsed.diagnostics.length > 0 ||
			parsed.catalog.scopes.length !== catalog.scopes.length
		) {
			throw new Error("invalid-scope-catalog");
		}
		const observed = await this.storage.read(SCOPE_CATALOG_PATH);
		if (observed !== this.persistedRaw) throw new Error("scope-catalog-changed");
		const serialized = `${JSON.stringify(parsed.catalog, null, 2)}\n`;
		try {
			await this.storage.writeAtomic(SCOPE_CATALOG_PATH, serialized);
		} catch (error: unknown) {
			// A local atomic replace may commit and lose its acknowledgement.
			if ((await this.storage.read(SCOPE_CATALOG_PATH)) !== serialized) throw error;
		}
		this.catalog = parsed.catalog;
		this.persistedRaw = serialized;
		this.mutationSafe = true;
	}

	private requireLoaded(): void {
		if (!this.loaded) throw new Error("scope-catalog-not-loaded");
	}

	private requireMutationSafe(): void {
		this.requireLoaded();
		if (!this.mutationSafe) throw new Error("scope-catalog-invalid");
	}
}

function validateScopeName(name: string): string {
	const clean = name.trim();
	if (clean === "" || clean.length > 80) throw new Error("invalid-scope-name");
	return clean;
}

function equalScopeNames(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}
