/**
 * Построение TaskIndex из содержимого файлов vault'а вне Obsidian.
 *
 * Переиспользует IndexerService (чистое ядро индекса) как есть: подаёт ему
 * синтетический initialScan из FileSnapshot'ов, no-op порт событий и фиксированные
 * часы. Тем самым дизамбигуация одинаковых строк (occurrenceIndex), парсинг задач
 * и раскладка по byId/byFile/byDate/byTag идентичны плагину. Полный скан на каждый
 * запрос инструмента (без кэша по mtime) — по ТЗ для vault'ов до ~10к файлов
 * достаточно и всегда согласован с диском после внешних правок.
 */
import { fileContextFromFrontmatter } from "../services/snapshotHelpers";
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
}

export async function buildIndex(files: readonly VaultFile[], today: string): Promise<BuiltIndex> {
	const snapshots: FileSnapshot[] = [];
	const boardPaths: string[] = [];
	const projectPaths: string[] = [];
	for (const file of files) {
		const { data } = splitFrontmatter(file.content);
		const context = fileContextFromFrontmatter(file.path, data);
		if (context.container === "board") boardPaths.push(file.path);
		if (context.container === "project") projectPaths.push(file.path);
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
		// eslint-disable-next-line @typescript-eslint/require-await
		initialScan: async function* () {
			for (const snap of snapshots) yield snap;
		},
		debounceMs: 0,
		chunkSize: Number.MAX_SAFE_INTEGER, // без уступок макротаске — не UI, скан разовый
	});
	await indexer.start();
	return { feed: indexer, boardPaths, projectPaths };
}
