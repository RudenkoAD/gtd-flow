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
		wrap.style.gap = "10px";
		wrap.style.minWidth = "0";
		wrap.style.paddingBottom = "max(8px, env(safe-area-inset-bottom))";

		const inputId = "gtd-rule-edit-value";
		wrap.createEl("label", { text: "Правило повторения", attr: { for: inputId } });
		const input = wrap.createEl("input", {
			type: "text",
			placeholder: "every …",
			value: this.initial,
			attr: { id: inputId },
		});
		input.style.width = "100%";
		input.style.minHeight = "44px";
		input.style.fontSize = "max(16px, 1em)";

		const feedback = wrap.createDiv({ cls: "gtd-rule-feedback" });
		feedback.style.minHeight = "1.5em";
		feedback.style.fontSize = "var(--font-ui-smaller, 0.85em)";

		const examplesEl = wrap.createDiv({ cls: "gtd-rule-examples" });
		examplesEl.style.display = "flex";
		examplesEl.style.flexWrap = "wrap";
		examplesEl.style.gap = "6px";
		examplesEl.createSpan({ text: "Примеры:" }).style.cssText =
			"color: var(--text-muted); flex-basis: 100%";
		for (const ex of RULE_EXAMPLES) {
			const btn = examplesEl.createEl("button", {
				text: ex,
				attr: { type: "button" },
			});
			btn.style.flex = "1 1 min(100%, 14rem)";
			btn.style.minWidth = "0";
			btn.style.minHeight = "44px";
			btn.style.fontSize = "var(--font-ui-smaller, 0.85em)";
			btn.style.whiteSpace = "normal";
			btn.addEventListener("click", () => {
				input.value = ex;
				validate();
				input.focus();
			});
		}

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const save = footer.createEl("button", {
			text: "Сохранить",
			cls: "mod-cta",
			attr: { type: "button" },
		});
		save.style.minWidth = "min(100%, 10rem)";
		save.style.minHeight = "44px";

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
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
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
