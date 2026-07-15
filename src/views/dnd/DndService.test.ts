/**
 * Регрессионные тесты DndService на утиных DOM-стабах (node-окружение):
 *  - автоскролл якорится на элемент под курсором, оси раздаются по способностям;
 *  - листенеры pop-out снимаются на window-close (утечка Document);
 *  - post-drag click глотается одноразовой capture-ловушкой;
 *  - touchmove-guard гасит pan только в фазе dragging (touch-action: pan-y).
 * Сервису от DOM нужно немного — стабы покрывают ровно используемое API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";
import { DndService } from "./DndService";
import type { DragPayload } from "./types";

interface FakeRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface FakeElOpts {
	rect?: FakeRect;
	overflowX?: string;
	overflowY?: string;
	scrollWidth?: number;
	clientWidth?: number;
	scrollHeight?: number;
	clientHeight?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeEl(win: any, opts: FakeElOpts = {}): any {
	const el: any = {
		win,
		ownerDocument: win?.document ?? null,
		parentElement: null,
		isConnected: true,
		style: {} as Record<string, string>,
		classList: { add: vi.fn(), remove: vi.fn() },
		overflowX: opts.overflowX ?? "visible",
		overflowY: opts.overflowY ?? "visible",
		scrollWidth: opts.scrollWidth ?? 0,
		clientWidth: opts.clientWidth ?? 0,
		scrollHeight: opts.scrollHeight ?? 0,
		clientHeight: opts.clientHeight ?? 0,
		rect: opts.rect ?? { left: 0, top: 0, right: 100, bottom: 100 },
		getBoundingClientRect(): any {
			const r = el.rect as FakeRect;
			return { ...r, width: r.right - r.left, height: r.bottom - r.top };
		},
		scrollBy: vi.fn(),
		setAttribute: vi.fn(),
		remove: vi.fn(),
		cloneNode: (): any => makeEl(win, opts),
	};
	return el;
}

interface Listener {
	fn: (e: any) => void;
	opts: any;
}

function makeDoc(win: any): any {
	const doc: any = {
		defaultView: win,
		/** Все когда-либо повешенные/снятые листенеры — для ассертов утечки. */
		added: [] as Array<{ type: string; fn: (e: any) => void; opts: any }>,
		removed: [] as Array<{ type: string; fn: (e: any) => void }>,
		listeners: new Map<string, Listener[]>(),
		addEventListener(type: string, fn: (e: any) => void, opts?: any): void {
			doc.added.push({ type, fn, opts });
			const arr: Listener[] = doc.listeners.get(type) ?? [];
			arr.push({ fn, opts });
			doc.listeners.set(type, arr);
		},
		removeEventListener(type: string, fn: (e: any) => void, _opts?: any): void {
			doc.removed.push({ type, fn });
			const arr: Listener[] = doc.listeners.get(type) ?? [];
			const i = arr.findIndex((l) => l.fn === fn);
			if (i !== -1) arr.splice(i, 1);
		},
		/** Синхронная доставка события с поддержкой { once } — как в браузере. */
		dispatch(type: string, ev: any): void {
			for (const l of [...(doc.listeners.get(type) ?? [])]) {
				if (l.opts !== undefined && l.opts !== null && l.opts.once === true) {
					doc.removeEventListener(type, l.fn, l.opts);
				}
				l.fn(ev);
			}
		},
		elementFromPoint: (): any => null,
		body: { appendChild: vi.fn(), style: {} as Record<string, string> },
	};
	return doc;
}

function makeWin(): any {
	const win: any = {
		timeouts: [] as Array<{ id: number; fn: () => void }>,
		nextId: 1,
		setTimeout(fn: () => void, _ms?: number): number {
			const id = win.nextId as number;
			win.nextId = id + 1;
			win.timeouts.push({ id, fn });
			return id;
		},
		clearTimeout(id: number): void {
			win.timeouts = win.timeouts.filter((t: any) => t.id !== id);
		},
		getComputedStyle(el: any): any {
			return { overflowX: el.overflowX ?? "visible", overflowY: el.overflowY ?? "visible" };
		},
	};
	win.document = makeDoc(win);
	return win;
}

function makePlugin(): any {
	const plugin: any = {
		unloadCbs: [] as Array<() => void>,
		workspaceHandlers: {} as Record<string, (ww: unknown, win: unknown) => void>,
		app: {
			workspace: {
				on(name: string, cb: (ww: unknown, win: unknown) => void): any {
					plugin.workspaceHandlers[name] = cb;
					return { name };
				},
			},
		},
		registerEvent: vi.fn(),
		register(cb: () => void): void {
			plugin.unloadCbs.push(cb);
		},
		registerDomEvent: vi.fn(),
	};
	return plugin;
}

function pointerEvent(x: number, y: number, extra: Record<string, unknown> = {}): any {
	return {
		clientX: x,
		clientY: y,
		pointerType: "mouse",
		button: 0,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		...extra,
	};
}

const PAYLOAD: DragPayload = { taskKey: "gtd.md:1", sourceViewType: "gtd-calendar" };

let mainWin: any;
let plugin: any;
let service: DndService;

beforeEach(() => {
	mainWin = makeWin();
	(globalThis as any).activeWindow = mainWin;
	plugin = makePlugin();
	service = new DndService(plugin as unknown as Plugin);
});

afterEach(() => {
	delete (globalThis as any).activeWindow;
});

/** Полный мышиный жест до фазы dragging: down на src + move ≥ 5px. */
function dragToDragging(src: any): void {
	service.startDrag(PAYLOAD, pointerEvent(10, 10), src);
	mainWin.document.dispatch("pointermove", pointerEvent(10, 20));
}

describe("DndService: pop-out — жизненный цикл doc-листенеров", () => {
	it("window-close снимает все листенеры окна — document не удерживается", () => {
		const popWin = makeWin();
		plugin.workspaceHandlers["window-open"](null, popWin);
		const doc = popWin.document;
		expect(doc.added.length).toBeGreaterThan(0);

		plugin.workspaceHandlers["window-close"](null, popWin);
		for (const a of doc.added) {
			expect(doc.removed.some((r: any) => r.type === a.type && r.fn === a.fn)).toBe(true);
		}
		for (const arr of doc.listeners.values()) expect(arr).toHaveLength(0);
	});

	it("циклы open/close не копят регистраций в unload-списке плагина", () => {
		const before = plugin.unloadCbs.length;
		for (let i = 0; i < 5; i++) {
			const w = makeWin();
			plugin.workspaceHandlers["window-open"](null, w);
			plugin.workspaceHandlers["window-close"](null, w);
		}
		expect(plugin.unloadCbs.length).toBe(before);
		// registerDomEvent больше не используется — его замыкания и держали Document
		expect(plugin.registerDomEvent).not.toHaveBeenCalled();
	});

	it("unload плагина снимает листенеры и с ещё открытых окон", () => {
		const popWin = makeWin();
		plugin.workspaceHandlers["window-open"](null, popWin);
		for (const cb of plugin.unloadCbs) cb();
		for (const arr of popWin.document.listeners.values()) expect(arr).toHaveLength(0);
		for (const arr of mainWin.document.listeners.values()) expect(arr).toHaveLength(0);
	});
});

describe("DndService: автоскролл якорится на элемент под курсором", () => {
	/** Копия геометрии kanban: доска (x-скролл) > секция (hidden) > тело (y-скролл) > карточка. */
	function kanbanDom(win: any): { board: any; section: any; body: any; card: any } {
		const board = makeEl(win, {
			rect: { left: 0, top: 0, right: 600, bottom: 300 },
			overflowX: "auto",
			overflowY: "hidden",
			scrollWidth: 1200,
			clientWidth: 600,
			scrollHeight: 300,
			clientHeight: 300,
		});
		const section = makeEl(win, {
			rect: { left: 0, top: 0, right: 200, bottom: 300 },
			overflowX: "hidden",
			overflowY: "hidden",
		});
		const body = makeEl(win, {
			rect: { left: 0, top: 30, right: 200, bottom: 300 },
			overflowY: "auto",
			overflowX: "hidden",
			scrollHeight: 900,
			clientHeight: 270,
		});
		const card = makeEl(win, { rect: { left: 0, top: 240, right: 200, bottom: 280 } });
		card.parentElement = body;
		body.parentElement = section;
		section.parentElement = board;
		return { board, section, body, card };
	}

	it("курсор у нижнего края колонки крутит col-body, а не горизонтальную доску", () => {
		const { board, section, body, card } = kanbanDom(mainWin);
		mainWin.document.elementFromPoint = (): any => card;
		const target: any = { el: section, accepts: (): boolean => true, drop: (): void => {} };
		(service as any).autoscroll({ win: mainWin, drag: null, dispose: () => {} }, target, 100, 290);
		expect(body.scrollBy).toHaveBeenCalledTimes(1);
		const call = body.scrollBy.mock.calls[0] as [number, number];
		expect(call[0]).toBe(0);
		expect(call[1]).toBeGreaterThan(0);
		expect(board.scrollBy).not.toHaveBeenCalled();
	});

	it("курсор у бокового края: col-body без dx пропускается, доска получает dx", () => {
		const { board, body, card } = kanbanDom(mainWin);
		mainWin.document.elementFromPoint = (): any => card;
		(service as any).autoscroll({ win: mainWin, drag: null, dispose: () => {} }, null, 10, 150);
		expect(body.scrollBy).not.toHaveBeenCalled();
		expect(board.scrollBy).toHaveBeenCalledTimes(1);
		const call = board.scrollBy.mock.calls[0] as [number, number];
		expect(call[0]).toBeLessThan(0);
		expect(call[1]).toBe(0);
	});

	it("elementFromPoint пуст — fallback на el цели", () => {
		const { body, card } = kanbanDom(mainWin);
		mainWin.document.elementFromPoint = (): any => null;
		const target: any = { el: card, accepts: (): boolean => true, drop: (): void => {} };
		(service as any).autoscroll({ win: mainWin, drag: null, dispose: () => {} }, target, 100, 290);
		expect(body.scrollBy).toHaveBeenCalledTimes(1);
	});
});

describe("DndService: post-drag click глотается", () => {
	it("после завершённого drag первый click гасится capture-ловушкой once", () => {
		const src = makeEl(mainWin, { rect: { left: 0, top: 0, right: 100, bottom: 40 } });
		dragToDragging(src);
		mainWin.document.dispatch("pointerup", pointerEvent(10, 20));

		const trap = mainWin.document.added.find((a: any) => a.type === "click");
		expect(trap).toBeDefined();
		expect(trap.opts).toMatchObject({ capture: true, once: true });

		// click, который браузер шлёт синхронно после pointerup, — проглочен
		const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
		mainWin.document.dispatch("click", click);
		expect(click.preventDefault).toHaveBeenCalled();
		expect(click.stopPropagation).toHaveBeenCalled();

		// следующий click живёт как обычно (ловушка одноразовая)
		const click2 = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
		mainWin.document.dispatch("click", click2);
		expect(click2.preventDefault).not.toHaveBeenCalled();
	});

	it("отпускание без порога (pending — обычный клик) ловушку не ставит", () => {
		const src = makeEl(mainWin, { rect: { left: 0, top: 0, right: 100, bottom: 40 } });
		service.startDrag(PAYLOAD, pointerEvent(10, 10), src);
		mainWin.document.dispatch("pointerup", pointerEvent(11, 10)); // < 5px
		expect(mainWin.document.added.some((a: any) => a.type === "click")).toBe(false);
	});

	it("ловушка самоуничтожается по setTimeout(0), если click не пришёл", () => {
		const src = makeEl(mainWin, { rect: { left: 0, top: 0, right: 100, bottom: 40 } });
		dragToDragging(src);
		mainWin.document.dispatch("pointerup", pointerEvent(10, 20));
		expect((mainWin.document.listeners.get("click") ?? []).length).toBe(1);
		for (const t of [...mainWin.timeouts]) t.fn();
		expect((mainWin.document.listeners.get("click") ?? []).length).toBe(0);
	});
});

describe("DndService: touchmove-guard (touch-action: pan-y на карточках)", () => {
	it("touchmove-листенер повешен non-passive", () => {
		const reg = mainWin.document.added.find((a: any) => a.type === "touchmove");
		expect(reg).toBeDefined();
		expect(reg.opts).toMatchObject({ passive: false });
	});

	it("без drag touchmove не гасится — нативный скролл жив", () => {
		const tm = { preventDefault: vi.fn() };
		mainWin.document.dispatch("touchmove", tm);
		expect(tm.preventDefault).not.toHaveBeenCalled();
	});

	it("в pending (палец ждёт long-press) touchmove не гасится — свайп уходит скроллу", () => {
		const src = makeEl(mainWin, { rect: { left: 0, top: 0, right: 100, bottom: 40 } });
		service.startDrag(PAYLOAD, pointerEvent(10, 10, { pointerType: "touch" }), src);
		const tm = { preventDefault: vi.fn() };
		mainWin.document.dispatch("touchmove", tm);
		expect(tm.preventDefault).not.toHaveBeenCalled();
	});

	it("в фазе dragging touchmove гасится — pan не уводит активный drag", () => {
		const src = makeEl(mainWin, { rect: { left: 0, top: 0, right: 100, bottom: 40 } });
		dragToDragging(src);
		const tm = { preventDefault: vi.fn() };
		mainWin.document.dispatch("touchmove", tm);
		expect(tm.preventDefault).toHaveBeenCalled();
	});
});
