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

/** Обратная карта одного frontmatter-ключа: String(value) → пути носителей.
 *  byPath хранит текущий вклад файла, чтобы снять его при изменении/удалении. */
interface FmKeyIndex {
	byValue: Map<string, Set<string>>;
	byPath: Map<string, string>;
}

export class MetadataAdapter implements VaultEvents {
	/** Ленивая обратная карта frontmatter (ключ → индекс); null — ещё не
	 *  строилась, и события её поддержки не подключены. */
	private fmIndexes: Map<string, FmKeyIndex> | null = null;
	/** Событие 'resolved' кэша метаданных уже приходило в этой сессии. */
	private resolvedSeen = false;

	constructor(private readonly plugin: Plugin) {}

	private get app() {
		return this.plugin.app;
	}

	/** Кэш метаданных полностью resolved хотя бы раз в этой сессии.
	 *  Недокументированный флаг `initialized` покрывает включение плагина
	 *  посреди сессии — 'resolved' тогда не придёт до следующей правки файла. */
	isResolved(): boolean {
		if (this.resolvedSeen) return true;
		return (this.app.metadataCache as unknown as { initialized?: boolean }).initialized === true;
	}

	/** Однократный колбэк по полному resolve кэша метаданных (ТЗ §2:
	 *  первичная сборка — после onLayoutReady + resolved). Если кэш уже
	 *  готов — колбэк зовётся синхронно. */
	onResolved(cb: () => void): () => void {
		if (this.isResolved()) {
			cb();
			return () => undefined;
		}
		const ref = this.app.metadataCache.on("resolved", () => {
			this.resolvedSeen = true;
			this.app.metadataCache.offref(ref);
			cb();
		});
		this.plugin.registerEvent(ref);
		return () => this.app.metadataCache.offref(ref);
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
			// свежий снапшот: переезд мог сменить fileContext (папка/frontmatter).
			// Пустой снапшот нового пути: handleRenamed вычистит старый путь,
			// не воскрешая задачи файла, который успели удалить, пока читали.
			const gone = (): FileSnapshot => ({
				path: file.path,
				content: "",
				listItems: [],
				context: fileContextFromFrontmatter(file.path, undefined),
			});
			void this.snapshotFile(file).then(
				// delete мог прилететь раньше, чем cachedRead завершился
				(snap) => cb(oldPath, this.app.vault.getFileByPath(file.path) !== null ? snap : gone()),
				() => cb(oldPath, gone()),
			);
		});
		this.plugin.registerEvent(ref);
		return () => this.app.vault.offref(ref);
	}

	/** Первичный обход всех markdown-файлов; потребляется IndexerService чанками.
	 *  Нечитаемый файл (удалён/залочен sync-клиентом между getMarkdownFiles()
	 *  и чтением) пропускается — один сбой не должен обрывать сборку индекса. */
	async *initialScan(): AsyncIterable<FileSnapshot> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			let snap: FileSnapshot;
			try {
				snap = await this.snapshotFile(file);
			} catch (e) {
				console.error(`GTD Flow: первичный скан пропустил нечитаемый ${file.path}`, e);
				continue;
			}
			yield snap;
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

	/**
	 * Первый markdown-файл, чей frontmatter[key] совпадает со value; null — нет.
	 * При нескольких носителях — лексикографически наименьший путь (детерминизм:
	 * два вызова/устройства сходятся к одному файлу без координации).
	 * YAML читает голые скаляры типизированно (`gtd-card-of: 123` → число),
	 * поэтому карта ключуется через String(v) — id "123" находит и число, и строку.
	 *
	 * Стоимость: полный обход хранилища только при ПЕРВОМ запросе ключа
	 * (карточки рендерятся на каждый bump эпохи — O(карточек × файлов) здесь
	 * недопустимо, ТЗ §13 этап 9). Дальше обратная карта поддерживается
	 * инкрементально по событиям metadataCache/vault, см. ensureFmTracking.
	 */
	findByFrontmatterValue(key: string, value: unknown): string | null {
		const indexes = this.ensureFmTracking();
		let idx = indexes.get(key);
		if (idx === undefined) {
			idx = this.buildFmIndex(key);
			indexes.set(key, idx);
		}
		const paths = idx.byValue.get(String(value));
		if (paths === undefined) return null;
		let best: string | null = null;
		for (const p of paths) if (best === null || p < best) best = p;
		return best;
	}

	/** Подключает поддержание обратных карт к событиям (однократно).
	 *  Инвалидация: metadataCache 'changed' приходит на каждое изменение кэша
	 *  файла, vault delete/rename — на удаление/переезд, поэтому карты не
	 *  отстают от getFileCache; события живут до выгрузки плагина
	 *  (registerEvent), сама карта — вместе с адаптером. */
	private ensureFmTracking(): Map<string, FmKeyIndex> {
		if (this.fmIndexes !== null) return this.fmIndexes;
		const indexes = new Map<string, FmKeyIndex>();
		this.fmIndexes = indexes;
		this.plugin.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				if (!isMarkdownFile(file)) return;
				for (const [key, idx] of indexes) {
					fmRemove(idx, file.path);
					fmAdd(idx, key, file.path, cache.frontmatter);
				}
			}),
		);
		this.plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!isMarkdownFile(file)) return;
				for (const idx of indexes.values()) fmRemove(idx, file.path);
			}),
		);
		this.plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!isMarkdownFile(file)) return;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				for (const [key, idx] of indexes) {
					fmRemove(idx, oldPath);
					fmAdd(idx, key, file.path, fm);
				}
			}),
		);
		return indexes;
	}

	private buildFmIndex(key: string): FmKeyIndex {
		const idx: FmKeyIndex = { byValue: new Map(), byPath: new Map() };
		for (const file of this.app.vault.getMarkdownFiles()) {
			fmAdd(idx, key, file.path, this.app.metadataCache.getFileCache(file)?.frontmatter);
		}
		return idx;
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

/** Вклад файла в обратную карту: пропускаем отсутствующие/null значения —
 *  ровно как исходный линейный поиск. */
function fmAdd(
	idx: FmKeyIndex,
	key: string,
	path: string,
	fm: Record<string, unknown> | null | undefined,
): void {
	const v: unknown = fm?.[key];
	if (v === undefined || v === null) return;
	const vs = String(v);
	idx.byPath.set(path, vs);
	let set = idx.byValue.get(vs);
	if (set === undefined) {
		set = new Set();
		idx.byValue.set(vs, set);
	}
	set.add(path);
}

function fmRemove(idx: FmKeyIndex, path: string): void {
	const vs = idx.byPath.get(path);
	if (vs === undefined) return;
	idx.byPath.delete(path);
	const set = idx.byValue.get(vs);
	if (set === undefined) return;
	set.delete(path);
	if (set.size === 0) idx.byValue.delete(vs);
}
