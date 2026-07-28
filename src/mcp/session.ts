/**
 * GtdSession — единица работы одного вызова инструмента: актуальный индекс vault'а
 * плюс связанные над ним сервисы (WritebackService, BoardService, ProjectService).
 *
 * FsVault делает metadata-скан каждого вызова, но повторно читает лишь изменившиеся
 * файлы. Этот модуль поверх него переиспользует уже построенный TaskIndex, пока
 * revision скана тот же. Поэтому серия MCP reads не парсит весь vault заново, а
 * внешние правки всё ещё обнаруживаются до следующего инструмента.
 */
import { BoardService, secureBoardIdSuffix } from "../services/BoardService";
import { ProjectService } from "../services/ProjectService";
import type { IndexFeed } from "../services/types";
import { WritebackService } from "../services/WritebackService";
import type { GtdFlowSettings } from "../settings/Settings";
import type { Task } from "../core/model/Task";
import { buildIndex, type BuiltIndex } from "./buildIndex";
import type { FsVault } from "./fsVault";

interface CachedIndex {
	revision: string;
	today: string;
	built: BuiltIndex;
}

/** Маленький LRU: MCP обычно обслуживает один vault, но не держим все vault'ы
 * процесса навечно (важно для интеграционных тестов и переиспользуемых hosts). */
const indexCache = new Map<string, CachedIndex>();
const MAX_INDEX_CACHES = 16;

function rememberIndex(key: string, value: CachedIndex): void {
	indexCache.delete(key);
	indexCache.set(key, value);
	while (indexCache.size > MAX_INDEX_CACHES) {
		const oldest = indexCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		indexCache.delete(oldest);
	}
}

export interface GtdSession {
	feed: IndexFeed;
	settings: GtdFlowSettings;
	vault: FsVault;
	writeback: WritebackService;
	boards: BoardService;
	projects: ProjectService;
	today: string;
	/** Материализованный снимок всех задач индекса — re-iterable (в отличие от
	 *  index.all(), чей итератор одноразовый). Для многократных evaluate/фильтров. */
	allTasks: Task[];
	boardPaths: string[];
	projectPaths: string[];
}

export interface SessionDeps {
	vault: FsVault;
	settings: GtdFlowSettings;
	/** Сегодняшняя дата ISO (инъекция для тестов; в проде — локальная дата). */
	today: string;
	/** Детерминированный генератор 🆔 для тестов (иначе base36 из WritebackService). */
	genId?: () => string;
}

export async function openSession(deps: SessionDeps): Promise<GtdSession> {
	const { vault, settings, today } = deps;
	const scan = await vault.scanMarkdownFiles();
	const cacheKey = vault.cacheIdentity;
	const cached = indexCache.get(cacheKey);
	const built =
		cached !== undefined && cached.revision === scan.revision && cached.today === today
			? cached.built
			: await buildIndex(scan.files, today);
	if (cached === undefined || cached.revision !== scan.revision || cached.today !== today) {
		rememberIndex(cacheKey, { revision: scan.revision, today, built });
	} else {
		// Refresh LRU order even on a cache hit.
		rememberIndex(cacheKey, cached);
	}
	const { feed, boardPaths, projectPaths, externalPaths } = built;

	const writeback = new WritebackService({
		write: vault,
		feed,
		autoInjectId: settings.autoInjectId,
		genId: deps.genId,
		// зеркала внешних календарей (gtd-external) — READ-ONLY, как в плагине: их
		// перезаписывает синхронизация, ручная/агентская правка затёрлась бы. Набор
		// путей взят из того же скана, что построил индекс (externalPaths) — согласован
		// по построению и покрывает даже пустые зеркала без задач.
		readOnlyFile: (path) => externalPaths.has(path),
	});

	const patchFrontmatter = async (
		path: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<void> => {
		const changed = await vault.processFrontmatter(path, fn);
		if (!changed) throw new Error(`board-frontmatter-write-failed:${path}`);
	};

	const boards = new BoardService({
		feed,
		readFrontmatter: (path) => vault.readFrontmatterSync(path),
		patchFrontmatter,
		dispatcher: writeback,
		ensureFile: (path) => vault.ensureFile(path),
		containerPaths: () => boardPaths,
		knownTaskId: (key) => writeback.knownTaskId(key),
		genBoardIdSuffix: secureBoardIdSuffix,
		// namespaceFilter не инжектируем: discovery всегда с ЯВНЫМ фильтром из инструмента.
	});

	const projects = new ProjectService({
		feed,
		write: vault,
		readFrontmatter: (path) => vault.readFrontmatterSync(path),
		patchFrontmatter,
		ensureFile: (path) => vault.ensureFile(path),
		containerPaths: () => projectPaths,
		dispatcher: writeback,
		todayIso: () => today,
		genId: deps.genId,
	});

	return {
		feed,
		settings,
		vault,
		writeback,
		boards,
		projects,
		today,
		allTasks: [...feed.getIndex().all()],
		boardPaths,
		projectPaths,
	};
}
