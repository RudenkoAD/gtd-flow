/**
 * Контракт кросс-видового DnD (ТЗ §8). Общий для DndService (реализация)
 * и всех видов (источники drag + drop-цели). Виды друг о друге не знают:
 * связь только через реестр целей DndPort.
 */

export interface DragPayload { taskKey: string; sourceViewType: string }
export interface DropContext { clientX: number; clientY: number }
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
