/**
 * Narrow runtime substitute for Obsidian in the browser component gate.
 * Components remain real Svelte components; the stub deliberately makes Notice
 * observable as an ARIA live status so rejected async UI work is testable.
 */

type MenuCallback = (item: MenuItem) => unknown;

interface BrowserDomOptions {
	text?: string;
	cls?: string | string[];
	attr?: Record<string, string>;
	type?: string;
	value?: string;
	placeholder?: string;
}

function applyDomOptions(element: HTMLElement, options: BrowserDomOptions | undefined): void {
	if (options === undefined) return;
	if (options.text !== undefined) element.textContent = options.text;
	const classes = Array.isArray(options.cls) ? options.cls : (options.cls?.split(/\s+/u) ?? []);
	for (const className of classes) {
		if (className !== "") element.classList.add(className);
	}
	for (const [name, value] of Object.entries(options.attr ?? {})) {
		element.setAttribute(name, value);
	}
	for (const name of ["type", "value", "placeholder"] as const) {
		const value = options[name];
		if (value !== undefined) Reflect.set(element, name, value);
	}
}

/** Runtime subset of Obsidian's HTMLElement helpers used by real modal code. */
function installElementHelpers(): void {
	if (typeof HTMLElement.prototype.createEl !== "function") {
		HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
			tag: K,
			options?: BrowserDomOptions,
		): HTMLElementTagNameMap[K] {
			const child = this.ownerDocument.createElement(tag);
			applyDomOptions(child, options);
			this.appendChild(child);
			return child;
		};
	}
	if (typeof HTMLElement.prototype.createDiv !== "function") {
		HTMLElement.prototype.createDiv = function (options?: BrowserDomOptions): HTMLDivElement {
			return this.createEl("div", options);
		};
	}
	if (typeof HTMLElement.prototype.createSpan !== "function") {
		HTMLElement.prototype.createSpan = function (options?: BrowserDomOptions): HTMLSpanElement {
			return this.createEl("span", options);
		};
	}
	if (typeof HTMLElement.prototype.setText !== "function") {
		HTMLElement.prototype.setText = function (text: string | DocumentFragment): void {
			this.replaceChildren(text);
		};
	}
	if (typeof HTMLElement.prototype.empty !== "function") {
		HTMLElement.prototype.empty = function (): void {
			this.replaceChildren();
		};
	}
}

installElementHelpers();

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
	private static nextId = 1;
	readonly titleEl = document.createElement("h2");
	readonly contentEl = document.createElement("div");
	readonly modalEl = document.createElement("div");
	private readonly closeButtonEl = document.createElement("button");
	private readonly containerEl = document.createElement("div");
	private opened = false;
	private previousFocus: HTMLElement | null = null;
	private readonly onKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && !event.defaultPrevented) this.close();
	};

	constructor(public app: unknown) {
		const titleId = `browser-modal-title-${Modal.nextId++}`;
		this.containerEl.className = "modal-container";
		this.containerEl.style.position = "fixed";
		this.containerEl.style.inset = "0";
		this.containerEl.style.zIndex = "1000";
		this.containerEl.style.display = "grid";
		this.containerEl.style.placeItems = "center";
		this.containerEl.style.padding = "1rem";
		this.containerEl.style.background = "rgba(15, 23, 42, 0.35)";

		this.modalEl.className = "modal";
		this.modalEl.setAttribute("role", "dialog");
		this.modalEl.setAttribute("aria-modal", "true");
		this.modalEl.setAttribute("aria-labelledby", titleId);
		this.modalEl.tabIndex = -1;
		this.modalEl.style.width = "min(42rem, 100%)";
		this.modalEl.style.maxHeight = "calc(100vh - 2rem)";
		this.modalEl.style.overflow = "auto";
		this.modalEl.style.padding = "1rem";
		this.modalEl.style.borderRadius = "0.5rem";
		this.modalEl.style.background = "var(--background-primary, #fff)";
		this.modalEl.style.color = "var(--text-normal, #111827)";
		this.modalEl.style.boxShadow = "0 1rem 3rem rgba(15, 23, 42, 0.3)";

		this.titleEl.id = titleId;
		this.titleEl.className = "modal-title";
		this.contentEl.className = "modal-content";
		this.closeButtonEl.type = "button";
		this.closeButtonEl.className = "modal-close-button";
		this.closeButtonEl.setAttribute("aria-label", "Закрыть окно");
		this.closeButtonEl.textContent = "×";
		this.closeButtonEl.addEventListener("click", () => this.close());
		this.modalEl.append(this.closeButtonEl, this.titleEl, this.contentEl);
		this.containerEl.append(this.modalEl);
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		document.body.append(this.containerEl);
		document.addEventListener("keydown", this.onKeydown);
		this.onOpen();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		document.removeEventListener("keydown", this.onKeydown);
		try {
			this.onClose();
		} finally {
			this.containerEl.remove();
			if (this.previousFocus?.isConnected === true) this.previousFocus.focus();
			this.previousFocus = null;
		}
	}

	onOpen(): void {}
	onClose(): void {}
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
