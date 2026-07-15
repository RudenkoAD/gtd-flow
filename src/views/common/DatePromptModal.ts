import { Modal, type App } from "obsidian";

/**
 * Минимальный prompt даты (<input type="date">) для «Отложить: дата…» и
 * «Запланировать…». При withTime рядом появляется <input type="time">:
 * пустое время = «без времени» (onSubmit получает time = null).
 */
export class DatePromptModal extends Modal {
	constructor(
		app: App,
		private readonly promptTitle: string,
		private readonly onSubmit: (date: string, time: string | null) => void,
		private readonly initial?: string,
		/** Показать поле времени; defer-поток остаётся date-only (withTime=false). */
		private readonly withTime: boolean = false,
		private readonly initialTime?: string | null,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.promptTitle);
		const wrap = this.contentEl.createDiv({ cls: "gtd-date-prompt" });
		const input = wrap.createEl("input", { type: "date" });
		input.required = true;
		if (this.initial !== undefined) input.value = this.initial;
		let timeInput: HTMLInputElement | null = null;
		if (this.withTime) {
			timeInput = wrap.createEl("input", { type: "time" });
			if (this.initialTime != null) timeInput.value = this.initialTime;
		}
		const submit = (): void => {
			const value = input.value;
			if (value === "") {
				// видимый отклик вместо тихо проглоченного клика по OK
				input.reportValidity();
				return;
			}
			const time = timeInput !== null && timeInput.value !== "" ? timeInput.value : null;
			this.close();
			this.onSubmit(value, time);
		};
		const submitOnEnter = (e: KeyboardEvent): void => {
			if (e.key === "Enter") submit();
		};
		input.addEventListener("keydown", submitOnEnter);
		timeInput?.addEventListener("keydown", submitOnEnter);
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
