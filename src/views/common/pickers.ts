/**
 * FuzzySuggestModal-пикеры паритета без drag (ТЗ §8, слой 3): колонка доски,
 * проект, дата. Все — Promise-обёртки: null = пикер закрыт без выбора.
 * На телефоне и между pop-out окнами это ОСНОВНОЙ интерфейс перемещений.
 */
import { FuzzySuggestModal, type App } from "obsidian";
import type { BoardDef } from "../../core/board/boardFile";
import type { IsoDate } from "../../core/model/Task";
import type { DiscoveredBoard } from "../../services/BoardService";
import type { ProjectSummary } from "../../services/ProjectService";
import { DatePromptModal } from "./DatePromptModal";

interface PickItem<T> {
	label: string;
	value: T;
}

/**
 * Общий модал выбора из плоского списка. resolve(null) при закрытии без
 * выбора уходит в macrotask: obsidian может закрыть модал ДО вызова
 * onChooseItem — немедленный null в onClose съел бы настоящий выбор.
 */
class PickModal<T> extends FuzzySuggestModal<PickItem<T>> {
	private done = false;

	constructor(
		app: App,
		private readonly items: PickItem<T>[],
		placeholder: string,
		private readonly resolve: (v: T | null) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): PickItem<T>[] {
		return this.items;
	}

	getItemText(item: PickItem<T>): string {
		return item.label;
	}

	onChooseItem(item: PickItem<T>): void {
		if (this.done) return;
		this.done = true;
		this.resolve(item.value);
	}

	override onClose(): void {
		super.onClose();
		setTimeout(() => {
			if (!this.done) {
				this.done = true;
				this.resolve(null);
			}
		}, 0);
	}
}

export interface BoardColumnChoice {
	boardPath: string;
	def: BoardDef;
	colId: string;
}

/** Все доски × все колонки одним плоским списком: «Доска → Колонка». */
export function pickBoardColumn(
	app: App,
	boards: readonly DiscoveredBoard[],
): Promise<BoardColumnChoice | null> {
	const items: PickItem<BoardColumnChoice>[] = [];
	for (const b of boards) {
		for (const col of b.def.columns) {
			items.push({
				label: `${b.def.name} → ${col.name}`,
				value: { boardPath: b.path, def: b.def, colId: col.id },
			});
		}
	}
	return new Promise((resolve) => {
		new PickModal(app, items, "Колонка доски…", resolve).open();
	});
}

export function pickProject(
	app: App,
	projects: readonly ProjectSummary[],
): Promise<ProjectSummary | null> {
	const items: PickItem<ProjectSummary>[] = projects.map((p) => ({
		label: `${p.name} (${p.path})`,
		value: p,
	}));
	return new Promise((resolve) => {
		new PickModal(app, items, "Проект…", resolve).open();
	});
}

/**
 * Дата через DatePromptModal (реюз «Отложить: дата…»). null — отмена.
 * DatePromptModal.submit закрывает модал ДО вызова onSubmit, поэтому
 * resolve(null) из onClose тоже уходит в macrotask — выбор побеждает.
 */
export function pickDate(app: App, title: string, initial?: string): Promise<IsoDate | null> {
	return new Promise((resolve) => {
		let done = false;
		class Prompt extends DatePromptModal {
			override onClose(): void {
				super.onClose();
				setTimeout(() => {
					if (!done) {
						done = true;
						resolve(null);
					}
				}, 0);
			}
		}
		new Prompt(
			app,
			title,
			(date) => {
				if (!done) {
					done = true;
					resolve(date);
				}
			},
			initial,
		).open();
	});
}
