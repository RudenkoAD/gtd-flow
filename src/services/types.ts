/**
 * Плоские контракты границы адаптеры (obsidian) ↔ сервисы (чистый TS).
 * Сервисы и сторы зависят только от этих типов — obsidian сюда не протекает.
 */
import type { TaskIndex } from "../core/index/TaskIndex";
import type { FileContext, IsoDate } from "../core/model/Task";

/** Живая лента индекса — единая точка чтения для сторов и видов. */
export interface IndexFeed {
	getIndex(): TaskIndex;
	getEpoch(): number; // монотонный счётчик: правки индекса И смена дня
	today(): IsoDate;
	onChange(cb: () => void): () => void; // подписка; возврат — отписка
}

/** Пункт списка из кэша метаданных, спроецированный на номера строк. */
export interface SnapshotListItem {
	lineStart: number;
	lineEnd: number;
	/** Символ внутри [ ]; null — обычный пункт списка, не задача. */
	taskChar: string | null;
	parentLine: number | null;
	heading: string | null;
}

/** Снимок файла: всё, что нужно индексатору, без единого объекта Obsidian. */
export interface FileSnapshot {
	path: string;
	content: string;
	listItems: SnapshotListItem[];
	context: FileContext;
}

/** События хранилища. Каждая подписка возвращает функцию отписки. */
export interface VaultEvents {
	onChanged(cb: (snap: FileSnapshot) => void): () => void;
	onDeleted(cb: (path: string) => void): () => void;
	onRenamed(cb: (oldPath: string, snap: FileSnapshot) => void): () => void;
}

/** Часы: локальная дата и событие смены дня. Возврат onDayRollover — отписка. */
export interface ClockPort {
	todayIso(): IsoDate;
	onDayRollover(cb: () => void): () => void;
}
