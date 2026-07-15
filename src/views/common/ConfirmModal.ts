import { Modal, type App } from "obsidian";

/**
 * Promise-модал подтверждения (политика «🛫 и 📅 взаимоисключающие» и др.).
 * resolve(true) — только явное «Да»; закрытие/Escape — false.
 */
export class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly body: string,
		private readonly confirmLabel: string,
		private readonly onResult: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.body });
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const yes = row.createEl("button", { text: this.confirmLabel, cls: "mod-cta" });
		yes.addEventListener("click", () => {
			this.resolved = true;
			this.close();
			this.onResult(true);
		});
		const no = row.createEl("button", { text: "Отмена" });
		no.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onResult(false);
	}
}

export function confirm(app: App, title: string, body: string, confirmLabel: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, body, confirmLabel, resolve).open());
}
