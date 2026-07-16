/**
 * IndexerService — оркестратор индекса (ТЗ §2): принимает плоские снапшоты
 * от адаптеров, парсит задачи, владеет TaskIndex и раздаёт его через IndexFeed.
 * Ноль импортов obsidian — целиком тестируется на синтетических событиях.
 */
import { TaskIndex } from "../core/index/TaskIndex";
import type { IsoDate, Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { computeKey } from "../core/parser/taskKey";
import type { ClockPort, FileSnapshot, IndexFeed, VaultEvents } from "./types";

export interface IndexerDeps {
	events: VaultEvents;
	clock: ClockPort;
	initialScan: () => AsyncIterable<FileSnapshot>;
	/** Дребезг переиндексации файла (settings.debounceMs.fileReindex). */
	debounceMs: number;
	/** Файлов между уступками макротаске при первичном скане. */
	chunkSize?: number;
	onReady?: () => void;
}

const DEFAULT_CHUNK_SIZE = 50;

export class IndexerService implements IndexFeed {
	private readonly index = new TaskIndex();
	/** Эпохи событий вне индекса (смена дня) — суммируются с index.epoch. */
	private rolloverEpoch = 0;
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribers: Array<() => void> = [];
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly pendingSnaps = new Map<string, FileSnapshot>();
	private disposed = false;
	private started = false;

	constructor(private readonly deps: IndexerDeps) {
		this.unsubscribers.push(
			deps.events.onChanged((snap) => this.scheduleReindex(snap)),
			deps.events.onDeleted((path) => this.handleDeleted(path)),
			deps.events.onRenamed((oldPath, snap) => this.handleRenamed(oldPath, snap)),
			deps.clock.onDayRollover(() => {
				this.rolloverEpoch++;
				this.notify();
			}),
		);
	}

	// --- IndexFeed ---

	getIndex(): TaskIndex {
		return this.index;
	}

	getEpoch(): number {
		return this.index.epoch + this.rolloverEpoch;
	}

	today(): IsoDate {
		return this.deps.clock.todayIso();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	// --- жизненный цикл ---

	/** Первичное наполнение: чанками, между чанками уступаем макротаске,
	 *  чтобы не замораживать UI на большом хранилище. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const chunkSize = this.deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
		let filled = 0;
		try {
			for await (const snap of this.deps.initialScan()) {
				if (this.disposed) return;
				this.index.replaceFile(snap.path, this.parseSnapshot(snap));
				if (++filled % chunkSize === 0) {
					this.notify();
					await yieldToMacrotask();
					if (this.disposed) return;
				}
			}
		} catch (e) {
			// изоляция: сбой скана не должен молча оставлять индекс «вечно не
			// готовым» (onReady — единственный открыватель гейта регулярных);
			// работаем с тем, что успели собрать, недостающее доедет по 'changed'
			console.error("GTD Flow: первичный скан прерван, индекс может быть неполным", e);
		}
		if (this.disposed) return;
		this.notify();
		this.deps.onReady?.();
	}

	dispose(): void {
		this.disposed = true;
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers.length = 0;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pendingSnaps.clear();
		this.listeners.clear();
	}

	// --- обработчики событий ---

	private scheduleReindex(snap: FileSnapshot): void {
		if (this.disposed) return;
		this.pendingSnaps.set(snap.path, snap);
		const prev = this.timers.get(snap.path);
		if (prev !== undefined) clearTimeout(prev);
		this.timers.set(
			snap.path,
			setTimeout(() => {
				this.timers.delete(snap.path);
				const pending = this.pendingSnaps.get(snap.path);
				this.pendingSnaps.delete(snap.path);
				if (pending !== undefined) this.indexSnapshot(pending);
			}, this.deps.debounceMs),
		);
	}

	private handleDeleted(path: string): void {
		if (this.disposed) return;
		// отложенная переиндексация воскресила бы удалённый файл
		this.cancelPending(path);
		this.index.removeFile(path);
		this.notify();
	}

	private handleRenamed(oldPath: string, snap: FileSnapshot): void {
		if (this.disposed) return;
		this.cancelPending(oldPath);
		// renameFile сохраняет ключи; свежий снапшот сразу доносит новый
		// fileContext (переезд мог сменить папку/frontmatter)
		this.index.renameFile(oldPath, snap.path);
		this.indexSnapshot(snap);
	}

	private cancelPending(path: string): void {
		const timer = this.timers.get(path);
		if (timer !== undefined) clearTimeout(timer);
		this.timers.delete(path);
		this.pendingSnaps.delete(path);
	}

	// --- индексация ---

	private indexSnapshot(snap: FileSnapshot): void {
		this.index.replaceFile(snap.path, this.parseSnapshot(snap));
		this.notify();
	}

	private parseSnapshot(snap: FileSnapshot): Task[] {
		const lines = snap.content.split("\n");
		const projectActive =
			snap.context.container !== "project" ||
			(snap.context.projectStatus ?? "active") === "active";
		const parsed: Task[] = [];
		for (const item of snap.listItems) {
			if (item.taskChar === null) continue;
			const rawLine = lines[item.lineStart];
			if (rawLine === undefined) continue; // кэш метаданных отстал от контента
			const task = parseTaskLine(rawLine, {
				filePath: snap.path,
				lineStart: item.lineStart,
				parentLine: item.parentLine,
				heading: item.heading,
				container: snap.context.container,
				projectActive,
				// перебивка пространства (frontmatter gtd-namespace) — без прокидки
				// override не доехал бы до Task и фича была бы мертва (ревью)
				nsOverride: snap.context.nsOverride ?? null,
			});
			if (task === null) continue;
			parsed.push(task.lineEnd === item.lineEnd ? task : { ...task, lineEnd: item.lineEnd });
		}
		return assignOccurrenceIndexes(parsed);
	}

	private notify(): void {
		// копия: подписчик вправе отписаться прямо из колбэка
		for (const cb of [...this.listeners]) cb();
	}
}

/** Дизамбигуация одинаковых строк без 🆔: n-е вхождение content-ключа
 *  в порядке файла получает occurrenceIndex = n. Порядок обхода = порядок
 *  listItems в снапшоте = порядок строк файла, поэтому ключи стабильны. */
function assignOccurrenceIndexes(tasks: Task[]): Task[] {
	const seen = new Map<string, number>();
	return tasks.map((t) => {
		if (t.taskId !== null) return t; // 'id:…' от позиции не зависит
		const base = t.key; // parseTaskLine всегда выдаёт computeKey(t, 0)
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return n === 0 ? t : { ...t, key: computeKey(t, n) };
	});
}

function yieldToMacrotask(): Promise<void> {
	// именно setTimeout 0, не requestIdleCallback: должно работать в node-тестах
	return new Promise((resolve) => setTimeout(resolve, 0));
}
