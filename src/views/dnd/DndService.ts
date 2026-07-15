/**
 * DndService (ТЗ §8): свой pointer-слой DnD, по контексту на окно.
 * Никаких DnD-библиотек и голых window/document — у pop-out свой DOM,
 * работаем только через el.win / win.document конкретного окна.
 *
 * Реестр целей — общий на все окна; hit-тест на каждом move фильтрует
 * цели по окну, где идёт drag (кросс-оконный pointer capture невозможен —
 * паритет между окнами обеспечивают меню/команды, слой 3 ТЗ §8).
 */
import type { Plugin } from "obsidian";
import {
	DragStateMachine,
	LONG_PRESS_MS,
	edgeScrollDelta,
	hitTest,
	type HitBox,
} from "./dndCore";
import type { DndPort, DragPayload, DropContext, GtdDropTarget } from "./types";

/** Класс подсветки цели под курсором — в дополнение к hover/unhover цели. */
export const DND_OVER_CLASS = "gtd-dnd-over";
/** Класс клона-призрака (стили-минимум инлайном, класс — для тем/доводки). */
export const DND_GHOST_CLASS = "gtd-dnd-ghost";

/** Живой жест: от pointerdown до drop/cancel. Существует максимум один на окно. */
interface ActiveDrag {
	machine: DragStateMachine;
	payload: DragPayload;
	ghostFrom: HTMLElement;
	/** Появляется при переходе pending → dragging. */
	ghost: HTMLElement | null;
	/** Точка захвата внутри ghostFrom — призрак не прыгает под курсор. */
	grabDx: number;
	grabDy: number;
	lastX: number;
	lastY: number;
	hover: GtdDropTarget | null;
	longPressTimer: number | null;
	prevUserSelect: string;
}

interface WinCtx {
	win: Window;
	drag: ActiveDrag | null;
}

/** Окно элемента: el.win (augmentation Obsidian), fallback — через документ. */
function winOf(el: HTMLElement): Window | null {
	return el.win ?? el.doc?.defaultView ?? el.ownerDocument.defaultView;
}

/**
 * Ближайший прокручиваемый предок (включая сам элемент). instanceof по
 * HTMLElement нельзя — в pop-out чужой realm; Element достаточно:
 * scrollBy/scrollHeight есть на Element.
 */
function findScrollContainer(from: Element | null, win: Window): Element | null {
	for (let node: Element | null = from; node !== null; node = node.parentElement) {
		const cs = win.getComputedStyle(node);
		const canY = /(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight;
		const canX = /(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth;
		if (canY || canX) return node;
	}
	return null;
}

export class DndService implements DndPort {
	/** Порядок регистрации = z-порядок hit-теста (последний — верхний). */
	private readonly targets: GtdDropTarget[] = [];
	private readonly contexts = new Map<Window, WinCtx>();

	constructor(private readonly plugin: Plugin) {
		// Главное окно — сразу; pop-out'ы — по событию. Окна, открытые до
		// загрузки плагина, домонтируются лениво в startDrag.
		this.mount(activeWindow);
		plugin.registerEvent(
			plugin.app.workspace.on("window-open", (_ww, win) => void this.mount(win)),
		);
		plugin.registerEvent(
			plugin.app.workspace.on("window-close", (_ww, win) => this.unmount(win)),
		);
		// Выгрузка плагина посреди жеста: снять ghost/подсветку во всех окнах.
		plugin.register(() => {
			for (const ctx of this.contexts.values()) this.finishDrag(ctx);
			this.contexts.clear();
		});
	}

	// --- DndPort ---

	registerDropTarget(t: GtdDropTarget): () => void {
		this.targets.push(t);
		return () => {
			const i = this.targets.indexOf(t);
			if (i !== -1) this.targets.splice(i, 1);
			// цель ушла из-под живого drag — снять подсветку
			for (const ctx of this.contexts.values()) {
				if (ctx.drag?.hover === t) this.setHover(ctx, null);
			}
		};
	}

	/**
	 * Начать перетаскивание из pointerdown источника.
	 *
	 * Ответственность источника: на элементе-источнике должен стоять
	 * `touch-action: none` (CSS) — иначе на таче браузер заберёт жест под
	 * нативный скролл и pointermove/long-press до слоя не дойдут.
	 *
	 * Мышь/перо: drag начинается после смещения ≥ 5px, клик остаётся кликом.
	 * Тач: long-press 250мс при смещении < 10px; больше — жест уходит скроллу.
	 */
	startDrag(p: DragPayload, evt: PointerEvent, ghostFrom: HTMLElement): void {
		const win = winOf(ghostFrom);
		if (win === null) return;
		const ctx = this.mount(win);
		if (ctx.drag !== null) this.finishDrag(ctx); // потерянный прошлый жест — сброс

		const machine = new DragStateMachine();
		const touch = evt.pointerType === "touch";
		machine.down(evt.clientX, evt.clientY, touch, Date.now());

		const rect = ghostFrom.getBoundingClientRect();
		const drag: ActiveDrag = {
			machine,
			payload: p,
			ghostFrom,
			ghost: null,
			grabDx: evt.clientX - rect.left,
			grabDy: evt.clientY - rect.top,
			lastX: evt.clientX,
			lastY: evt.clientY,
			hover: null,
			longPressTimer: null,
			prevUserSelect: "",
		};
		ctx.drag = drag;

		if (touch) {
			// setTimeout не срабатывает раньше срока ⇒ проверка ≥250мс в автомате пройдёт
			drag.longPressTimer = win.setTimeout(() => {
				drag.longPressTimer = null;
				if (ctx.drag !== drag) return;
				if (drag.machine.longPress(Date.now()) === "activated") this.beginDragging(ctx);
			}, LONG_PRESS_MS);
		}
	}

	// --- монтирование окон ---

	/** Идемпотентно: повторный mount того же Window возвращает существующий контекст. */
	private mount(win: Window): WinCtx {
		const existing = this.contexts.get(win);
		if (existing !== undefined) return existing;
		const ctx: WinCtx = { win, drag: null };
		this.contexts.set(win, ctx);
		// registerDomEvent: снятие на unload плагина; при закрытии окна
		// листенеры умирают вместе с его document.
		const doc = win.document;
		this.plugin.registerDomEvent(doc, "pointermove", (e) => this.onPointerMove(ctx, e));
		this.plugin.registerDomEvent(doc, "pointerup", (e) => this.onPointerUp(ctx, e));
		this.plugin.registerDomEvent(doc, "pointercancel", () => this.onCancel(ctx));
		this.plugin.registerDomEvent(doc, "keydown", (e) => this.onKeyDown(ctx, e));
		return ctx;
	}

	private unmount(win: Window): void {
		const ctx = this.contexts.get(win);
		if (ctx === undefined) return;
		this.finishDrag(ctx);
		this.contexts.delete(win);
	}

	// --- обработчики (по окну) ---

	private onPointerMove(ctx: WinCtx, e: PointerEvent): void {
		const drag = ctx.drag;
		if (drag === null) return;
		drag.lastX = e.clientX;
		drag.lastY = e.clientY;
		const sig = drag.machine.move(e.clientX, e.clientY, Date.now());
		if (sig === "cancelled") {
			this.finishDrag(ctx); // тач ушёл в скролл до long-press
			return;
		}
		if (sig === "activated") this.beginDragging(ctx);
		if (drag.machine.phase !== "dragging") return;

		e.preventDefault();
		this.positionGhost(drag, e.clientX, e.clientY);
		const target = this.hitTarget(ctx, drag.payload, e.clientX, e.clientY);
		this.setHover(ctx, target);
		this.autoscroll(ctx, target, e.clientX, e.clientY);
	}

	private onPointerUp(ctx: WinCtx, e: PointerEvent): void {
		const drag = ctx.drag;
		if (drag === null) return;
		if (drag.machine.up() !== "dropped") {
			this.finishDrag(ctx); // pending: обычный клик/тап
			return;
		}
		const target = this.hitTarget(ctx, drag.payload, e.clientX, e.clientY);
		const payload = drag.payload;
		const dropCtx: DropContext = { clientX: e.clientX, clientY: e.clientY };
		// ghost/подсветку снимаем ДО drop: даже упавший/зависший drop не оставит призрака
		this.finishDrag(ctx);
		if (target === null) return;
		try {
			void Promise.resolve(target.drop(payload, dropCtx)).catch((err) => {
				console.error("GTD Flow DnD: drop отклонён", err);
			});
		} catch (err) {
			console.error("GTD Flow DnD: drop упал", err);
		}
	}

	private onCancel(ctx: WinCtx): void {
		if (ctx.drag === null) return;
		ctx.drag.machine.cancel();
		this.finishDrag(ctx);
	}

	private onKeyDown(ctx: WinCtx, e: KeyboardEvent): void {
		if (e.key !== "Escape" || ctx.drag === null) return;
		// Escape гасим только когда реально тянем — не мешаем модалам и т.п.
		if (ctx.drag.machine.phase === "dragging") e.preventDefault();
		this.onCancel(ctx);
	}

	// --- механика жеста ---

	/** pending → dragging: клон-призрак + запрет выделения текста в окне. */
	private beginDragging(ctx: WinCtx): void {
		const drag = ctx.drag;
		if (drag === null || drag.ghost !== null) return;
		const doc = ctx.win.document;
		const src = drag.ghostFrom;
		const ghost = src.cloneNode(true) as HTMLElement;
		ghost.classList.add(DND_GHOST_CLASS);
		ghost.setAttribute("aria-hidden", "true");
		const r = src.getBoundingClientRect();
		// fixed + transform: позиционирование без reflow; pointer-events:none,
		// чтобы призрак не заслонял elementFromPoint и hit-тест
		ghost.style.position = "fixed";
		ghost.style.left = "0";
		ghost.style.top = "0";
		ghost.style.width = `${r.width}px`;
		ghost.style.margin = "0";
		ghost.style.opacity = "0.7";
		ghost.style.pointerEvents = "none";
		ghost.style.zIndex = "9999";
		ghost.style.boxSizing = "border-box";
		doc.body.appendChild(ghost);
		drag.ghost = ghost;
		drag.prevUserSelect = doc.body.style.userSelect;
		doc.body.style.userSelect = "none";
		this.positionGhost(drag, drag.lastX, drag.lastY);
	}

	private positionGhost(drag: ActiveDrag, x: number, y: number): void {
		if (drag.ghost === null) return;
		drag.ghost.style.transform = `translate(${x - drag.grabDx}px, ${y - drag.grabDy}px)`;
	}

	/** Верхняя принимающая цель под точкой — только среди целей окна drag'а. */
	private hitTarget(ctx: WinCtx, payload: DragPayload, x: number, y: number): GtdDropTarget | null {
		const boxes: HitBox<GtdDropTarget>[] = [];
		for (const t of this.targets) {
			if (!t.el.isConnected || winOf(t.el) !== ctx.win) continue;
			let ok = false;
			try {
				ok = t.accepts(payload);
			} catch {
				// цель с падающим accepts не должна ронять весь move-цикл
			}
			if (!ok) continue;
			const r = t.el.getBoundingClientRect();
			boxes.push({ id: t, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
		}
		return hitTest(boxes, x, y);
	}

	private setHover(ctx: WinCtx, target: GtdDropTarget | null): void {
		const drag = ctx.drag;
		if (drag === null || drag.hover === target) return;
		if (drag.hover !== null) {
			drag.hover.el.classList.remove(DND_OVER_CLASS);
			try {
				drag.hover.unhover?.();
			} catch {
				/* не рвём жест из-за подсветки */
			}
		}
		drag.hover = target;
		if (target !== null) {
			target.el.classList.add(DND_OVER_CLASS);
			try {
				target.hover?.(drag.payload);
			} catch {
				/* см. выше */
			}
		}
	}

	/** Простая версия ТЗ §8: scrollBy у прокручиваемого предка при курсоре в 40px от края. */
	private autoscroll(ctx: WinCtx, target: GtdDropTarget | null, x: number, y: number): void {
		const anchor = target?.el ?? ctx.win.document.elementFromPoint(x, y);
		const scroller = findScrollContainer(anchor, ctx.win);
		if (scroller === null) return;
		const r = scroller.getBoundingClientRect();
		const { dx, dy } = edgeScrollDelta(
			{ left: r.left, top: r.top, right: r.right, bottom: r.bottom },
			x,
			y,
		);
		if (dx !== 0 || dy !== 0) scroller.scrollBy(dx, dy);
	}

	/** Полная уборка жеста: таймер, подсветка, ghost, user-select. Идемпотентно. */
	private finishDrag(ctx: WinCtx): void {
		const drag = ctx.drag;
		if (drag === null) return;
		ctx.drag = null;
		if (drag.longPressTimer !== null) ctx.win.clearTimeout(drag.longPressTimer);
		if (drag.hover !== null) {
			drag.hover.el.classList.remove(DND_OVER_CLASS);
			try {
				drag.hover.unhover?.();
			} catch {
				/* уборка не должна бросать */
			}
		}
		if (drag.ghost !== null) {
			drag.ghost.remove();
			ctx.win.document.body.style.userSelect = drag.prevUserSelect;
		}
		drag.machine.cancel();
	}
}
