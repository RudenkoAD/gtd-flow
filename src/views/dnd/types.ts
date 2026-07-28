/**
 * Контракт кросс-видового DnD (ТЗ §8). Общий для DndService (реализация)
 * и всех видов (источники drag + drop-цели). Виды друг о друге не знают:
 * связь только через реестр целей DndPort.
 */

export interface DragPayload {
	taskKey: string;
	sourceViewType: string;
	/** Вертикальное смещение точки захвата от ВЕРХА перетаскиваемого блока.
	 *  Ставится только блоками time-grid календаря: их время = позиция верха,
	 *  и drop-цель восстанавливает верх (clientY − grabOffsetY), чтобы чисто
	 *  горизонтальный drag не сдвигал время на величину хвата. Источники без
	 *  поля (kanban, входящие, чипы месяца) целятся точкой курсора. */
	grabOffsetY?: number;
	/** Перенос ОТДЕЛЬНОГО вхождения события (§события, раунд 6). Присутствует
	 *  только у drag'а блока EventOccurrenceChip: drop-цель тайм-сетки роутит его
	 *  в перенос вхождения (а не в set-date задачи). Несёт исходную дату вхождения
	 *  и его время/конец — для сохранения длительности при переносе. */
	occurrence?: OccurrenceDrag;
}

export interface OccurrenceDrag {
	kind: "series" | "single";
	/** Исходная дата вхождения (у серии — гасится через 🚫). */
	date: string;
	/** "HH:mm" начала вхождения или null. */
	time: string | null;
	/** "HH:mm" конца интервала вхождения или null. */
	timeEnd: string | null;
}
export interface DropContext {
	clientX: number;
	clientY: number;
}
export interface GtdDropTarget {
	el: HTMLElement;
	accepts(p: DragPayload): boolean;
	hover?(p: DragPayload): void;
	unhover?(): void;
	drop(p: DragPayload, ctx: DropContext): Promise<void> | void;
}
export interface DndPort {
	registerDropTarget(t: GtdDropTarget): () => void;
	/** Начать перетаскивание. ghostFrom — элемент для клона-призрака. */
	startDrag(p: DragPayload, evt: PointerEvent, ghostFrom: HTMLElement): void;
}
