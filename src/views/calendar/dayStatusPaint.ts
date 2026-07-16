/**
 * Жест покраски дней статусами в календаре (фича «красить дни»).
 *
 * Контроллер живёт на контейнере (сетка месяца / ряд шапок тайм-сетки) и ловит
 * pointer-жест по элементам с атрибутом `data-gtd-ds-date`: клик по одному дню
 * или протяжка по нескольким (диапазон, как многодневное событие в Google
 * Calendar). На отпускании — меню выбора статуса, запись через DayStatusPort.
 *
 * Обёрнут в контейнер, а не в DnD-сервис: тот двигает существующие карточки,
 * здесь же красим дни. Файл вид-слоя (импортит obsidian Menu) — не core.
 */
import { Menu, type App } from "obsidian";
import type { IsoDate } from "../../core/model/Task";
import type { DayStatusPort } from "../../services/DayStatusService";
import { DayStatusPaletteModal } from "./DayStatusPaletteModal";
import { DayStatusRuleModal } from "./DayStatusRuleModal";

export interface PaintPreview {
	from: IsoDate;
	to: IsoDate;
}

/** Дата из атрибута ближайшего предка с data-gtd-ds-date, иначе null. */
function dateOf(el: Element | null): IsoDate | null {
	const band = el?.closest("[data-gtd-ds-date]") ?? null;
	return (band?.getAttribute("data-gtd-ds-date") as IsoDate | null) ?? null;
}

/**
 * Меню покраски для диапазона [from, to] (from===to — один день). Позиция —
 * по событию (showAtMouseEvent корректно работает и в pop-out окне вида).
 */
export function openDayStatusMenu(
	app: App,
	port: DayStatusPort,
	from: IsoDate,
	to: IsoDate,
	ev: MouseEvent,
): void {
	const isRange = from !== to;
	const statuses = port.statuses();
	const menu = new Menu();

	if (statuses.length === 0) {
		menu.addItem((mi) =>
			mi
				.setTitle("Создать файл статусов дней…")
				.setIcon("palette")
				.onClick(() => void port.ensureConfig()),
		);
		menu.showAtMouseEvent(ev);
		return;
	}

	menu.addItem((mi) =>
		mi.setTitle(isRange ? `Покрасить ${from} … ${to}` : `Покрасить ${from}`).setDisabled(true),
	);
	for (const s of statuses) {
		menu.addItem((mi) =>
			mi
				.setTitle(s.name)
				.setIcon("square")
				.onClick(() =>
					void (isRange ? port.setRange(from, to, s.name) : port.setDay(from, s.name)),
				),
		);
	}
	if (!isRange) {
		menu.addSeparator();
		menu.addItem((mi) =>
			mi.setTitle("Убрать статус").setIcon("eraser").onClick(() => void port.clearDay(from)),
		);
	}
	menu.addSeparator();
	// Правило не зависит от кликнутой даты — пункт одинаков для дня и диапазона.
	menu.addItem((mi) =>
		mi
			.setTitle("Повторяющееся правило…")
			.setIcon("repeat")
			.onClick(() => new DayStatusRuleModal(app, port).open()),
	);
	menu.addItem((mi) =>
		mi
			.setTitle("Палитра…")
			.setIcon("palette")
			.onClick(() => new DayStatusPaletteModal(app, port).open()),
	);
	menu.showAtMouseEvent(ev);
}

/** pointer-обработчики для контейнера с днями (data-gtd-ds-date). */
export interface PaintController {
	pointerdown: (e: PointerEvent) => void;
	pointermove: (e: PointerEvent) => void;
	pointerup: (e: PointerEvent) => void;
	pointercancel: (e: PointerEvent) => void;
}

export function createPaintController(opts: {
	app: App;
	/** Порт статусов (может быть null — жест не запускается). */
	port: () => DayStatusPort | null;
	/** Обновление превью диапазона для подсветки (null — жеста нет). */
	setPreview: (p: PaintPreview | null) => void;
}): PaintController {
	let anchor: IsoDate | null = null;
	let cursor: IsoDate | null = null;
	let pointerId: number | null = null;
	let container: HTMLElement | null = null;

	const norm = (): PaintPreview | null =>
		anchor === null || cursor === null
			? null
			: anchor <= cursor
				? { from: anchor, to: cursor }
				: { from: cursor, to: anchor };

	return {
		pointerdown(e: PointerEvent): void {
			if (e.button !== 0 || opts.port() === null) return;
			const date = dateOf(e.target instanceof Element ? e.target : null);
			if (date === null) return;
			container = e.currentTarget as HTMLElement;
			anchor = date;
			cursor = date;
			pointerId = e.pointerId;
			container.setPointerCapture(e.pointerId);
			opts.setPreview(norm());
			e.preventDefault(); // не запускать quick-add/выделение текста
		},
		pointermove(e: PointerEvent): void {
			if (pointerId !== e.pointerId || anchor === null || container === null) return;
			// при захвате указателя target — контейнер; день ищем под точкой
			const date = dateOf(container.ownerDocument.elementFromPoint(e.clientX, e.clientY));
			if (date !== null && date !== cursor) {
				cursor = date;
				opts.setPreview(norm());
			}
		},
		pointerup(e: PointerEvent): void {
			if (pointerId !== e.pointerId) return;
			const range = norm();
			container?.releasePointerCapture(e.pointerId);
			anchor = null;
			cursor = null;
			pointerId = null;
			container = null;
			opts.setPreview(null);
			const port = opts.port();
			if (range !== null && port !== null) openDayStatusMenu(opts.app, port, range.from, range.to, e);
		},
		pointercancel(e: PointerEvent): void {
			if (pointerId !== e.pointerId) return;
			container?.releasePointerCapture(e.pointerId);
			anchor = null;
			cursor = null;
			pointerId = null;
			container = null;
			opts.setPreview(null);
		},
	};
}
