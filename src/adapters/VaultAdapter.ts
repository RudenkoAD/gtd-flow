/**
 * VaultAdapter — тонкая сторона записи. Полноценный WritebackService
 * (якорение по 🆔/rawLine и т.п.) приходит в этапе 3; здесь только
 * атомарные примитивы поверх vault.process/processFrontMatter.
 */
import type { App } from "obsidian";

export class VaultAdapter {
	constructor(private readonly app: App) {}

	/**
	 * Атомарные read-modify-write. transform возвращает null ⇒ содержимое
	 * не меняется (vault.process получает исходную строку обратно).
	 * Возврат: была ли запись изменений. false также при отсутствии файла.
	 */
	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) return false;
		let changed = false;
		await this.app.vault.process(file, (data) => {
			const next = transform(data);
			if (next === null || next === data) return data;
			changed = true;
			return next;
		});
		return changed;
	}

	/** false — файла нет; правку YAML целиком делает Obsidian. */
	async processFrontmatter(
		path: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<boolean> {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) return false;
		await this.app.fileManager.processFrontMatter(file, fn);
		return true;
	}

	/** Создаёт пустой файл (и родительскую папку), если его ещё нет. */
	async ensureFile(path: string): Promise<void> {
		if (this.app.vault.getFileByPath(path) !== null) return;
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir !== "" && this.app.vault.getAbstractFileByPath(dir) === null) {
			// параллельное создание той же папки — не ошибка
			await this.app.vault.createFolder(dir).catch(() => undefined);
		}
		await this.app.vault.create(path, "").catch((error: unknown) => {
			// Another writer may have created the same file between the check and create.
			if (this.app.vault.getFileByPath(path) === null) throw error;
		});
	}

	async readFile(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		return file === null ? null : this.app.vault.cachedRead(file);
	}

	/** AtomicFilePort-compatible alias for synced `.gtd-flow` repositories. */
	async read(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) return null;
		return logicalCasContent(await this.app.vault.read(file));
	}

	/**
	 * Replace a vault-relative text file as one `vault.process` transaction.  The
	 * directory/file creation is performed before the transactional replacement;
	 * once this method resolves readers observe either the old whole text or the
	 * complete new text, never an intermediate serialization.
	 */
	async writeAtomic(path: string, content: string): Promise<void> {
		await this.ensureFile(path);
		const file = this.app.vault.getFileByPath(path);
		if (file === null) throw new Error(`vault-file-create-failed:${path}`);
		await this.app.vault.process(file, () => content);
	}

	/**
	 * Content compare-and-set used by destructive one-time migrations. Existing
	 * files are checked inside `vault.process`, while an absent expected value uses
	 * `vault.create` as create-if-absent. A conditional removal validates through
	 * the same process primitive immediately before deleting the same TFile.
	 */
	async compareAndSet(
		path: string,
		expected: string | null,
		next: string | null,
	): Promise<boolean> {
		const existing = this.app.vault.getFileByPath(path);
		if (expected === null) {
			if (existing !== null) return false;
			if (next === null) return true;
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir !== "" && this.app.vault.getAbstractFileByPath(dir) === null) {
				await this.app.vault.createFolder(dir).catch(() => undefined);
			}
			try {
				await this.app.vault.create(path, next);
				return true;
			} catch (error) {
				const created = this.app.vault.getFileByPath(path);
				if (created !== null && (await this.app.vault.read(created)) === next) throw error;
				if (created !== null) return false;
				throw error;
			}
		}
		if (existing === null) return false;

		let matched = false;
		let deleteToken = next === null ? casDeleteTombstone(expected, uniqueCasToken()) : null;
		try {
			await this.app.vault.process(existing, (current) => {
				if (logicalCasContent(current) !== expected) return current;
				matched = true;
				if (next === null && logicalCasContent(current) !== current) {
					deleteToken = current;
					return current;
				}
				return next ?? deleteToken!;
			});
		} catch (error) {
			if (deleteToken === null || (await this.app.vault.read(existing)) !== deleteToken) {
				throw error;
			}
			matched = true;
		}
		if (!matched) return false;
		if (next !== null) return true;

		// There is no conditional-unlink primitive in Obsidian's public Vault API.
		// Install a unique tombstone through the serialized process path, then use
		// authoritative reads (never cachedRead) on both sides of a second process
		// barrier. Any observed intervening edit is preserved and reported as a CAS
		// miss; only the still-owned tombstone is handed to delete.
		if ((await this.app.vault.read(existing)) !== deleteToken) return false;
		let stillOwned = false;
		try {
			await this.app.vault.process(existing, (current) => {
				if (current !== deleteToken) return current;
				stillOwned = true;
				return current;
			});
		} catch (error) {
			if ((await this.app.vault.read(existing)) !== deleteToken) throw error;
			stillOwned = true;
		}
		if (!stillOwned || (await this.app.vault.read(existing)) !== deleteToken) return false;
		try {
			await this.app.vault.delete(existing, true);
			return true;
		} catch (error) {
			const current = this.app.vault.getFileByPath(path);
			if (current !== null && (await this.app.vault.read(current)) === deleteToken) {
				await this.app.vault.process(current, (value) =>
					value === deleteToken ? expected : value,
				);
			}
			throw error;
		}
	}

	/**
	 * Creates an immutable synced record. `vault.create` is the strongest
	 * create-if-absent primitive available to the plugin; it is deliberately not
	 * implemented as read-then-replace.
	 */
	async writeNew(path: string, content: string): Promise<void> {
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir !== "" && this.app.vault.getAbstractFileByPath(dir) === null) {
			await this.app.vault.createFolder(dir).catch(() => undefined);
		}
		if (this.app.vault.getFileByPath(path) !== null) {
			throw new Error(`vault-file-exists:${path}`);
		}
		try {
			await this.app.vault.create(path, content);
		} catch (error) {
			if (this.app.vault.getFileByPath(path) !== null) {
				throw new Error(`vault-file-exists:${path}`);
			}
			throw error;
		}
	}

	/** Delete a vault file for an explicit rollback snapshot. */
	async remove(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file !== null) await this.app.vault.delete(file, true);
	}

	/** List vault-relative files below a prefix for synced-record repositories. */
	async list(pathPrefix: string): Promise<string[]> {
		const prefix = pathPrefix.replace(/^\/+|\/+$/gu, "");
		const boundary = prefix === "" ? "" : `${prefix}/`;
		return this.app.vault
			.getFiles()
			.map((file) => file.path)
			.filter((path) => prefix === "" || path === prefix || path.startsWith(boundary))
			.sort();
	}
}

function uniqueCasToken(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	);
}

function casDeleteTombstone(expected: string, token: string): string {
	return `${expected}<!-- gtd-flow conditional delete ${token} expected-length=${expected.length} -->\n`;
}

function logicalCasContent(content: string): string {
	const match = /<!-- gtd-flow conditional delete [^\s>\r\n]+ expected-length=(\d+) -->\n$/u.exec(
		content,
	);
	if (match === null) return content;
	const expectedLength = Number(match[1]);
	if (
		!Number.isSafeInteger(expectedLength) ||
		expectedLength < 0 ||
		match.index !== expectedLength
	) {
		return content;
	}
	return content.slice(0, expectedLength);
}
