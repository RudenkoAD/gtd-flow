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
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	promises as fs,
	readFileSync,
	realpathSync,
	type Dirent,
	type Stats,
} from "fs";
import { createHash } from "crypto";
import * as path from "path";
import { applyFrontmatter, InvalidFrontmatterError, readFrontmatter } from "./frontmatter";

export interface VaultFile {
	/** Vault-относительный путь с прямыми слэшами. */
	path: string;
	content: string;
}

/** Результат инкрементального скана. revision меняется при добавлении/удалении/
 * замене Markdown-файла и пригоден для кэша построенного TaskIndex. */
export interface VaultScan {
	files: VaultFile[];
	revision: string;
}

/** Контекст попытки optimistic commit. Опция нужна только для failure-injection
 * тестов; в production не задаётся. */
export interface MutationAttempt {
	relPath: string;
	attempt: number;
	expectedContent: string;
	nextContent: string;
}

export interface FsVaultOptions {
	/** Максимум повторов после внешней модификации между read и commit. */
	maxMutationAttempts?: number;
	/** Test seam: вызывается перед проверкой optimistic snapshot. */
	beforeCommit?: (attempt: MutationAttempt) => void | Promise<void>;
	/** Test seam: вызывается после lstat каталога, до его readdir. */
	beforeDirectoryRead?: (relPath: string) => void | Promise<void>;
}

/** Конфликт с независимым процессом/Obsidian. Такой результат обязан стать ошибкой
 * инструмента, а не успешным ответом с потерянной мутацией. */
export class McpMutationConflictError extends Error {
	constructor(relPath: string, attempts: number) {
		super(
			`concurrent modification of '${relPath}' prevented a safe write after ${attempts} attempts; retry the operation`,
		);
		this.name = "McpMutationConflictError";
	}
}

/** A scan race or I/O failure must not masquerade as an authoritative empty vault. */
export class McpVaultScanError extends Error {
	constructor() {
		super("vault scan could not establish a safe complete snapshot; retry the operation");
		this.name = "McpVaultScanError";
	}
}

/** Папки, которые никогда не сканируются и не индексируются. */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git"]);
const SCAN_IO_CONCURRENCY = 8;
const MAX_SHARED_CACHES = 16;
const DEFAULT_MUTATION_ATTEMPTS = 5;
/**
 * Open the terminal path element without following a symlink. On POSIX this
 * closes the lstat→read race; the identity checks below remain necessary for
 * platforms that do not enforce O_NOFOLLOW and for ordinary rename races.
 */
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Windows сравнивает пути без регистра. Darwin этого НЕ гарантирует: APFS может
 * быть case-sensitive, а realpath на case-insensitive томе и так возвращает
 * каноническое написание. */
const CASE_INSENSITIVE_FS = process.platform === "win32";

interface FileStamp {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
}

interface FileSnapshot {
	content: string;
	stamp: FileStamp;
	mode: number;
}

interface CachedVaultFile extends FileSnapshot {}

interface VaultScanCache {
	files: Map<string, CachedVaultFile>;
	/**
	 * Metadata tree for the last complete recursive directory listing. Rechecking
	 * directory metadata on a later call is much cheaper than another recursive
	 * readdir, while changes to *any* known directory force a full rebuild so an
	 * external add/remove cannot be hidden by the body cache.
	 *
	 * Keys are vault-relative POSIX paths; the root is the empty string.
	 */
	directories: Map<string, FileStamp>;
	/** A failed readdir must never turn a partial tree into a trusted index. */
	directoryIndexComplete: boolean;
}

interface MarkdownPath {
	relPath: string;
	absPath: string;
}

/** realpath без исключений: null, если путь не существует/недоступен. */
function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

function isNotFound(e: unknown): boolean {
	return (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function stampOf(stat: Stats): FileStamp {
	return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
	return (
		a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino
	);
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
	return a.content === b.content && sameStamp(a.stamp, b.stamp);
}

/** Collision-resistant fingerprint metadata for the session TaskIndex cache. */
function scanRevision(entries: readonly { path: string; stamp: FileStamp }[]): string {
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
	const hash = createHash("sha256");
	for (const entry of sorted) {
		const text = `${entry.path}\u0000${entry.stamp.ino}\u0000${entry.stamp.size}\u0000${entry.stamp.mtimeMs}\u0000${entry.stamp.ctimeMs}\u0001`;
		hash.update(text, "utf8");
	}
	return `sha256:${sorted.length}:${hash.digest("hex")}`;
}

/** Асинхронная очередь на путь. Она разделяется всеми FsVault одного процесса:
 * registerTools создаёт сессии на каждый MCP call, поэтому экземплярная очередь
 * была бы недостаточна. */
class PathMutationCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, action: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		this.tails.set(key, tail);
		await previous;
		try {
			return await action();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

/**
 * «Физический» путь кандидата: realpath глубочайшего СУЩЕСТВУЮЩЕГО предка +
 * несуществующий хвост как есть. Нужен для записи новых файлов: сам файл ещё
 * не существует, но его существующие предки не должны выводить за корень
 * через симлинк.
 */
function realDeepestExisting(absPath: string): string {
	let dir = absPath;
	let tail = "";
	// Поднимаемся, пока не найдём существующего предка (корень ФС существует всегда).
	for (;;) {
		const real = safeRealpath(dir);
		if (real !== null) return tail === "" ? real : path.join(real, tail);
		const parent = path.dirname(dir);
		if (parent === dir) return absPath; // дошли до корня ФС — как есть
		tail = tail === "" ? path.basename(dir) : path.join(path.basename(dir), tail);
		dir = parent;
	}
}

/** Принадлежит ли путь корню (сам корень или строго внутри). На Darwin полагаемся
 * на канонические пути realpath, не на предположение о файловой системе. */
function isInsideRoot(candidate: string, root: string): boolean {
	const a = CASE_INSENSITIVE_FS ? candidate.toLowerCase() : candidate;
	const r = CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
	if (a === r) return true;
	const rootWithSep = r.endsWith(path.sep) ? r : r + path.sep;
	return a.startsWith(rootWithSep);
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await fn(items[index]!);
		}
	});
	await Promise.all(workers);
	return out;
}

export class FsVault {
	private static readonly mutationCoordinator = new PathMutationCoordinator();
	/** Кэш разделяется между короткоживущими MCP-сессиями. Значит повторный вызов
	 * делает только обход/metadata stat, а не перечитывает все тела заметок. */
	private static readonly scanCaches = new Map<string, VaultScanCache>();

	/** Абсолютный нормализованный корень vault'а (realpath — симлинки развёрнуты). */
	private readonly root: string;
	private readonly maxMutationAttempts: number;
	private readonly beforeCommit: ((attempt: MutationAttempt) => void | Promise<void>) | undefined;
	private readonly beforeDirectoryRead: ((relPath: string) => void | Promise<void>) | undefined;

	constructor(root: string, options: FsVaultOptions = {}) {
		// realpath корня один раз: сравнение путей ниже идёт по «физическим» путям,
		// иначе симлинк-корень (или иной регистр буквы диска на Windows) ломал бы
		// префикс-проверку честных путей и/или пропускал бы обходные.
		const resolved = path.resolve(root);
		this.root = safeRealpath(resolved) ?? resolved;
		this.maxMutationAttempts = Math.max(
			1,
			Math.floor(options.maxMutationAttempts ?? DEFAULT_MUTATION_ATTEMPTS),
		);
		this.beforeCommit = options.beforeCommit;
		this.beforeDirectoryRead = options.beforeDirectoryRead;
	}

	/** Идентификатор cache domain для session-level TaskIndex cache. */
	get cacheIdentity(): string {
		return this.root;
	}

	/**
	 * Vault-относительный POSIX-путь → абсолютный путь ФС, с запретом выхода за
	 * корень (защита от «../», абсолютных путей и симлинк-обхода в аргументах
	 * инструментов). Целевой файл может ещё не существовать (запись) — поэтому
	 * realpath берётся от ГЛУБОЧАЙШЕГО существующего предка, и уже физический
	 * путь проверяется на принадлежность корню.
	 */
	private abs(relPosix: string): string {
		const rel = relPosix.split("/").join(path.sep);
		const resolved = path.resolve(this.root, rel);
		const real = realDeepestExisting(resolved);
		if (!isInsideRoot(real, this.root) || !isInsideRoot(resolved, this.root)) {
			throw new Error(`путь выходит за пределы vault: ${relPosix}`);
		}
		return resolved;
	}

	private mutationKey(abs: string): string {
		// Existing file paths get the real spelling, so e.g. two callers through a
		// case-insensitive APFS spelling still share one queue. For a new file the
		// resolved in-root spelling is sufficient because creation itself uses wx.
		const canonical = safeRealpath(abs) ?? abs;
		return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical;
	}

	private scanCache(): VaultScanCache {
		const existing = FsVault.scanCaches.get(this.root);
		if (existing !== undefined) {
			// Map insertion order is a compact LRU: avoid retaining arbitrary temporary
			// test or multi-vault caches forever in a long-running MCP process.
			FsVault.scanCaches.delete(this.root);
			FsVault.scanCaches.set(this.root, existing);
			return existing;
		}
		const cache: VaultScanCache = {
			files: new Map(),
			directories: new Map(),
			directoryIndexComplete: false,
		};
		FsVault.scanCaches.set(this.root, cache);
		while (FsVault.scanCaches.size > MAX_SHARED_CACHES) {
			const oldest = FsVault.scanCaches.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			FsVault.scanCaches.delete(oldest);
		}
		return cache;
	}

	/** Returns the canonical physical path only while it remains inside this vault. */
	private inRootRealpath(absPath: string): string | null {
		const physical = safeRealpath(absPath);
		return physical !== null && isInsideRoot(physical, this.root) ? physical : null;
	}

	/**
	 * Read one stable, regular in-vault file through a descriptor. Opening with
	 * O_NOFOLLOW rejects a final-component symlink on POSIX; handle.stat before
	 * and after reading, plus a final lstat of the pathname, reject a rename/swap
	 * race rather than pairing bytes from one inode with metadata from another.
	 *
	 * On a platform where O_NOFOLLOW is unavailable or ignored, the post-read
	 * pathname identity check still fail-closes a detected symlink swap. There is
	 * no portable Node API for an equivalent Windows path-handle no-follow open.
	 */
	private async snapshot(abs: string): Promise<FileSnapshot | null> {
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		try {
			const physicalBefore = this.inRootRealpath(abs);
			if (physicalBefore === null) return null;
			handle = await fs.open(abs, READ_NOFOLLOW);
			const before = await handle.stat();
			if (!before.isFile()) return null;
			const beforeStamp = stampOf(before);
			const content = await handle.readFile({ encoding: "utf8" });
			const after = await handle.stat();
			const pathStat = await fs.lstat(abs);
			const physicalAfter = this.inRootRealpath(abs);
			if (
				!after.isFile() ||
				!pathStat.isFile() ||
				physicalAfter === null ||
				physicalAfter !== physicalBefore ||
				!sameStamp(beforeStamp, stampOf(after)) ||
				!sameStamp(beforeStamp, stampOf(pathStat))
			) {
				return null;
			}
			return { content, stamp: beforeStamp, mode: before.mode & 0o7777 };
		} catch (e) {
			// ELOOP is the POSIX O_NOFOLLOW rejection for a symlink. Treat it like a
			// vanished file: callers fail closed without ever using target contents.
			if (isNotFound(e) || (e as NodeJS.ErrnoException | undefined)?.code === "ELOOP")
				return null;
			throw e;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	/** Synchronous equivalent for BoardService's synchronous frontmatter port. */
	private snapshotSync(abs: string): FileSnapshot | null {
		let fd: number | undefined;
		try {
			const physicalBefore = this.inRootRealpath(abs);
			if (physicalBefore === null) return null;
			fd = openSync(abs, READ_NOFOLLOW);
			const before = fstatSync(fd);
			if (!before.isFile()) return null;
			const beforeStamp = stampOf(before);
			const content = readFileSync(fd, "utf8");
			const after = fstatSync(fd);
			const pathStat = lstatSync(abs);
			const physicalAfter = this.inRootRealpath(abs);
			if (
				!after.isFile() ||
				!pathStat.isFile() ||
				physicalAfter === null ||
				physicalAfter !== physicalBefore ||
				!sameStamp(beforeStamp, stampOf(after)) ||
				!sameStamp(beforeStamp, stampOf(pathStat))
			) {
				return null;
			}
			return { content, stamp: beforeStamp, mode: before.mode & 0o7777 };
		} catch {
			return null;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Ignore close after an already failed synchronous read.
				}
			}
		}
	}

	private cacheRelativePath(absPath: string): string {
		// Cache keys must be canonical. A caller may legitimately use
		// "Sub/../Note.md"; retaining that spelling alongside "Note.md" would make
		// the no-readdir path return the same physical note twice.
		const physical = this.inRootRealpath(absPath);
		if (physical === null) {
			throw new Error("refusing to cache a path outside the vault");
		}
		return path.relative(this.root, physical).split(path.sep).join("/");
	}

	private async rememberFile(absPath: string, snapshot: FileSnapshot): Promise<void> {
		const cache = this.scanCache();
		let relPath: string;
		try {
			relPath = this.cacheRelativePath(absPath);
		} catch {
			// The path was swapped after a successful mutation snapshot. Do not let an
			// outside realpath become a cached key; force a fresh, no-follow scan.
			cache.directoryIndexComplete = false;
			return;
		}
		cache.files.set(relPath, snapshot);

		// An atomic replacement changes the direct parent directory's metadata.
		// Refresh that one known entry so writes performed through this FsVault do
		// not needlessly invalidate an otherwise valid directory index. New parent
		// directories are handled by ensureFile(), which invalidates the whole tree.
		const relDir = path.posix.dirname(relPath);
		const cachedDir = relDir === "." ? "" : relDir;
		if (!cache.directories.has(cachedDir)) return;
		try {
			const stat = await fs.lstat(this.absoluteFromCachePath(cachedDir));
			if (stat.isDirectory()) cache.directories.set(cachedDir, stampOf(stat));
			else cache.directoryIndexComplete = false;
		} catch {
			cache.directoryIndexComplete = false;
		}
	}

	private absoluteFromCachePath(relPath: string): string {
		return relPath === "" ? this.root : path.join(this.root, ...relPath.split("/"));
	}

	private invalidateDirectoryIndex(): void {
		this.scanCache().directoryIndexComplete = false;
	}

	/**
	 * Shared same-process serialization plus optimistic read/compare/write for
	 * Obsidian or another MCP process. A transform may be re-run after a foreign
	 * edit, so it must be a pure transformation of content (the WritePort contract
	 * already has that shape). If contention persists, throw instead of claiming a
	 * mutation that did not survive.
	 */
	private async mutateExisting(
		relPath: string,
		abs: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		return FsVault.mutationCoordinator.run(this.mutationKey(abs), async () => {
			for (let attempt = 1; attempt <= this.maxMutationAttempts; attempt++) {
				const before = await this.snapshot(abs);
				if (before === null) return false;
				const next = transform(before.content);
				if (next === null || next === before.content) return false;

				await this.beforeCommit?.({
					relPath,
					attempt,
					expectedContent: before.content,
					nextContent: next,
				});
				const current = await this.snapshot(abs);
				if (current === null || !sameSnapshot(before, current)) continue;

				await this.atomicWrite(abs, next, current.mode);
				const after = await this.snapshot(abs);
				// A foreign writer may have replaced our atomic rename immediately after
				// it. Verify the postcondition before reporting success.
				if (after !== null && after.content === next) {
					await this.rememberFile(abs, after);
					return true;
				}
			}
			throw new McpMutationConflictError(relPath, this.maxMutationAttempts);
		});
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
		return this.mutateExisting(relPath, abs, transform);
	}

	/** false — файла нет; иначе frontmatter мутируется и переписывается атомарно.
	 * InvalidFrontmatterError пробрасывается, не позволяя стереть существующий YAML. */
	async processFrontmatter(
		relPath: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<boolean> {
		const abs = this.abs(relPath);
		let changed: boolean;
		try {
			changed = await this.mutateExisting(relPath, abs, (content) =>
				applyFrontmatter(content, fn),
			);
		} catch (e) {
			if (e instanceof InvalidFrontmatterError) {
				throw new InvalidFrontmatterError(`cannot modify '${relPath}': ${e.message}`);
			}
			throw e;
		}
		// processFrontmatter historically says true for a present file even if fn made
		// no byte change; retain that port contract while conflicts still throw.
		return changed || (await this.snapshot(abs)) !== null;
	}

	/** Создать пустой файл (и родительские папки), если его ещё нет. */
	async ensureFile(relPath: string): Promise<void> {
		const abs = this.abs(relPath);
		await FsVault.mutationCoordinator.run(this.mutationKey(abs), async () => {
			try {
				await fs.access(abs);
				return; // уже есть
			} catch (e) {
				if (!isNotFound(e)) throw e;
			}
			const firstCreatedDirectory = await fs.mkdir(path.dirname(abs), { recursive: true });
			try {
				await fs.writeFile(abs, "", { flag: "wx" }); // wx — не перезаписать гонку create
				const created = await this.snapshot(abs);
				if (created !== null) {
					if (firstCreatedDirectory !== undefined) this.invalidateDirectoryIndex();
					await this.rememberFile(abs, created);
				}
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
		});
	}

	// --- чтение ---

	async readFile(relPath: string): Promise<string | null> {
		const abs = this.abs(relPath);
		try {
			return (await this.snapshot(abs))?.content ?? null;
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
			const snapshot = this.snapshotSync(abs);
			return snapshot === null ? null : readFrontmatter(snapshot.content);
		} catch {
			return null;
		}
	}

	/**
	 * Validate the last complete tree without recursively enumerating it. We still
	 * lstat every known directory (to discover external add/remove/rename) and
	 * every Markdown file (to discover content changes), but unchanged calls make
	 * no readdir and no body reads. Directory lstat rather than only root mtime is
	 * important: a change in a nested folder does not necessarily touch the root.
	 */
	private async directoryIndexIsFresh(cache: VaultScanCache): Promise<boolean> {
		if (!cache.directoryIndexComplete || cache.directories.size === 0) return false;
		const entries = [...cache.directories.entries()];
		const results = await mapWithConcurrency(
			entries,
			SCAN_IO_CONCURRENCY,
			async ([relPath, expected]) => {
				try {
					const absPath = this.absoluteFromCachePath(relPath);
					const stat = await fs.lstat(absPath);
					return (
						stat.isDirectory() &&
						this.inRootRealpath(absPath) !== null &&
						sameStamp(expected, stampOf(stat))
					);
				} catch {
					return false;
				}
			},
		);
		return results.every(Boolean);
	}

	/** Rebuild a complete directory metadata tree and Markdown path list. */
	private async markdownPaths(cache: VaultScanCache): Promise<MarkdownPath[]> {
		const out: MarkdownPath[] = [];
		const directories = new Map<string, FileStamp>();
		let complete = true;
		const walk = async (absDir: string, relDir: string): Promise<void> => {
			let stat: Stats;
			let physicalBefore: string;
			try {
				// lstat keeps a directory swapped for a symlink out of the index. The
				// normal walk below also does not follow symlinked directories.
				stat = await fs.lstat(absDir);
				physicalBefore = this.inRootRealpath(absDir) ?? "";
				if (!stat.isDirectory() || physicalBefore === "") {
					complete = false;
					return;
				}
			} catch {
				complete = false;
				return;
			}
			let entries: Dirent[];
			try {
				await this.beforeDirectoryRead?.(relDir);
				entries = await fs.readdir(absDir, { withFileTypes: true });
			} catch {
				complete = false;
				return;
			}
			try {
				const after = await fs.lstat(absDir);
				const physicalAfter = this.inRootRealpath(absDir);
				if (
					!after.isDirectory() ||
					physicalAfter === null ||
					physicalAfter !== physicalBefore ||
					!sameStamp(stampOf(stat), stampOf(after))
				) {
					complete = false;
					return;
				}
			} catch {
				complete = false;
				return;
			}
			directories.set(relDir, stampOf(stat));
			for (const entry of entries) {
				const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
				if (entry.isDirectory()) {
					if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
					await walk(path.join(absDir, entry.name), relPath);
				} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
					out.push({ relPath, absPath: path.join(absDir, entry.name) });
				}
			}
		};
		await walk(this.root, "");
		if (!complete || !directories.has("")) {
			// A partial tree could be the product of a swap race. Do not serve its
			// paths or retain old paths as a seemingly complete index.
			cache.directories = new Map();
			cache.files.clear();
			cache.directoryIndexComplete = false;
			throw new McpVaultScanError();
		}
		cache.directories = directories;
		cache.directoryIndexComplete = true;
		return out;
	}

	/**
	 * Инкрементальный скан Markdown. Полный recursive readdir выполняется только
	 * после изменения metadata любого известного каталога (либо когда прошлый
	 * обход был неполным). Поэтому внешний add/remove/rename виден на следующем
	 * скане без watcher, а неизменённый vault не перечисляется повторно и не
	 * перечитывает тела. File I/O ограничено восемью одновременными операциями.
	 */
	async scanMarkdownFiles(): Promise<VaultScan> {
		const cache = this.scanCache();
		const paths = (await this.directoryIndexIsFresh(cache))
			? [...cache.files.keys()]
					.map((relPath) => ({ relPath, absPath: this.absoluteFromCachePath(relPath) }))
					.filter(({ relPath }) => relPath.toLowerCase().endsWith(".md"))
			: await this.markdownPaths(cache);
		const seen = new Set<string>();
		let needsDirectoryRefresh = false;
		const rows = await mapWithConcurrency(
			paths,
			SCAN_IO_CONCURRENCY,
			async ({ relPath, absPath }) => {
				seen.add(relPath);
				try {
					// lstat is deliberate: a cached regular note can be replaced by a
					// symlink after indexing. Never follow that link while scanning.
					const stat = await fs.lstat(absPath);
					if (!stat.isFile()) {
						cache.files.delete(relPath);
						needsDirectoryRefresh = true;
						return null;
					}
					const stamp = stampOf(stat);
					const cached = cache.files.get(relPath);
					if (cached !== undefined && sameStamp(cached.stamp, stamp)) {
						// Directory validation already guarded every cached ancestor. Returning
						// known in-memory bytes here needs no per-file realpath syscall; if an
						// ancestor swaps immediately afterwards, no outside bytes are read.
						return { file: { path: relPath, content: cached.content }, stamp };
					}
					if (this.inRootRealpath(absPath) === null) {
						cache.files.delete(relPath);
						needsDirectoryRefresh = true;
						return null;
					}
					const snapshot = await this.snapshot(absPath);
					if (snapshot === null) {
						cache.files.delete(relPath);
						needsDirectoryRefresh = true;
						return null;
					}
					cache.files.set(relPath, snapshot);
					return {
						file: { path: relPath, content: snapshot.content },
						stamp: snapshot.stamp,
					};
				} catch {
					// Нечитаемый/исчезнувший файл не сохраняем из старого кэша: один битый
					// файл не роняет скан, но и не создаёт фантомную задачу.
					cache.files.delete(relPath);
					needsDirectoryRefresh = true;
					return null;
				}
			},
		);
		for (const cachedPath of cache.files.keys()) {
			if (!seen.has(cachedPath)) cache.files.delete(cachedPath);
		}
		if (needsDirectoryRefresh) cache.directoryIndexComplete = false;
		const present = rows.filter(
			(row): row is { file: VaultFile; stamp: FileStamp } => row !== null,
		);
		return {
			files: present.map((row) => row.file),
			revision: scanRevision(
				present.map((row) => ({ path: row.file.path, stamp: row.stamp })),
			),
		};
	}

	/** Совместимый API для старых вызовов: данные берутся из инкрементального скана. */
	async listMarkdownFiles(): Promise<VaultFile[]> {
		return (await this.scanMarkdownFiles()).files;
	}

	private async atomicWrite(abs: string, data: string, mode: number): Promise<void> {
		const tmp = `${abs}.gtdmcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
		try {
			// wx refuses a pre-created temp symlink instead of following it. Explicit
			// chmod after creation bypasses umask and preserves private modes (0600).
			await fs.writeFile(tmp, data, { encoding: "utf8", mode, flag: "wx" });
			await fs.chmod(tmp, mode);
			await fs.rename(tmp, abs); // атомарная замена (MoveFileEx replace на Windows)
		} catch (e) {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw e;
		}
	}
}
