/**
 * MetadataAdapter — единственный «тяжёлый» потребитель API Obsidian на
 * стороне чтения: превращает TFile + metadataCache в плоский FileSnapshot
 * и транслирует события хранилища в VaultEvents. Вся логика проекции —
 * в чистых snapshotHelpers; здесь только обвязка.
 *
 * Импорт 'obsidian' строго type-only: рантайм-значения приходят через
 * инжектированный Plugin, поэтому файл загружаем и в node-тестах.
 */
import type { CachedMetadata, Plugin, TAbstractFile, TFile } from "obsidian";
import { fileContextFromFrontmatter, snapshotListItems } from "../services/snapshotHelpers";
import type { FileSnapshot, VaultEvents } from "../services/types";

/** TFolder не имеет extension — этого достаточно, чтобы отличить markdown-файл
 *  без runtime-импорта класса TFile (instanceof потребовал бы модуль obsidian). */
function isMarkdownFile(file: TAbstractFile): file is TFile {
	return (file as Partial<TFile>).extension === "md";
}

export class MetadataAdapter implements VaultEvents {
	constructor(private readonly plugin: Plugin) {}

	private get app() {
		return this.plugin.app;
	}

	onChanged(cb: (snap: FileSnapshot) => void): () => void {
		const ref = this.app.metadataCache.on("changed", (file, data, cache) => {
			if (!isMarkdownFile(file)) return;
			cb(this.toSnapshot(file, data, cache));
		});
		this.plugin.registerEvent(ref);
		return () => this.app.metadataCache.offref(ref);
	}

	onDeleted(cb: (path: string) => void): () => void {
		const ref = this.app.vault.on("delete", (file) => {
			if (isMarkdownFile(file)) cb(file.path);
		});
		this.plugin.registerEvent(ref);
		return () => this.app.vault.offref(ref);
	}

	onRenamed(cb: (oldPath: string, snap: FileSnapshot) => void): () => void {
		const ref = this.app.vault.on("rename", (file, oldPath) => {
			if (!isMarkdownFile(file)) return;
			// свежий снапшот: переезд мог сменить fileContext (папка/frontmatter)
			void this.snapshotFile(file).then((snap) => cb(oldPath, snap));
		});
		this.plugin.registerEvent(ref);
		return () => this.app.vault.offref(ref);
	}

	/** Первичный обход всех markdown-файлов; потребляется IndexerService чанками. */
	async *initialScan(): AsyncIterable<FileSnapshot> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			yield await this.snapshotFile(file);
		}
	}

	/**
	 * Плоская копия frontmatter файла из кэша метаданных; null — файла нет,
	 * он не markdown или frontmatter отсутствует. Служебный ключ `position`
	 * (артефакт кэша Obsidian) вырезается — потребители (parseBoardFrontmatter)
	 * ждут чистый YAML-объект.
	 */
	frontmatter(path: string): Record<string, unknown> | null {
		const file = this.app.vault.getFileByPath(path);
		if (file === null || !isMarkdownFile(file)) return null;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm === undefined || fm === null) return null;
		const copy: Record<string, unknown> = { ...fm };
		delete copy["position"];
		return copy;
	}

	async snapshotFile(file: TFile): Promise<FileSnapshot> {
		const content = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		return this.toSnapshot(file, content, cache);
	}

	private toSnapshot(file: TFile, content: string, cache: CachedMetadata | null): FileSnapshot {
		return {
			path: file.path,
			content,
			listItems: snapshotListItems(cache?.listItems ?? [], cache?.headings ?? []),
			context: fileContextFromFrontmatter(file.path, cache?.frontmatter),
		};
	}
}
