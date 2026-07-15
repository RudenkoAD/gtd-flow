/**
 * Модал создания/правки повторяющегося события календаря (§события). Реюзит
 * паттерны RuleEditModal: живая валидация правила через core parseRule и
 * примеры-подсказки. Три поля: название, правило, время ("HH:mm[-HH:mm]").
 * Итоговое правило = joinEventRule(rule, time); валидируется целиком.
 * Сохранение — колбэком (вид зовёт createEventSeries/editEventSeries).
 */
import { Modal, type App } from "obsidian";
import { isParseError, parseRule } from "../../core/recurrence/grammar";
import { joinEventRule } from "./eventSeries";

/** Примеры правил без времени — клик подставляет пример в поле правила. */
const RULE_EXAMPLES: readonly string[] = [
	"every day",
	"every tuesday",
	"every 2 weeks on mon, thu",
	"every month on the last day",
];

export interface EventSeriesInitial {
	name: string;
	/** Правило БЕЗ хвоста времени. */
	rule: string;
	/** "HH:mm" или "HH:mm-HH:mm" или пусто. */
	time: string;
}

export class EventSeriesModal extends Modal {
	constructor(
		app: App,
		private readonly initial: EventSeriesInitial,
		private readonly titleText: string,
		private readonly onSubmit: (name: string, ruleText: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.titleText);
		const wrap = this.contentEl.createDiv({ cls: "gtd-event-edit" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "8px";

		const nameLabel = wrap.createDiv();
		nameLabel.setText("Название");
		nameLabel.style.fontSize = "var(--font-ui-smaller, 0.85em)";
		nameLabel.style.color = "var(--text-muted)";
		const nameInput = wrap.createEl("input", {
			type: "text",
			placeholder: "Название события",
			value: this.initial.name,
		});
		nameInput.style.width = "100%";

		const ruleLabel = wrap.createDiv();
		ruleLabel.setText("Правило повторения");
		ruleLabel.style.fontSize = "var(--font-ui-smaller, 0.85em)";
		ruleLabel.style.color = "var(--text-muted)";
		const ruleInput = wrap.createEl("input", {
			type: "text",
			placeholder: "every …",
			value: this.initial.rule,
		});
		ruleInput.style.width = "100%";

		const examplesEl = wrap.createDiv({ cls: "gtd-rule-examples" });
		examplesEl.createSpan({ text: "Примеры: " }).style.color = "var(--text-muted)";
		for (const ex of RULE_EXAMPLES) {
			const btn = examplesEl.createEl("button", { text: ex });
			btn.style.margin = "2px 4px 2px 0";
			btn.style.fontSize = "var(--font-ui-smaller, 0.85em)";
			btn.addEventListener("click", () => {
				ruleInput.value = ex;
				validate();
				ruleInput.focus();
			});
		}

		const timeLabel = wrap.createDiv();
		timeLabel.setText("Время (необязательно): HH:mm или HH:mm-HH:mm");
		timeLabel.style.fontSize = "var(--font-ui-smaller, 0.85em)";
		timeLabel.style.color = "var(--text-muted)";
		const timeInput = wrap.createEl("input", {
			type: "text",
			placeholder: "09:00 / 19:00-20:30",
			value: this.initial.time,
		});
		timeInput.style.width = "100%";

		const feedback = wrap.createDiv({ cls: "gtd-rule-feedback" });
		feedback.style.minHeight = "1.5em";
		feedback.style.fontSize = "var(--font-ui-smaller, 0.85em)";

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const save = footer.createEl("button", { text: "Сохранить", cls: "mod-cta" });

		/** Валидирует ИТОГОВОЕ правило (rule + время) и непустое название. */
		const validate = (): { name: string; ruleText: string } | null => {
			const name = nameInput.value.trim();
			const ruleText = joinEventRule(ruleInput.value, timeInput.value);
			const parsed = parseRule(ruleText);
			if (name === "") {
				feedback.setText("✕ укажите название");
				feedback.style.color = "var(--text-error, var(--text-muted))";
				save.disabled = true;
				return null;
			}
			if (isParseError(parsed)) {
				feedback.setText(`✕ ${parsed.error}`);
				feedback.style.color = "var(--text-error, var(--text-muted))";
				save.disabled = true;
				return null;
			}
			feedback.setText("✓ событие корректно");
			feedback.style.color = "var(--text-success, var(--text-muted))";
			save.disabled = false;
			return { name, ruleText };
		};

		const submit = (): void => {
			const res = validate();
			if (res === null) return;
			this.close();
			this.onSubmit(res.name, res.ruleText);
		};

		for (const el of [nameInput, ruleInput, timeInput]) {
			el.addEventListener("input", () => void validate());
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
			});
		}
		save.addEventListener("click", submit);

		validate();
		nameInput.focus();
		nameInput.select();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
