/**
 * Runtime-заглушка пакета 'obsidian' для vitest (см. alias в vitest.config.ts).
 *
 * Пакет 'obsidian' — только .d.ts без runtime-энтри, поэтому vite не может
 * его резолвить даже под vi.mock (мокер сначала резолвит id). Алиас указывает
 * сюда; тесты, которым нужно ПОВЕДЕНИЕ (Notice-и, жизненный цикл Modal),
 * подменяют модуль через vi.mock("obsidian", factory) — заглушка лишь даёт
 * резолверу файл. Классы ниже — инертные болванки на случай импорта без мока.
 */

/* eslint-disable @typescript-eslint/no-extraneous-class */

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
