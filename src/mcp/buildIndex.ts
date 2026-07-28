/**
 * Построение TaskIndex из содержимого файлов vault'а вне Obsidian.
 *
 * Переиспользует IndexerService (чистое ядро индекса) как есть: подаёт ему
 * синтетический initialScan из FileSnapshot'ов, no-op порт событий и фиксированные
 * часы. Тем самым дизамбигуация одинаковых строк (occurrenceIndex), парсинг задач
 * и раскладка по byId/byFile/byDate/byTag идентичны плагину. Эта функция намеренно
 * не знает, как файлы были получены или закэшированы: это ответственность сессии.
 */
import {
	fileContextFromContainerFrontmatter,
	projectContainerFrontmatter,
} from "../core/frontmatter/containerFrontmatter";
import { IndexerService } from "../services/IndexerService";
import type { ClockPort, FileSnapshot, IndexFeed, VaultEvents } from "../services/types";
import { splitFrontmatter } from "./frontmatter";
import type { VaultFile } from "./fsVault";
import { scanSnapshotListItems } from "./scanFile";

const NOOP_EVENTS: VaultEvents = {
	onChanged: () => () => undefined,
	onDeleted: () => () => undefined,
	onRenamed: () => () => undefined,
};

export interface BuiltIndex {
	feed: IndexFeed;
	/** Пути всех файлов-контейнеров gtd-board (для BoardService.containerPaths). */
	boardPaths: string[];
	/** Пути всех файлов-контейнеров gtd-project (для ProjectService.containerPaths). */
	projectPaths: string[];
	/** Пути всех READ-ONLY зеркал внешних календарей (gtd-external). Для read-only-
	 *  защиты write-back в MCP-сессии: те же файлы, что помечены external в плагине
	 *  (fileContextFromFrontmatter), но по пути — доступно и для файлов без задач. */
	externalPaths: Set<string>;
}

export async function buildIndex(files: readonly VaultFile[], today: string): Promise<BuiltIndex> {
	const snapshots: FileSnapshot[] = [];
	const boardPaths: string[] = [];
	const projectPaths: string[] = [];
	const externalPaths = new Set<string>();
	for (const file of files) {
		// MCP remains the authoritative full-YAML reader. Only its parsed mapping
		// crosses into the bounded, shared index-semantic projection.
		const { data } = splitFrontmatter(file.content);
		const context = fileContextFromContainerFrontmatter(
			file.path,
			projectContainerFrontmatter(data),
		);
		if (context.container === "board") boardPaths.push(file.path);
		if (context.container === "project") projectPaths.push(file.path);
		if (context.external === true) externalPaths.add(file.path);
		snapshots.push({
			path: file.path,
			content: file.content,
			listItems: scanSnapshotListItems(file.content),
			context,
		});
	}

	const clock: ClockPort = { todayIso: () => today, onDayRollover: () => () => undefined };
	const indexer = new IndexerService({
		events: NOOP_EVENTS,
		clock,
		initialScan: async function* () {
			for (const snap of snapshots) yield snap;
		},
		debounceMs: 0,
		chunkSize: Number.MAX_SAFE_INTEGER, // без уступок макротаске — не UI, скан разовый
	});
	await indexer.start();
	return { feed: indexer, boardPaths, projectPaths, externalPaths };
}
