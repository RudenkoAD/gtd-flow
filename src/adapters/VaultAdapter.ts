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
		await this.app.vault.create(path, "");
	}

	async readFile(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		return file === null ? null : this.app.vault.cachedRead(file);
	}
}
