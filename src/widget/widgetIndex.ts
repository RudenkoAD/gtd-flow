/**
 * Построение индекса задач для виджет-бандла из `Record<путь, содержимое>`.
 *
 * Точная калька mcp/buildIndex (тот же IndexerService, тот же scanSnapshotListItems,
 * тот же fileContextFromFrontmatter — значит occurrenceIndex-дизамбигуация, парсинг
 * и раскладка byId/byFile идентичны плагину/серверу), но БЕЗ fs и БЕЗ библиотеки
 * `yaml`: файлы приходят из входа, а ограниченный читатель передаёт скаляры в
 * общую с MCP семантическую проекцию container-frontmatter.
 * Это держит бандл чистым для QuickJS (ни node builtins, ни npm-зависимостей).
 *
 * Скан разовый, синхронный: NOOP-события, фиксированные часы (today из входа),
 * chunkSize = ∞ (никаких уступок макротаске — setTimeout в этом пути не зовётся,
 * что важно для встраиваемого движка без таймеров). Сбой на отдельном файле
 * (не-строка в значении и т.п.) изолируется и уходит в errors, не роняя весь скан.
 */
import { IndexerService } from "../services/IndexerService";
import { fileContextFromContainerFrontmatter } from "../core/frontmatter/containerFrontmatter";
import type { ClockPort, FileSnapshot, IndexFeed, VaultEvents } from "../services/types";
import type { Task } from "../core/model/Task";
import { scanSnapshotListItems } from "../mcp/scanFile";
import { parseWidgetContainerFrontmatter } from "./widgetFrontmatter";

const NOOP_EVENTS: VaultEvents = {
	onChanged: () => () => undefined,
	onDeleted: () => () => undefined,
	onRenamed: () => () => undefined,
};

export interface WidgetIndex {
	feed: IndexFeed;
	/** Материализованный снимок всех задач (re-iterable, в отличие от index.all()). */
	allTasks: Task[];
}

/**
 * Собрать индекс из карты «путь → содержимое». errors пополняется путями файлов,
 * которые не удалось спроецировать в снапшот (битое значение вместо строки и т.п.):
 * такой файл просто выпадает из индекса, остальные индексируются штатно.
 */
export async function buildWidgetIndex(
	files: Record<string, string>,
	today: string,
	errors: string[],
): Promise<WidgetIndex> {
	const snapshots: FileSnapshot[] = [];
	for (const path of Object.keys(files)) {
		// Scope catalog and any other auxiliary files can be supplied alongside
		// Markdown. They are not task containers and must not enter the index.
		if (!path.toLowerCase().endsWith(".md")) continue;
		const content = files[path];
		try {
			if (typeof content !== "string") {
				throw new Error("содержимое файла не строка");
			}
			const frontmatter = parseWidgetContainerFrontmatter(content);
			const context = fileContextFromContainerFrontmatter(path, frontmatter);
			snapshots.push({
				path,
				content,
				listItems: scanSnapshotListItems(content),
				context,
			});
		} catch (e) {
			errors.push(`file '${path}': ${errorMessage(e)}`);
		}
	}

	const clock: ClockPort = { todayIso: () => today, onDayRollover: () => () => undefined };
	const indexer = new IndexerService({
		events: NOOP_EVENTS,
		clock,
		initialScan: async function* () {
			for (const snap of snapshots) yield snap;
		},
		debounceMs: 0,
		chunkSize: Number.MAX_SAFE_INTEGER, // без уступок макротаске: setTimeout не зовётся
	});
	await indexer.start();
	return { feed: indexer, allTasks: [...indexer.getIndex().all()] };
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
