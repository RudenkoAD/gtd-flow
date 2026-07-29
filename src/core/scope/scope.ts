/**
 * Stable, sync-safe scope definitions.
 *
 * A task stores only `ScopeDef.id`; users may rename the display name without
 * rewriting every Markdown task line. Archived scopes remain resolvable for
 * existing tasks but cannot be selected for new AI classifications.
 */

export interface ScopeDef {
	/** Stable task-line token. Immutable after creation. */
	id: string;
	/** User-facing name. */
	name: string;
	/** Stable display order. Lower values are shown first. */
	order: number;
	/** Archived scopes remain readable but are not valid new classifications. */
	archived: boolean;
}

export interface ScopeCatalog {
	schemaVersion: 1;
	scopes: ScopeDef[];
}

export const SCOPE_CATALOG_SCHEMA_VERSION = 1 as const;

const SCOPE_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const MAX_SCOPE_NAME_LENGTH = 80;
const MAX_SCOPES = 100;

export type ScopeCatalogDiagnostic =
	| { code: "invalid-catalog"; message: string }
	| { code: "invalid-scope"; index: number; message: string }
	| { code: "duplicate-id"; index: number; id: string; message: string }
	| { code: "duplicate-name"; index: number; name: string; message: string }
	| { code: "duplicate-order"; index: number; order: number; message: string };

export interface ParsedScopeCatalog {
	catalog: ScopeCatalog;
	diagnostics: ScopeCatalogDiagnostic[];
}

export function isScopeId(value: unknown): value is string {
	return typeof value === "string" && SCOPE_ID_RE.test(value);
}

/**
 * Generate a readable candidate ID. Collision resolution remains the caller's
 * responsibility because it owns the current catalog.
 */
export function scopeIdCandidate(name: string): string {
	const normalized = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f]/gu, "")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 64)
		.replace(/-+$/gu, "");
	return isScopeId(normalized) ? normalized : "scope";
}

export function uniqueScopeId(name: string, occupied: ReadonlySet<string>): string {
	const base = scopeIdCandidate(name);
	if (!occupied.has(base)) return base;
	for (let suffix = 2; suffix <= 9_999; suffix++) {
		const suffixText = `-${suffix}`;
		const candidate = `${base.slice(0, 64 - suffixText.length).replace(/[-_]+$/gu, "")}${suffixText}`;
		if (isScopeId(candidate) && !occupied.has(candidate)) return candidate;
	}
	throw new Error("scope-id-space-exhausted");
}

export function activeScopes(catalog: ScopeCatalog): ScopeDef[] {
	return [...catalog.scopes]
		.filter((scope) => !scope.archived)
		.sort(
			(a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
		);
}

export function scopeById(catalog: ScopeCatalog, id: string | null): ScopeDef | null {
	if (id === null) return null;
	return catalog.scopes.find((scope) => scope.id === id) ?? null;
}

export function isActiveScopeId(catalog: ScopeCatalog, id: unknown): id is string {
	return isScopeId(id) && catalog.scopes.some((scope) => scope.id === id && !scope.archived);
}

export function createScopeCatalog(scopes: readonly ScopeDef[] = []): ScopeCatalog {
	return {
		schemaVersion: SCOPE_CATALOG_SCHEMA_VERSION,
		scopes: scopes.map((scope) => ({ ...scope })),
	};
}

/**
 * Parse untrusted synced JSON fail-closed. Invalid entries are dropped and
 * diagnosed; duplicates keep the first valid occurrence so sync conflicts
 * cannot silently change the meaning of a task's stored scope ID.
 */
export function parseScopeCatalog(value: unknown): ParsedScopeCatalog {
	const diagnostics: ScopeCatalogDiagnostic[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {
			catalog: createScopeCatalog(),
			diagnostics: [{ code: "invalid-catalog", message: "scope catalog must be an object" }],
		};
	}
	const record = value as Record<string, unknown>;
	if (record["schemaVersion"] !== SCOPE_CATALOG_SCHEMA_VERSION) {
		return {
			catalog: createScopeCatalog(),
			diagnostics: [
				{
					code: "invalid-catalog",
					message: `unsupported scope catalog schema ${String(record["schemaVersion"])}`,
				},
			],
		};
	}
	if (!Array.isArray(record["scopes"])) {
		return {
			catalog: createScopeCatalog(),
			diagnostics: [
				{ code: "invalid-catalog", message: "scope catalog scopes must be an array" },
			],
		};
	}

	const scopes: ScopeDef[] = [];
	const ids = new Set<string>();
	const names = new Set<string>();
	const orders = new Set<number>();
	for (let index = 0; index < record["scopes"].length && index < MAX_SCOPES; index++) {
		const raw = record["scopes"][index];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			diagnostics.push({ code: "invalid-scope", index, message: "scope must be an object" });
			continue;
		}
		const item = raw as Record<string, unknown>;
		const id = item["id"];
		const rawName = item["name"];
		const order = item["order"];
		const archived = item["archived"];
		const name = typeof rawName === "string" ? rawName.trim() : "";
		if (
			!isScopeId(id) ||
			name === "" ||
			name.length > MAX_SCOPE_NAME_LENGTH ||
			!Number.isSafeInteger(order) ||
			typeof archived !== "boolean"
		) {
			diagnostics.push({
				code: "invalid-scope",
				index,
				message: "scope id, name, order, or archived value is invalid",
			});
			continue;
		}
		if (ids.has(id)) {
			diagnostics.push({
				code: "duplicate-id",
				index,
				id,
				message: `duplicate scope id '${id}' ignored`,
			});
			continue;
		}
		const nameKey = name.toLowerCase();
		if (names.has(nameKey)) {
			diagnostics.push({
				code: "duplicate-name",
				index,
				name,
				message: `duplicate scope name '${name}' ignored`,
			});
			continue;
		}
		if (orders.has(order as number)) {
			diagnostics.push({
				code: "duplicate-order",
				index,
				order: order as number,
				message: `duplicate scope order '${String(order)}' ignored`,
			});
			continue;
		}
		ids.add(id);
		names.add(nameKey);
		orders.add(order as number);
		scopes.push({ id, name, order: order as number, archived });
	}
	if (record["scopes"].length > MAX_SCOPES) {
		diagnostics.push({
			code: "invalid-catalog",
			message: `scope catalog is limited to ${MAX_SCOPES} entries`,
		});
	}
	return { catalog: createScopeCatalog(scopes), diagnostics };
}
