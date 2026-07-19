/**
 * FsVault — реализация структурных портов vault'а поверх файловой системы.
 *
 * Плагин пишет через VaultAdapter (app.vault.process / processFrontMatter);
 * MCP-серверу нужен тот же контракт БЕЗ Obsidian. FsVault совместим с WritePort
 * (WritebackService), EventVaultPort/FrontmatterVaultPort (eventSeries/taskActions)
 * и BoardService.{readFrontmatter,patchFrontmatter,ensureFile}.
 *
 * БЕЗОПАСНОСТЬ: все операции адресуются vault-относительными POSIX-путями и строго
 * заперты внутри корня (abs() отвергает выход за пределы). Удаления файлов нет.
 * Запись атомарна: temp-файл + rename (переживает сбой посередине — файл либо
 * старый целиком, либо новый целиком, никогда полу-записанный).
 */
import { promises as fs } from "fs";
import { readFileSync } from "fs";
import * as path from "path";
import { applyFrontmatter, readFrontmatter } from "./frontmatter";

export interface VaultFile {
	/** Vault-относительный путь с прямыми слэшами. */
	path: string;
	content: string;
}

/** Папки, которые никогда не сканируются и не индексируются. */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git"]);

export class FsVault {
	/** Абсолютный нормализованный корень vault'а. */
	private readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	/**
	 * Vault-относительный POSIX-путь → абсолютный путь ФС, с запретом выхода за
	 * корень (защита от «../» и абсолютных путей в аргументах инструментов).
	 */
	private abs(relPosix: string): string {
		const rel = relPosix.split("/").join(path.sep);
		const resolved = path.resolve(this.root, rel);
		const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
		if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
			throw new Error(`путь выходит за пределы vault: ${relPosix}`);
		}
		return resolved;
	}

	// --- WritePort / EventVaultPort ---

	/**
	 * Атомарный read-modify-write. transform возвращает null или неизменённую
	 * строку ⇒ запись не производится. Возврат: были ли записаны изменения
	 * (false также при отсутствии файла — как VaultAdapter.processFile).
	 */
	async processFile(
		relPath: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		const abs = this.abs(relPath);
		let content: string;
		try {
			content = await fs.readFile(abs, "utf8");
		} catch {
			return false; // файла нет
		}
		const next = transform(content);
		if (next === null || next === content) return false;
		await this.atomicWrite(abs, next);
		return true;
	}

	/** false — файла нет; иначе frontmatter мутируется и переписывается атомарно. */
	async processFrontmatter(
		relPath: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<boolean> {
		const abs = this.abs(relPath);
		let content: string;
		try {
			content = await fs.readFile(abs, "utf8");
		} catch {
			return false;
		}
		const next = applyFrontmatter(content, fn);
		if (next !== content) await this.atomicWrite(abs, next);
		return true;
	}

	/** Создать пустой файл (и родительские папки), если его ещё нет. */
	async ensureFile(relPath: string): Promise<void> {
		const abs = this.abs(relPath);
		try {
			await fs.access(abs);
			return; // уже есть
		} catch {
			/* создаём ниже */
		}
		await fs.mkdir(path.dirname(abs), { recursive: true });
		try {
			await fs.writeFile(abs, "", { flag: "wx" }); // wx — не перезаписать гонку create
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}

	// --- чтение ---

	async readFile(relPath: string): Promise<string | null> {
		const abs = this.abs(relPath);
		try {
			return await fs.readFile(abs, "utf8");
		} catch {
			return null;
		}
	}

	/** Синхронное чтение frontmatter (BoardService/ProjectService.readFrontmatter). */
	readFrontmatterSync(relPath: string): Record<string, unknown> | null {
		let abs: string;
		try {
			abs = this.abs(relPath);
		} catch {
			return null;
		}
		try {
			return readFrontmatter(readFileSync(abs, "utf8"));
		} catch {
			return null;
		}
	}

	/**
	 * Все *.md файлы vault'а (рекурсивно), пропуская .obsidian/.trash/.git и любые
	 * скрытые (dot-) папки. Путь — vault-относительный POSIX. Порядок не гарантирован.
	 */
	async listMarkdownFiles(): Promise<VaultFile[]> {
		const out: VaultFile[] = [];
		const walk = async (absDir: string, relDir: string): Promise<void> => {
			let entries: import("fs").Dirent[];
			try {
				entries = await fs.readdir(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
				if (entry.isDirectory()) {
					if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
					await walk(path.join(absDir, entry.name), rel);
				} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
					try {
						out.push({ path: rel, content: await fs.readFile(path.join(absDir, entry.name), "utf8") });
					} catch {
						// нечитаемый файл пропускаем — один битый файл не роняет весь скан
					}
				}
			}
		};
		await walk(this.root, "");
		return out;
	}

	private async atomicWrite(abs: string, data: string): Promise<void> {
		const tmp = `${abs}.gtdmcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
		await fs.writeFile(tmp, data, "utf8");
		try {
			await fs.rename(tmp, abs); // атомарная замена (MoveFileEx replace на Windows)
		} catch (e) {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw e;
		}
	}
}
