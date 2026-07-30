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
 * \u041a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430 \u2192 \u043b\u0430\u0442\u0438\u043d\u0438\u0446\u0430 \u0434\u043b\u044f scope-id. NFKD \u0435\u0451 \u043d\u0435 \u0440\u0430\u0441\u043a\u043b\u0430\u0434\u044b\u0432\u0430\u0435\u0442, \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u0431\u0435\u0437
 * \u0442\u0430\u0431\u043b\u0438\u0446\u044b \u00ab\u0420\u0430\u0431\u043e\u0442\u0430\u00bb/\u00ab\u041b\u0438\u0447\u043d\u043e\u0435\u00bb/\u00ab\u0414\u043e\u043c\u00bb \u0441\u0445\u043b\u043e\u043f\u044b\u0432\u0430\u043b\u0438\u0441\u044c \u0432 \u043f\u0443\u0441\u0442\u0443\u044e \u0441\u0442\u0440\u043e\u043a\u0443 \u0438 \u0434\u0430\u0432\u0430\u043b\u0438
 * \u043d\u0435\u0447\u0438\u0442\u0430\u0435\u043c\u044b\u0435 `scope`, `scope-2`, `scope-3` \u043f\u0440\u044f\u043c\u043e \u0432 \u0442\u0435\u043a\u0441\u0442\u0435 \u0437\u0430\u0434\u0430\u0447 (\ud83e\udded <id>), \u0430 id
 * \u043d\u0435\u0438\u0437\u043c\u0435\u043d\u044f\u0435\u043c \u043f\u043e\u0441\u043b\u0435 \u0441\u043e\u0437\u0434\u0430\u043d\u0438\u044f. \u041e\u0441\u043d\u043e\u0432\u043d\u043e\u0439 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u043f\u0440\u043e\u0435\u043a\u0442\u0430 \u2014 \u0440\u0443\u0441\u0441\u043a\u043e\u044f\u0437\u044b\u0447\u043d\u044b\u0439.
 */
const CYRILLIC_TRANSLITERATION: Readonly<Record<string, string>> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ё: "e",
	ж: "zh",
	з: "z",
	и: "i",
	й: "y",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ф: "f",
	х: "h",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "sch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
	// \u0443\u043a\u0440\u0430\u0438\u043d\u0441\u043a\u0438\u0435/\u0431\u0435\u043b\u043e\u0440\u0443\u0441\u0441\u043a\u0438\u0435 \u0431\u0443\u043a\u0432\u044b, \u0432\u0441\u0442\u0440\u0435\u0447\u0430\u044e\u0449\u0438\u0435\u0441\u044f \u0432 \u0438\u043c\u0435\u043d\u0430\u0445 \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432
	і: "i",
	ї: "yi",
	є: "ye",
	ґ: "g",
	ў: "u",
};

function transliterate(lowerCased: string): string {
	let out = "";
	for (const ch of lowerCased) {
		out += CYRILLIC_TRANSLITERATION[ch] ?? ch;
	}
	return out;
}

/**
 * Generate a readable candidate ID. Collision resolution remains the caller's
 * responsibility because it owns the current catalog.
 */
export function scopeIdCandidate(name: string): string {
	const normalized = transliterate(
		name
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[\u0300-\u036f]/gu, ""),
	)
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
