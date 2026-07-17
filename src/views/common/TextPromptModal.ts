import { Modal, type App } from "obsidian";

/**
 * Минимальный prompt свободного текста (одна строка) — для правки места 📍
 * события. Пустое значение возвращается как "" (вызыватель трактует пустое как
 * снятие поля). Enter — подтвердить, Escape — закрыть (штатно у Modal).
 */
export class TextPromptModal extends Modal {
	constructor(
		app: App,
		private readonly promptTitle: string,
		private readonly onSubmit: (value: string) => void,
		private readonly initial: string = "",
		private readonly placeholder: string = "",
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.promptTitle);
		const wrap = this.contentEl.createDiv({ cls: "gtd-text-prompt" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "8px";
		const input = wrap.createEl("input", {
			type: "text",
			placeholder: this.placeholder,
			value: this.initial,
		});
		input.style.width = "100%";
		const submit = (): void => {
			this.close();
			this.onSubmit(input.value.trim());
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const ok = footer.createEl("button", { text: "OK", cls: "mod-cta" });
		ok.addEventListener("click", submit);
		input.focus();
		input.select();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
