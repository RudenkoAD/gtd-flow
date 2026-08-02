import { Modal, Notice, type App } from "obsidian";
import { formatDuration, INTENSITY_ANCHORS } from "../../core/estimates/format";
import { isDurationMinutes, type IsoDate, type Priority, type Task } from "../../core/model/Task";
import { activeScopes, type ScopeCatalog } from "../../core/scope/scope";
import type { IntentResult } from "../../services/WritebackService";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "./cardFormat";
import {
	taskDetailsChangesFromDraft,
	taskDetailsDraftFromTask,
	type TaskDetailsChanges,
	type TaskDetailsDraft,
} from "./taskDetails";
import type { MetadataEditorField } from "./taskMetadata";

export type TaskDetailsFocus = "description" | MetadataEditorField;

export interface TaskDetailsModalOptions {
	focus?: TaskDetailsFocus;
	readOnly?: boolean;
}

type FormControl = HTMLInputElement | HTMLSelectElement;

interface DateTimeControls {
	date: HTMLInputElement;
	timeRange: HTMLInputElement;
}

const DATE_FIELD_LABELS: Record<"due" | "scheduled" | "start", string> = {
	due: "Срок",
	scheduled: "Запланированная дата",
	start: "Дата отложения",
};

function validationErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	switch (message) {
		case "title must not be empty":
			return "Укажите название задачи.";
		case "due and start dates cannot coexist":
			return "Срок и дата отложения не могут быть заданы одновременно.";
		case "scope must be active":
			return "Выберите активный scope.";
		case "duration must use five-minute sub-day or whole-day increments":
			return "До 24 часов длительность должна делиться на 5 минут, а затем — на целые сутки.";
		case "intensity must be an integer from 0 to 5":
			return "Интенсивность должна быть целым числом от 0 до 5.";
	}
	for (const [field, label] of Object.entries(DATE_FIELD_LABELS)) {
		if (message === `${field} time requires a date`) return `${label}: сначала укажите дату.`;
		if (message === `${field} must be a real ISO date`)
			return `${label}: укажите корректную дату.`;
		if (message === `${field} time must use HH:mm or HH:mm-HH:mm`)
			return `${label}: время должно иметь формат HH:mm или HH:mm-HH:mm.`;
		if (message === `${field} time range must end after it starts`)
			return `${label}: время окончания должно быть позже времени начала.`;
	}
	return message;
}

function saveErrorText(reason: string): string {
	switch (reason) {
		case "scope-not-active":
			return "Выбранный scope больше не активен. Выберите другой scope и повторите сохранение.";
		default:
			return reason;
	}
}

/** Full task editor. Persistence stays behind a caller-owned atomic port. */
export class TaskDetailsModal extends Modal {
	private savePending = false;

	constructor(
		app: App,
		private readonly task: Task,
		private readonly today: IsoDate,
		private readonly catalog: ScopeCatalog,
		private readonly onSubmit: (changes: TaskDetailsChanges) => Promise<IntentResult>,
		private readonly options: TaskDetailsModalOptions = {},
	) {
		super(app);
	}

	override onOpen(): void {
		this.savePending = false;
		this.titleEl.setText("Задача");
		this.modalEl.classList.add("gtd-task-details-modal");
		this.modalEl.style.maxWidth = "min(42rem, calc(100vw - 16px))";
		const initial = taskDetailsDraftFromTask(this.task);
		const readOnly = this.task.external === true || this.options.readOnly === true;
		const controls: FormControl[] = [];
		const form = this.contentEl.createEl("form", { cls: "gtd-task-details" });
		form.style.display = "grid";
		form.style.gap = "12px";
		form.style.minWidth = "0";
		form.style.maxWidth = "100%";
		form.style.overflowX = "hidden";
		form.style.paddingBottom = "max(12px, env(safe-area-inset-bottom))";

		if (readOnly) {
			form.createDiv({
				cls: "setting-item-description mod-warning",
				text: "Эта задача доступна только для чтения: её источник управляется внешним календарём.",
			});
		}

		const main = this.addSection(form, "Основное");
		const description = this.addTextField(
			main,
			"gtd-task-details-description",
			"Название",
			initial.description,
			controls,
		);
		const completed = this.addCheckboxField(
			main,
			"gtd-task-details-completed",
			"Выполнено",
			initial.completed,
			controls,
		);
		const priority = this.addSelectField(
			main,
			"gtd-task-details-priority",
			"Приоритет",
			PRIORITY_ORDER.map((value) => ({ value, label: PRIORITY_LABELS[value] })),
			initial.priority,
			controls,
		);

		const dates = this.addSection(form, "Даты и место");
		const due = this.addDateTimeField(dates, "due", "📅 Срок", initial.due, controls);
		const scheduled = this.addDateTimeField(
			dates,
			"scheduled",
			"⏳ Запланировано",
			initial.scheduled,
			controls,
		);
		const start = this.addDateTimeField(
			dates,
			"start",
			"🛫 Отложено до",
			initial.start,
			controls,
		);
		const location = this.addTextField(
			dates,
			"gtd-task-details-location",
			"📍 Место",
			initial.location,
			controls,
			"Адрес или место (необязательно)",
		);

		const estimates = this.addSection(form, "Оценка и scope");
		const durationRow = this.addFieldRow(estimates);
		const durationId = "gtd-task-details-duration";
		durationRow.createEl("label", {
			text: "⏱ Длительность, минуты",
			attr: { for: durationId },
		});
		const duration = durationRow.createEl("input", {
			type: "number",
			value: initial.metadata.durationMinutes,
			attr: { id: durationId, min: "5", step: "5", inputmode: "numeric" },
		});
		this.styleEditorControl(duration);
		controls.push(duration);
		const durationPreview = durationRow.createDiv({ cls: "setting-item-description" });

		const cognitive = this.addIntensityField(
			estimates,
			"cognitive",
			"🧠 Когнитивная нагрузка",
			initial.metadata.cognitiveIntensity,
			controls,
		);
		const emotional = this.addIntensityField(
			estimates,
			"emotional",
			"💓 Эмоциональная нагрузка",
			initial.metadata.emotionalIntensity,
			controls,
		);
		const physical = this.addIntensityField(
			estimates,
			"physical",
			"💪 Физическая нагрузка",
			initial.metadata.physicalIntensity,
			controls,
		);
		const scope = this.addScopeField(estimates, initial.metadata.scopeId, controls);

		const info = this.addSection(form, "Сведения");
		this.addInfoRow(info, "Файл", this.task.filePath);
		this.addInfoRow(info, "Заголовок", this.task.heading ?? "—");
		this.addInfoRow(info, "ID", this.task.taskId ?? "—");
		this.addInfoRow(info, "Повторение", this.task.recurrence ?? "—");
		this.addInfoRow(
			info,
			"Зависимости",
			this.task.dependsOn.length > 0 ? this.task.dependsOn.join(", ") : "—",
		);

		const feedback = form.createDiv({ cls: "setting-item-description" });
		feedback.setAttribute("role", "status");
		feedback.setAttribute("aria-live", "polite");
		feedback.style.minHeight = "1.5em";
		feedback.style.overflowWrap = "anywhere";

		const footer = form.createDiv({ cls: "modal-button-container" });
		footer.style.position = "sticky";
		footer.style.bottom = "0";
		footer.style.zIndex = "1";
		footer.style.display = "grid";
		footer.style.gridTemplateColumns = readOnly
			? "minmax(0, 1fr)"
			: "repeat(2, minmax(0, 1fr))";
		footer.style.gap = "8px";
		footer.style.margin = "0";
		footer.style.padding = "8px 0 max(4px, env(safe-area-inset-bottom))";
		footer.style.background = "var(--background-primary)";
		const cancel = footer.createEl("button", {
			text: readOnly ? "Закрыть" : "Отмена",
			attr: { type: "button" },
		});
		const save = footer.createEl("button", {
			text: "Сохранить",
			cls: "mod-cta",
			attr: { type: "submit" },
		});
		for (const button of [cancel, save]) {
			button.style.minWidth = "0";
			button.style.minHeight = "44px";
			button.style.whiteSpace = "normal";
		}
		save.disabled = readOnly;
		if (readOnly) save.style.display = "none";

		let validChanges: TaskDetailsChanges | null = null;

		const draftFromControls = (): TaskDetailsDraft => ({
			description: description.value,
			completed: completed.checked,
			priority: priority.value as Priority,
			due: { date: due.date.value, timeRange: due.timeRange.value },
			scheduled: { date: scheduled.date.value, timeRange: scheduled.timeRange.value },
			start: { date: start.date.value, timeRange: start.timeRange.value },
			location: location.value,
			metadata: {
				durationMinutes: duration.value,
				cognitiveIntensity: cognitive.value,
				emotionalIntensity: emotional.value,
				physicalIntensity: physical.value,
				scopeId: scope.value,
			},
		});

		const setFeedback = (message: string, error = false): void => {
			feedback.setText(message);
			feedback.setAttribute("role", error ? "alert" : "status");
			feedback.setAttribute("aria-live", error ? "assertive" : "polite");
			feedback.style.color = error
				? "var(--text-error, var(--text-muted))"
				: "var(--text-muted)";
		};

		const refreshDurationPreview = (): void => {
			const raw = duration.value.trim();
			if (raw === "") {
				durationPreview.setText("Не задана");
				return;
			}
			const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
			durationPreview.setText(
				isDurationMinutes(value)
					? `Отображение: ${formatDuration(value)}`
					: "До 24 часов — шаг 5 минут; начиная с 24 часов — только целые сутки.",
			);
		};

		const validate = (): TaskDetailsChanges | null => {
			refreshDurationPreview();
			if (readOnly) return null;
			try {
				const changes = taskDetailsChangesFromDraft(
					this.task,
					draftFromControls(),
					this.today,
					this.catalog,
				);
				validChanges = changes;
				if (!this.savePending) {
					save.disabled = false;
					setFeedback("");
				}
				return changes;
			} catch (error) {
				validChanges = null;
				save.disabled = true;
				setFeedback(validationErrorText(error), true);
				return null;
			}
		};

		const submit = async (): Promise<void> => {
			if (readOnly || this.savePending) return;
			const changes = validate();
			if (changes === null) return;
			const noChanges =
				changes.ordinaryIntents.length === 0 &&
				Object.keys(changes.metadataPatch).length === 0;
			if (noChanges) {
				this.close();
				return;
			}

			this.savePending = true;
			for (const control of controls) control.disabled = true;
			save.disabled = true;
			cancel.disabled = true;
			setFeedback("Сохранение…");
			try {
				const result = await this.onSubmit(changes);
				if (result.ok) {
					this.savePending = false;
					this.close();
					return;
				}
				if (result.reason === "metadata-saved-but-feedback-write-failed") {
					new Notice(
						"GTD Flow: задача сохранена, но истории обучения требуется восстановление.",
					);
					this.savePending = false;
					this.close();
					return;
				}
				setFeedback(`Не удалось сохранить: ${saveErrorText(result.reason)}`, true);
			} catch (error) {
				setFeedback(
					`Не удалось сохранить: ${error instanceof Error ? error.message : String(error)}`,
					true,
				);
			}
			this.savePending = false;
			for (const control of controls) control.disabled = readOnly;
			cancel.disabled = false;
			save.disabled = validChanges === null;
		};

		const dateInputs = new Map<FormControl, HTMLInputElement>([
			[due.date, due.timeRange],
			[scheduled.date, scheduled.timeRange],
			[start.date, start.timeRange],
		]);
		for (const control of controls) {
			control.disabled = readOnly;
			const handleChange = (): void => {
				const timeRange = dateInputs.get(control);
				if (timeRange !== undefined && control.value === "") timeRange.value = "";
				validate();
			};
			control.addEventListener("input", handleChange);
			control.addEventListener("change", handleChange);
		}
		cancel.addEventListener("click", () => {
			if (!this.savePending) this.close();
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void submit();
		});
		form.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.savePending) {
				event.preventDefault();
				event.stopPropagation();
			}
		});

		validate();
		if (readOnly) {
			cancel.focus();
		} else {
			const focus: Record<TaskDetailsFocus, FormControl> = {
				description,
				duration,
				cognitive,
				emotional,
				physical,
				scope,
			};
			focus[this.options.focus ?? "description"].focus();
		}
	}

	/** Obsidian's chrome/backdrop also calls close(); keep an in-flight draft visible. */
	override close(): void {
		if (this.savePending) return;
		super.close();
	}

	override onClose(): void {
		this.savePending = false;
		this.contentEl.empty();
	}

	private addSection(parent: HTMLElement, title: string): HTMLFieldSetElement {
		const fieldset = parent.createEl("fieldset");
		fieldset.style.display = "grid";
		fieldset.style.gap = "8px";
		fieldset.style.margin = "0";
		fieldset.style.padding = "10px";
		fieldset.style.border = "1px solid var(--background-modifier-border)";
		fieldset.style.borderRadius = "var(--radius-m, 8px)";
		fieldset.style.minWidth = "0";
		fieldset.createEl("legend", { text: title });
		return fieldset;
	}

	private addFieldRow(parent: HTMLElement): HTMLDivElement {
		const row = parent.createDiv();
		row.style.display = "grid";
		row.style.gap = "4px";
		row.style.minWidth = "0";
		return row;
	}

	private addTextField(
		parent: HTMLElement,
		id: string,
		label: string,
		value: string,
		controls: FormControl[],
		placeholder = "",
	): HTMLInputElement {
		const row = this.addFieldRow(parent);
		row.createEl("label", { text: label, attr: { for: id } });
		const input = row.createEl("input", {
			type: "text",
			value,
			placeholder,
			attr: { id },
		});
		input.style.width = "100%";
		this.styleEditorControl(input);
		controls.push(input);
		return input;
	}

	private addCheckboxField(
		parent: HTMLElement,
		id: string,
		label: string,
		checked: boolean,
		controls: FormControl[],
	): HTMLInputElement {
		const row = parent.createDiv();
		row.style.display = "flex";
		row.style.alignItems = "center";
		row.style.gap = "8px";
		row.style.minHeight = "44px";
		const input = row.createEl("input", { type: "checkbox", attr: { id } });
		input.checked = checked;
		input.style.width = "24px";
		input.style.height = "24px";
		input.style.flex = "none";
		row.createEl("label", { text: label, attr: { for: id } });
		controls.push(input);
		return input;
	}

	private addSelectField(
		parent: HTMLElement,
		id: string,
		label: string,
		options: readonly { value: string; label: string }[],
		value: string,
		controls: FormControl[],
	): HTMLSelectElement {
		const row = this.addFieldRow(parent);
		row.createEl("label", { text: label, attr: { for: id } });
		const select = row.createEl("select", { attr: { id } });
		for (const option of options) {
			select.createEl("option", { value: option.value, text: option.label });
		}
		select.value = value;
		this.styleEditorControl(select);
		controls.push(select);
		return select;
	}

	private addDateTimeField(
		parent: HTMLElement,
		field: "due" | "scheduled" | "start",
		label: string,
		value: { date: string; timeRange: string },
		controls: FormControl[],
	): DateTimeControls {
		const row = this.addFieldRow(parent);
		const dateId = `gtd-task-details-${field}-date`;
		const timeId = `gtd-task-details-${field}-time`;
		row.createEl("label", { text: label, attr: { for: dateId } });
		const pair = row.createDiv();
		pair.style.display = "grid";
		pair.style.gridTemplateColumns = "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))";
		pair.style.gap = "8px";
		pair.style.minWidth = "0";
		const date = pair.createEl("input", {
			type: "date",
			value: value.date,
			attr: { id: dateId },
		});
		const timeRange = pair.createEl("input", {
			type: "text",
			value: value.timeRange,
			placeholder: "HH:mm или HH:mm-HH:mm",
			attr: { id: timeId, "aria-label": `${label}: время` },
		});
		this.styleEditorControl(date);
		this.styleEditorControl(timeRange);
		this.bindShowPicker(date);
		controls.push(date, timeRange);
		return { date, timeRange };
	}

	private addIntensityField(
		parent: HTMLElement,
		field: "cognitive" | "emotional" | "physical",
		label: string,
		value: string,
		controls: FormControl[],
	): HTMLSelectElement {
		const options = [{ value: "", label: "Не задано" }];
		for (let level = 0; level <= 5; level++) {
			options.push({
				value: String(level),
				label: `${level} — ${INTENSITY_ANCHORS[field][level as 0 | 1 | 2 | 3 | 4 | 5]}`,
			});
		}
		return this.addSelectField(
			parent,
			`gtd-task-details-${field}`,
			label,
			options,
			value,
			controls,
		);
	}

	private addScopeField(
		parent: HTMLElement,
		value: string,
		controls: FormControl[],
	): HTMLSelectElement {
		const active = activeScopes(this.catalog);
		const options = [
			{ value: "", label: "Не задан" },
			...active.map((scope) => ({ value: scope.id, label: scope.name })),
		];
		if (value !== "" && !active.some((scope) => scope.id === value)) {
			options.push({ value, label: `${value} (недоступен)` });
		}
		return this.addSelectField(
			parent,
			"gtd-task-details-scope",
			"🧭 Scope",
			options,
			value,
			controls,
		);
	}

	private addInfoRow(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv();
		row.style.display = "grid";
		row.style.gridTemplateColumns = "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))";
		row.style.gap = "8px";
		row.style.minWidth = "0";
		row.createEl("span", { text: label }).style.color = "var(--text-muted)";
		const data = row.createEl("span", { text: value });
		data.style.overflowWrap = "anywhere";
	}

	private styleEditorControl(control: FormControl): void {
		control.style.width = "100%";
		control.style.minWidth = "0";
		control.style.minHeight = "44px";
		// Prevent mobile Chromium/WebView from zooming the viewport while editing.
		control.style.fontSize = "max(16px, 1em)";
	}

	private bindShowPicker(input: HTMLInputElement): void {
		input.addEventListener("click", () => {
			try {
				(input as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
			} catch {
				// Старый Electron или вызов вне user gesture: ручной ввод остаётся доступен.
			}
		});
	}
}
