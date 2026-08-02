/**
 * Runtime-заглушка пакета 'obsidian' для vitest (см. alias в vitest.config.ts).
 *
 * Пакет 'obsidian' — только .d.ts без runtime-энтри, поэтому vite не может
 * его резолвить даже под vi.mock (мокер сначала резолвит id). Алиас указывает
 * сюда; тесты, которым нужно ПОВЕДЕНИЕ (Notice-и, жизненный цикл Modal),
 * подменяют модуль через vi.mock("obsidian", factory) — заглушка лишь даёт
 * резолверу файл. Классы ниже — инертные болванки на случай импорта без мока.
 */

export class Modal {
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}

export class Notice {
	constructor(_message?: unknown, _timeout?: number) {}
}

export class FuzzySuggestModal {
	constructor(public app: unknown) {}
	setPlaceholder(_p: string): void {}
	open(): void {}
	close(): void {}
}

export class Menu {}

export class TFile {}

export class MarkdownView {}

export class Plugin {}

export const Platform = {
	isDesktopApp: true,
	isMobileApp: false,
	isPhone: false,
};

/**
 * Как реальный Obsidian ≥1.12: конструктор View вызывает getViewType()
 * ДО присвоения полей подкласса. Регрессия живой верификации — виды,
 * читающие инстанс-поля в getViewType(), падали при конструировании.
 */
export class ItemView {
	contentEl = { addClass(_c: string): void {}, removeClass(_c: string): void {} };

	constructor(public leaf: unknown) {
		// намеренно: воспроизводим порядок вызовов реального ItemView
		(this as unknown as { getViewType(): string }).getViewType();
	}

	getViewType(): string {
		return "stub";
	}
}
