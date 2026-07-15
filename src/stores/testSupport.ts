/**
 * Тестовая обвязка сторов: фейковый IndexFeed и фабрика полных Task.
 * Только для *.test.ts — в продакшен-коде не импортировать.
 */
import { TaskIndex } from "../core/index/TaskIndex";
import type { IsoDate, Task } from "../core/model/Task";
import type { IndexFeed } from "../services/types";

export class FakeFeed implements IndexFeed {
	private readonly index = new TaskIndex();
	/** Смена дня двигает epoch без правки индекса — отдельный сдвиг. */
	private epochOffset = 0;
	private todayValue: IsoDate;
	private readonly listeners = new Set<() => void>();

	constructor(today: IsoDate = "2026-07-15") {
		this.todayValue = today;
	}

	getIndex(): TaskIndex {
		return this.index;
	}

	getEpoch(): number {
		return this.index.epoch + this.epochOffset;
	}

	today(): IsoDate {
		return this.todayValue;
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	notify(): void {
		for (const cb of this.listeners) cb();
	}

	/** Обычный путь индексатора: правка файла + уведомление. */
	replaceFile(path: string, tasks: readonly Task[]): void {
		this.index.replaceFile(path, tasks);
		this.notify();
	}

	/** Смена дня по контракту IndexFeed: today и epoch двигаются вместе. */
	rollover(newToday: IsoDate): void {
		this.todayValue = newToday;
		this.epochOffset++;
		this.notify();
	}

	/** Смена дня БЕЗ bump epoch — проверяет, что today сам входит в мемо-ключ. */
	rolloverWithoutEpochBump(newToday: IsoDate): void {
		this.todayValue = newToday;
		this.notify();
	}
}

let seq = 0;

export function makeTask(over: Partial<Task> & { filePath: string }): Task {
	const line = over.lineStart ?? seq++;
	const base: Task = {
		key: over.filePath + "#L" + line,
		taskId: null,
		filePath: over.filePath,
		lineStart: line,
		lineEnd: line,
		parentLine: null,
		heading: null,
		description: "задача",
		rawLine: "- [ ] задача",
		statusChar: " ",
		due: null,
		scheduled: null,
		start: null,
		created: null,
		done: null,
		cancelled: null,
		dueTime: null,
		scheduledTime: null,
		startTime: null,
		dueTimeEnd: null,
		scheduledTimeEnd: null,
		startTimeEnd: null,
		recurrence: null,
		nextSpawn: null,
		spawnedFrom: null,
		priority: "none",
		dependsOn: [],
		tags: [],
		container: "plain",
		projectActive: true,
	};
	return { ...base, ...over };
}
