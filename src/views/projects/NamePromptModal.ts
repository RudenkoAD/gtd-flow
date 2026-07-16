/**
 * NamePromptModal — простой промпт с одним текстовым полем (образец —
 * локальный TextPromptModal графа проекта, ProjectGraph.svelte): Enter или
 * кнопка подтверждают, пустой ввод — no-op. Используется для поля «Название»
 * при создании проекта из обзора (ProjectsOverview) и из пустого графа (Project).
 */
import { Modal, type App } from "obsidian";

export class NamePromptModal extends Modal {
	constructor(
		app: App,
		private readonly promptTitle: string,
		private readonly submitLabel: string,
		private readonly onSubmit: (name: string) => void,
		private readonly placeholder = "Название",
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.promptTitle);
		const wrap = this.contentEl.createDiv();
		wrap.style.display = "flex";
		wrap.style.gap = "8px";

		const input = wrap.createEl("input", { type: "text" });
		input.style.flex = "1 1 auto";
		input.placeholder = this.placeholder;

		const submit = (): void => {
			const value = input.value.trim();
			if (value === "") return;
			this.close();
			this.onSubmit(value);
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});

		const ok = wrap.createEl("button", { text: this.submitLabel, cls: "mod-cta" });
		ok.addEventListener("click", submit);

		input.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
