/**
 * GtdSession — единица работы одного вызова инструмента: свежий индекс vault'а
 * плюс связанные над ним сервисы (WritebackService, BoardService, ProjectService).
 *
 * Индекс строится полным сканом на КАЖДЫЙ вызов (см. buildIndex): проще кэша по
 * mtime и всегда согласован с диском после внешних правок пользователя/Obsidian.
 * Сервисы переиспользуются целиком — те же, что в плагине, но с fs-портами вместо
 * адаптеров Obsidian: запись идёт read-modify-write через FsVault, адресация строк
 * по 🆔/content-key/occurrenceIndex — из ядра.
 */
import { BoardService } from "../services/BoardService";
import { ProjectService } from "../services/ProjectService";
import type { IndexFeed } from "../services/types";
import { WritebackService } from "../services/WritebackService";
import type { GtdFlowSettings } from "../settings/Settings";
import type { Task } from "../core/model/Task";
import { buildIndex } from "./buildIndex";
import { FsVault } from "./fsVault";

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
	const files = await vault.listMarkdownFiles();
	const { feed, boardPaths, projectPaths, externalPaths } = await buildIndex(files, today);

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
		await vault.processFrontmatter(path, fn);
	};

	const boards = new BoardService({
		feed,
		readFrontmatter: (path) => vault.readFrontmatterSync(path),
		patchFrontmatter,
		dispatcher: writeback,
		ensureFile: (path) => vault.ensureFile(path),
		containerPaths: () => boardPaths,
		knownTaskId: (key) => writeback.knownTaskId(key),
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
