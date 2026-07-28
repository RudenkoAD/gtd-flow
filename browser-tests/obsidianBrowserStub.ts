/**
 * Narrow runtime substitute for Obsidian in the browser component gate.
 * Components remain real Svelte components; the stub deliberately makes Notice
 * observable as an ARIA live status so rejected async UI work is testable.
 */

type MenuCallback = (item: MenuItem) => unknown;

export class MenuItem {
	setTitle(_title: string): this {
		return this;
	}
	setIcon(_icon: string | null): this {
		return this;
	}
	setChecked(_checked: boolean | null): this {
		return this;
	}
	setDisabled(_disabled: boolean): this {
		return this;
	}
	setSection(_section: string): this {
		return this;
	}
	setIsLabel(_isLabel: boolean): this {
		return this;
	}
	onClick(_callback: (event: MouseEvent | KeyboardEvent) => unknown): this {
		return this;
	}
}

export class Menu {
	addItem(callback: MenuCallback): this {
		callback(new MenuItem());
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtMouseEvent(_event: MouseEvent): void {}
}

export class Notice {
	constructor(message?: unknown) {
		const root =
			document.querySelector<HTMLElement>("#gtd-browser-notices") ?? createNoticeRoot();
		root.textContent = String(message ?? "");
	}
}

function createNoticeRoot(): HTMLElement {
	const root = document.createElement("div");
	root.id = "gtd-browser-notices";
	root.setAttribute("role", "status");
	root.setAttribute("aria-live", "polite");
	document.body.append(root);
	return root;
}

export const Platform = { isPhone: false };

export function setTooltip(_element: HTMLElement, _text: string, _options?: unknown): void {}
export function setIcon(_element: HTMLElement, _icon: string): void {}
export async function requestUrl(_options: unknown): Promise<{ status: number; text: string }> {
	return { status: 200, text: "" };
}

export class Modal {
	readonly titleEl = document.createElement("div");
	readonly contentEl = document.createElement("div");
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}

export class Plugin {
	app: unknown = null;
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {}
	addSettingTab(_tab: unknown): void {}
	registerView(_type: string, _creator: unknown): void {}
	registerInterval(_interval: number): void {}
}

export class PluginSettingTab {
	containerEl = document.createElement("div");
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	display(): void {}
}

export class Setting {
	constructor(_container: HTMLElement) {}
	setName(_name: string): this {
		return this;
	}
	setDesc(_description: string): this {
		return this;
	}
	addText(_callback: unknown): this {
		return this;
	}
	addToggle(_callback: unknown): this {
		return this;
	}
	addDropdown(_callback: unknown): this {
		return this;
	}
}

export class ItemView {
	contentEl = document.createElement("div");
	constructor(public leaf: unknown) {}
	getViewType(): string {
		return "browser-test";
	}
}

export class FuzzySuggestModal<T> extends Modal {
	setPlaceholder(_placeholder: string): void {}
	setInstructions(_instructions: unknown[]): void {}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
}

export class TFile {}
export class MarkdownView {}
