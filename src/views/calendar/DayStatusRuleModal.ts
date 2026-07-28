/**
 * Модал «Повторяющееся правило…» покраски дней: поле правила с живой валидацией
 * через core-грамматику (parseRule при каждом вводе) + select статуса из палитры
 * файла gtd-day-status. Кнопка «Покрасить» дизейблится при невалидном правиле и
 * дописывает `<ruleText>: <status>` в тело файла через DayStatusPort.addRecurring.
 *
 * Правило НЕ зависит от кликнутой даты — красит все совпадающие дни. Валидация
 * живёт здесь (ядро строку правила не проверяет). По образцу RuleEditModal, но с
 * добавленным выбором статуса; сам RuleEditModal не трогаем.
 */
import { Modal, Notice, type App } from "obsidian";
import { isParseError, parseRule } from "../../core/recurrence/grammar";
import { reportAsync } from "../common/runAction";

/** Примеры-подсказки правил именно для покраски дней; клик подставляет пример. */
export const DAY_RULE_EXAMPLES: readonly string[] = [
	"every week on saturday,sunday",
	"every month on the 1st",
	"every 2 weeks on mon, thu",
	"every year on april 1",
];

/** Узкий порт для модала (структурно удовлетворяется DayStatusPort). */
export interface DayStatusRulePort {
	statuses: () => { name: string; color: string }[];
	ensureConfig: () => Promise<void>;
	addRecurring: (ruleText: string, status: string) => Promise<void>;
}

export class DayStatusRuleModal extends Modal {
	constructor(
		app: App,
		private readonly port: DayStatusRulePort,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Повторяющееся правило покраски");
		const wrap = this.contentEl.createDiv({ cls: "gtd-ds-rule" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "8px";

		const input = wrap.createEl("input", { type: "text", placeholder: "every …" });
		input.style.width = "100%";

		const feedback = wrap.createDiv({ cls: "gtd-rule-feedback" });
		feedback.style.minHeight = "1.5em";
		feedback.style.fontSize = "var(--font-ui-smaller, 0.85em)";

		const examplesEl = wrap.createDiv({ cls: "gtd-rule-examples" });
		examplesEl.createSpan({ text: "Примеры: " }).style.color = "var(--text-muted)";
		for (const ex of DAY_RULE_EXAMPLES) {
			const btn = examplesEl.createEl("button", { text: ex });
			btn.style.margin = "2px 4px 2px 0";
			btn.style.fontSize = "var(--font-ui-smaller, 0.85em)";
			btn.addEventListener("click", () => {
				input.value = ex;
				validate();
				input.focus();
			});
		}

		const statusRow = wrap.createDiv();
		statusRow.style.display = "flex";
		statusRow.style.alignItems = "center";
		statusRow.style.gap = "8px";
		statusRow.createSpan({ text: "Статус:" }).style.color = "var(--text-muted)";
		const statusSelect = statusRow.createEl("select");
		statusSelect.style.flex = "1";

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const paint = footer.createEl("button", { text: "Покрасить", cls: "mod-cta" });

		const ruleValid = (): boolean => !isParseError(parseRule(input.value));

		const refreshPaintEnabled = (): void => {
			paint.disabled = !ruleValid() || statusSelect.options.length === 0;
		};

		const validate = (): void => {
			const parsed = parseRule(input.value);
			if (isParseError(parsed)) {
				feedback.setText(`✕ ${parsed.error}`);
				feedback.style.color = "var(--text-error, var(--text-muted))";
			} else {
				feedback.setText("✓ правило корректно");
				feedback.style.color = "var(--text-success, var(--text-muted))";
			}
			refreshPaintEnabled();
		};

		const fillStatuses = (): void => {
			statusSelect.empty();
			for (const s of this.port.statuses()) {
				statusSelect.createEl("option", { text: s.name, value: s.name });
			}
			refreshPaintEnabled();
		};

		const submit = (): void => {
			if (!ruleValid()) return;
			const status = statusSelect.value;
			if (status === "") return;
			const rule = input.value.trim();
			this.close();
			reportAsync("добавление правила статусов дней", async () => {
				await this.port.addRecurring(rule, status);
				new Notice(`Правило добавлено: ${rule} → ${status}`);
			});
		};

		input.addEventListener("input", () => validate());
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		paint.addEventListener("click", submit);

		// Статусы нужны для select: если палитры ещё нет — создаём файл со стартовой.
		reportAsync("подготовка статусов дней", async () => {
			if (this.port.statuses().length === 0) await this.port.ensureConfig();
			fillStatuses();
		});

		validate();
		input.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
