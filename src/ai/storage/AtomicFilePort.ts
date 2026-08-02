/**
 * Vault-relative, atomic persistence boundary. Implementations must guarantee
 * that a successful write replaces a whole file, never a partially-written one.
 */
export interface AtomicFilePort {
	read(path: string): Promise<string | null>;
	writeAtomic(path: string, content: string): Promise<void>;
	/**
	 * Creates one immutable record. It must reject if the path already exists;
	 * callers use it for sync-mergeable records and never emulate it with a
	 * read followed by `writeAtomic`.
	 *
	 * This is atomic only within the backing vault adapter. Obsidian sync itself
	 * does not expose a cross-device linearizable create/CAS primitive.
	 */
	writeNew(path: string, content: string): Promise<void>;
	list(pathPrefix: string): Promise<string[]>;
}

export const GTD_FLOW_FOLDER = ".gtd-flow";

export class SyncedStorageError extends Error {
	constructor(readonly code: "conflict" | "invalid-record" | "not-found") {
		super(code);
		this.name = "SyncedStorageError";
	}
}

export async function readJsonFile(port: AtomicFilePort, path: string): Promise<unknown | null> {
	const content = await port.read(path);
	// Пустой файл — не запись, а след оборванной записи (так дот-пути создавала
	// 0.13.x через TFile-API, так же выглядит обрезанный синк). Для конфигов это
	// «файла нет»; неизменяемые записи ловят null отдельной проверкой.
	if (content === null || content.trim() === "") return null;
	try {
		return JSON.parse(content);
	} catch {
		throw new SyncedStorageError("invalid-record");
	}
}

export function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

const CREDENTIAL_KEY_PATTERN =
	/(?:api.?key|authorization|bearer|client.?secret|code.?verifier|credential|access.?token|refresh.?token|private.?key|secret)/iu;

/**
 * Synced schemas may contain provider-neutral, user-visible text, but never a
 * structured credential field. The iterative walk is cycle-safe for live
 * caller objects as well as bounded against hostile synced JSON.
 */
export function hasCredentialShapedKey(value: unknown): boolean {
	const pending: unknown[] = [value];
	const seen = new Set<object>();
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current !== "object" || current === null) continue;
		if (seen.has(current)) continue;
		seen.add(current);
		visited++;
		if (visited > 100_000) return true;
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
			if (CREDENTIAL_KEY_PATTERN.test(key)) return true;
			pending.push(nested);
		}
	}
	return false;
}
