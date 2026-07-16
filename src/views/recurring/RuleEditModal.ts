/**
 * Модал «Изменить правило…» вида «Регулярные»: input с живой валидацией через
 * core-грамматику (parseRule при каждом вводе) и примеры-подсказки из ТЗ §6.
 * Сохранение — колбэком (вид зовёт RecurrencePort.setRule): модал не пишет сам.
 */
import { Modal, type App } from "obsidian";
import { isParseError, parseRule } from "../../core/recurrence/grammar";

/** Примеры-подсказки языка правил (ТЗ §6); клик подставляет пример в input. */
export const RULE_EXAMPLES: readonly string[] = [
	"every day",
	"every 2 weeks on mon, thu",
	"every month on the last day",
	"every year on april 1",
	"every friday from 2026-07-15 until 2026-09-10",
];

export class RuleEditModal extends Modal {
	constructor(
		app: App,
		private readonly initial: string,
		private readonly onSubmit: (ruleText: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Правило повторения");
		const wrap = this.contentEl.createDiv({ cls: "gtd-rule-edit" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "8px";

		const input = wrap.createEl("input", {
			type: "text",
			placeholder: "every …",
			value: this.initial,
		});
		input.style.width = "100%";

		const feedback = wrap.createDiv({ cls: "gtd-rule-feedback" });
		feedback.style.minHeight = "1.5em";
		feedback.style.fontSize = "var(--font-ui-smaller, 0.85em)";

		const examplesEl = wrap.createDiv({ cls: "gtd-rule-examples" });
		examplesEl.createSpan({ text: "Примеры: " }).style.color = "var(--text-muted)";
		for (const ex of RULE_EXAMPLES) {
			const btn = examplesEl.createEl("button", { text: ex });
			btn.style.margin = "2px 4px 2px 0";
			btn.style.fontSize = "var(--font-ui-smaller, 0.85em)";
			btn.addEventListener("click", () => {
				input.value = ex;
				validate();
				input.focus();
			});
		}

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const save = footer.createEl("button", { text: "Сохранить", cls: "mod-cta" });

		const validate = (): boolean => {
			const parsed = parseRule(input.value);
			if (isParseError(parsed)) {
				feedback.setText(`✕ ${parsed.error}`);
				feedback.style.color = "var(--text-error, var(--text-muted))";
				save.disabled = true;
				return false;
			}
			feedback.setText("✓ правило корректно");
			feedback.style.color = "var(--text-success, var(--text-muted))";
			save.disabled = false;
			return true;
		};

		const submit = (): void => {
			if (!validate()) return;
			const value = input.value.trim();
			this.close();
			this.onSubmit(value);
		};

		input.addEventListener("input", () => void validate());
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		save.addEventListener("click", submit);

		validate();
		input.focus();
		input.select();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
