import { Modal, type App } from "obsidian";

/** Минимальный prompt даты (<input type="date">) для «Отложить: дата…». */
export class DatePromptModal extends Modal {
	constructor(
		app: App,
		private readonly promptTitle: string,
		private readonly onSubmit: (date: string) => void,
		private readonly initial?: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.promptTitle);
		const wrap = this.contentEl.createDiv({ cls: "gtd-date-prompt" });
		const input = wrap.createEl("input", { type: "date" });
		if (this.initial !== undefined) input.value = this.initial;
		const submit = (): void => {
			const value = input.value;
			if (value === "") return;
			this.close();
			this.onSubmit(value);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		const ok = wrap.createEl("button", { text: "OK", cls: "mod-cta" });
		ok.addEventListener("click", submit);
		wrap.style.display = "flex";
		wrap.style.gap = "8px";
		input.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
