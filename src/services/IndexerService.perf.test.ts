/**
 * Перф-смоук индекса и запросов (ТЗ §12 п.5, этап 9).
 *
 * НЕ бенчмарк: пороги щедрые (анти-регрессионные), чтобы не флапать на
 * загруженном CI-железе. Ловим только грубые деградации сложности
 * (O(n²) в replaceFile, квадратичный resolveDep и т.п.).
 *
 * Синтетика повторяет структуру фейков из IndexerService.test.ts:
 * плоские FileSnapshot без единого объекта Obsidian.
 */
import { describe, expect, it } from "vitest";
import { evaluate, type QueryContext } from "../core/query/QueryEngine";
import { defaultInboxConfig } from "../core/query/querySpec";
import type { FileContext, IsoDate } from "../core/model/Task";
import { IndexerService, type IndexerDeps } from "./IndexerService";
import type { ClockPort, FileSnapshot, SnapshotListItem, VaultEvents } from "./types";

// --- размер синтетического vault и бюджеты (мс) ---

const FILES = 500;
const TASKS_PER_FILE = 20; // 500 × 20 = 10 000 задач
const TOTAL_TASKS = FILES * TASKS_PER_FILE;

const FULL_BUILD_BUDGET_MS = 5000;
const INCREMENTAL_BUDGET_MS = 50;
const INBOX_QUERY_BUDGET_MS = 100;

const TODAY: IsoDate = "2026-07-15";

// --- фейки (клон структуры из IndexerService.test.ts) ---

class FakeEvents implements VaultEvents {
	private changed = new Set<(s: FileSnapshot) => void>();
	private deleted = new Set<(p: string) => void>();
	private renamed = new Set<(o: string, s: FileSnapshot) => void>();

	onChanged(cb: (s: FileSnapshot) => void): () => void {
		this.changed.add(cb);
		return () => {
			this.changed.delete(cb);
		};
	}
	onDeleted(cb: (p: string) => void): () => void {
		this.deleted.add(cb);
		return () => {
			this.deleted.delete(cb);
		};
	}
	onRenamed(cb: (o: string, s: FileSnapshot) => void): () => void {
		this.renamed.add(cb);
		return () => {
			this.renamed.delete(cb);
		};
	}

	emitChanged(s: FileSnapshot): void {
		for (const cb of [...this.changed]) cb(s);
	}
}

class FakeClock implements ClockPort {
	todayIso(): IsoDate {
		return TODAY;
	}
	onDayRollover(): () => void {
		return () => undefined;
	}
}

async function* scanOf(snaps: FileSnapshot[]): AsyncIterable<FileSnapshot> {
	for (const s of snaps) yield s;
}

function makeIndexer(over?: Partial<IndexerDeps>): { events: FakeEvents; indexer: IndexerService } {
	const events = new FakeEvents();
	const indexer = new IndexerService({
		events,
		clock: new FakeClock(),
		initialScan: () => scanOf([]),
		debounceMs: 0,
		...over,
	});
	return { events, indexer };
}

// --- генератор синтетического потока: детерминированный микс задач ---

const pad = (n: number): string => String(n).padStart(2, "0");

/** Дата гарантированно валидная: месяц 1–12, день 1–28. */
function isoDate(seed: number): IsoDate {
	return `2026-${pad((seed % 12) + 1)}-${pad((seed % 28) + 1)}`;
}

/**
 * Строка задачи №i в файле №f. Микс детерминированный, чтобы прогоны были
 * сравнимы: done / doing, due-даты, приоритеты, теги досок, тикль в прошлом
 * и в будущем — задействуем все ветки inbox-предиката §1.
 */
function taskLine(f: number, i: number, ctx: FileContext, variant: number): string {
	const status = i % 7 === 0 ? "x" : i % 11 === 3 ? "/" : " ";
	const parts = [`- [${status}] Задача ${f}-${i}${variant > 0 ? ` v${variant}` : ""}`];
	if (ctx.container === "recurring") {
		// каталог шаблонов: правило + стабильный id (TEMPLATE, в запросы не течёт)
		parts.push(`🔁 every ${(i % 3) + 1} weeks on friday 🆔 tpl-${f}-${i}`);
		return parts.join(" ");
	}
	if (ctx.container === "project") {
		// цепочка ⛔: каждая задача зависит от предыдущей — resolveDep под нагрузкой
		parts.push(`🆔 p${f}x${i}`);
		if (i > 0) parts.push(`⛔ p${f}x${i - 1}`);
		if (status === "x") parts.push(`✅ ${TODAY}`);
		return parts.join(" ");
	}
	if (i % 4 === 1) parts.push(i % 8 === 1 ? "⏫" : "🔽");
	if (i % 5 === 0) parts.push(`📅 ${isoDate(f + i)}`);
	if (i % 6 === 2) parts.push(i % 12 === 2 ? "🛫 2026-09-01" : "🛫 2026-07-01");
	if (i % 3 === 0) parts.push("#kanban/work/todo");
	if (status === "x") parts.push(`✅ ${TODAY}`);
	return parts.join(" ");
}

function fileContext(f: number): FileContext {
	const path = filePath(f);
	if (f % 10 === 0) return { path, container: "project", projectStatus: "active" };
	if (f % 10 === 5 && f % 25 === 0) return { path, container: "recurring" };
	return { path, container: "plain" };
}

function filePath(f: number): string {
	if (f % 10 === 0) return `Projects/proj-${f}.md`;
	if (f % 10 === 5 && f % 25 === 0) return `GTD/recurring-${f}.md`;
	return `Notes/bulk-${f}.md`;
}

/** Снапшот файла №f; variant меняет текст задач (симуляция правки). */
function genFile(f: number, variant = 0): FileSnapshot {
	const context = fileContext(f);
	const lines: string[] = [];
	const listItems: SnapshotListItem[] = [];
	for (let i = 0; i < TASKS_PER_FILE; i++) {
		const line = taskLine(f, i, context, variant);
		listItems.push({
			lineStart: i,
			lineEnd: i,
			taskChar: line.charAt(line.indexOf("[") + 1),
			parentLine: null,
			heading: null,
		});
		lines.push(line);
	}
	return { path: context.path, content: lines.join("\n"), listItems, context };
}

function genVault(): FileSnapshot[] {
	const out: FileSnapshot[] = [];
	for (let f = 0; f < FILES; f++) out.push(genFile(f));
	return out;
}

function countAll(indexer: IndexerService): number {
	let n = 0;
	for (const _ of indexer.getIndex().all()) n++;
	return n;
}

// --- перф-смоук ---

describe(`перф-смоук: ${FILES} файлов × ${TASKS_PER_FILE} задач = ${TOTAL_TASKS}`, () => {
	it(`полная сборка индекса < ${FULL_BUILD_BUDGET_MS}мс`, async () => {
		const snaps = genVault();
		const { indexer } = makeIndexer({ initialScan: () => scanOf(snaps) });

		const t0 = performance.now();
		await indexer.start();
		const elapsed = performance.now() - t0;

		// без смысловой проверки перф-цифра ничего не значит
		expect(countAll(indexer)).toBe(TOTAL_TASKS);
		expect(elapsed).toBeLessThan(FULL_BUILD_BUDGET_MS);
	});

	it(`инкрементальная правка одного файла < ${INCREMENTAL_BUDGET_MS}мс`, async () => {
		const snaps = genVault();
		const { events, indexer } = makeIndexer({ initialScan: () => scanOf(snaps), debounceMs: 0 });
		await indexer.start();

		// правка «тёплого» файла: тот же путь, новый текст всех 20 задач
		const edited = genFile(3, 1);
		const notified = new Promise<void>((resolve) => {
			const off = indexer.onChange(() => {
				off();
				resolve();
			});
		});

		// debounceMs=0 ⇒ измеряем реальный путь emit → setTimeout(0) → парс+replaceFile
		const t0 = performance.now();
		events.emitChanged(edited);
		await notified;
		const elapsed = performance.now() - t0;

		expect(countAll(indexer)).toBe(TOTAL_TASKS); // замена, не дублирование
		const reindexed = indexer.getIndex().fileTasks(edited.path);
		expect(reindexed.some((t) => t.description.includes("v1"))).toBe(true);
		expect(elapsed).toBeLessThan(INCREMENTAL_BUDGET_MS);
	});

	it(`запрос inbox по ${TOTAL_TASKS} задач < ${INBOX_QUERY_BUDGET_MS}мс`, async () => {
		const snaps = genVault();
		const { indexer } = makeIndexer({ initialScan: () => scanOf(snaps) });
		await indexer.start();

		const index = indexer.getIndex();
		const ctx: QueryContext = {
			tasks: index.all(),
			today: TODAY,
			resolveDep: (id) => index.resolveDep(id),
			settingsBits: defaultInboxConfig(),
		};

		const t0 = performance.now();
		const result = evaluate({ kind: "inbox" }, ctx);
		const elapsed = performance.now() - t0;

		// в миксе заведомо есть и входящие, и отсеянные (доски/шаблоны/done/тикль)
		expect(result.length).toBeGreaterThan(0);
		expect(result.length).toBeLessThan(TOTAL_TASKS);
		expect(elapsed).toBeLessThan(INBOX_QUERY_BUDGET_MS);
	});
});
