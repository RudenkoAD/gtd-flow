/**
 * Модал «Новый шаблон» вида «Регулярные»: поле «Название» + поле «Правило» с
 * живой валидацией через core-грамматику (parseRule при каждом вводе) и
 * примерами-подсказками. Образец — RuleEditModal (его RULE_EXAMPLES здесь
 * переиспользуются); RuleEditModal НЕ меняем, чтобы не ломать «Изменить
 * правило…». Сохранение — колбэком (вид зовёт createTemplate): модал не пишет сам.
 */
import { Modal, type App } from "obsidian";
import { isParseError, parseRule } from "../../core/recurrence/grammar";
import { RULE_EXAMPLES } from "./RuleEditModal";

export class TemplateCreateModal extends Modal {
	constructor(
		app: App,
		private readonly onSubmit: (name: string, ruleText: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Новый шаблон");
		const wrap = this.contentEl.createDiv({ cls: "gtd-template-create" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "10px";
		wrap.style.minWidth = "0";
		wrap.style.paddingBottom = "max(8px, env(safe-area-inset-bottom))";

		const nameId = "gtd-template-create-name";
		wrap.createEl("label", { text: "Название", attr: { for: nameId } });
		const nameInput = wrap.createEl("input", {
			type: "text",
			placeholder: "Название задачи",
			attr: { id: nameId },
		});
		nameInput.style.width = "100%";
		nameInput.style.minHeight = "44px";
		nameInput.style.fontSize = "max(16px, 1em)";

		const ruleId = "gtd-template-create-rule";
		wrap.createEl("label", { text: "Правило повторения", attr: { for: ruleId } });
		const ruleInput = wrap.createEl("input", {
			type: "text",
			placeholder: "every …",
			attr: { id: ruleId },
		});
		ruleInput.style.width = "100%";
		ruleInput.style.minHeight = "44px";
		ruleInput.style.fontSize = "max(16px, 1em)";

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
				ruleInput.value = ex;
				validate();
				ruleInput.focus();
			});
		}

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const save = footer.createEl("button", {
			text: "Создать",
			cls: "mod-cta",
			attr: { type: "button" },
		});
		save.style.minWidth = "min(100%, 10rem)";
		save.style.minHeight = "44px";

		// Валидна форма, когда есть непустое название И правило распознано грамматикой.
		const validate = (): boolean => {
			const nameOk = nameInput.value.trim() !== "";
			const parsed = parseRule(ruleInput.value);
			if (!nameOk) {
				feedback.setText("Укажите название шаблона");
				feedback.style.color = "var(--text-muted)";
				save.disabled = true;
				return false;
			}
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
			const name = nameInput.value.trim();
			const ruleText = ruleInput.value.trim();
			this.close();
			this.onSubmit(name, ruleText);
		};

		nameInput.addEventListener("input", () => void validate());
		ruleInput.addEventListener("input", () => void validate());
		for (const el of [nameInput, ruleInput]) {
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});
		}
		save.addEventListener("click", submit);

		validate();
		nameInput.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
