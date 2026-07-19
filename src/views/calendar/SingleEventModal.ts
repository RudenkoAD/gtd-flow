/**
 * Модал одноразового события календаря (§события): создание копии одноразового
 * события или вхождения серии. Компактная форма — четыре поля: название, дата,
 * время ("HH:mm[-HH:mm]"), место. В отличие от EventSeriesModal (правило 🔁) —
 * это фиксированная дата (📅). Время разбирается parseTimeRange; пустое — событие
 * «Весь день». Сохранение — колбэком (вид зовёт createSingleEvent).
 */
import { Modal, type App } from "obsidian";
import { parseTimeRange } from "./calendarLogic";

export interface SingleEventInitial {
	name: string;
	/** YYYY-MM-DD. */
	date: string;
	/** "HH:mm" / "HH:mm-HH:mm" / пусто. */
	time: string;
	/** Место/адрес 📍 (опционально; пусто — без поля). */
	location: string;
}

export class SingleEventModal extends Modal {
	constructor(
		app: App,
		private readonly initial: SingleEventInitial,
		private readonly titleText: string,
		private readonly onSubmit: (
			name: string,
			date: string,
			time: string | null,
			timeEnd: string | null,
			location: string,
		) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.titleText);
		const wrap = this.contentEl.createDiv({ cls: "gtd-event-edit" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "8px";

		const mkLabel = (text: string): void => {
			const el = wrap.createDiv();
			el.setText(text);
			el.style.fontSize = "var(--font-ui-smaller, 0.85em)";
			el.style.color = "var(--text-muted)";
		};

		mkLabel("Название");
		const nameInput = wrap.createEl("input", {
			type: "text",
			placeholder: "Название события",
			value: this.initial.name,
		});
		nameInput.style.width = "100%";

		mkLabel("Дата");
		const dateInput = wrap.createEl("input", { type: "date", value: this.initial.date });
		dateInput.required = true;
		dateInput.style.width = "100%";
		bindShowPicker(dateInput);

		mkLabel("Время (необязательно): HH:mm или HH:mm-HH:mm");
		const timeInput = wrap.createEl("input", {
			type: "text",
			placeholder: "09:00 / 19:00-20:30",
			value: this.initial.time,
		});
		timeInput.style.width = "100%";

		mkLabel("Место (необязательно)");
		const locationInput = wrap.createEl("input", {
			type: "text",
			placeholder: "Адрес или место — покажется при наведении",
			value: this.initial.location,
		});
		locationInput.style.width = "100%";

		const feedback = wrap.createDiv({ cls: "gtd-rule-feedback" });
		feedback.style.minHeight = "1.5em";
		feedback.style.fontSize = "var(--font-ui-smaller, 0.85em)";

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		const save = footer.createEl("button", { text: "Сохранить", cls: "mod-cta" });

		const fail = (msg: string): void => {
			feedback.setText(msg);
			feedback.style.color = "var(--text-error, var(--text-muted))";
			save.disabled = true;
		};

		/** Валидирует название (непустое), дату (заполнена) и формат времени
		 *  (parseTimeRange). Место — свободный текст, на валидность не влияет. */
		const validate = (): {
			name: string;
			date: string;
			time: string | null;
			timeEnd: string | null;
			location: string;
		} | null => {
			const name = nameInput.value.trim();
			const date = dateInput.value;
			const location = locationInput.value.trim();
			const parsedTime = parseTimeRange(timeInput.value);
			if (name === "") {
				fail("✕ укажите название");
				return null;
			}
			if (date === "") {
				fail("✕ укажите дату");
				return null;
			}
			if (parsedTime === null) {
				fail("✕ время в формате HH:mm или HH:mm-HH:mm");
				return null;
			}
			feedback.setText("✓ событие корректно");
			feedback.style.color = "var(--text-success, var(--text-muted))";
			save.disabled = false;
			return { name, date, time: parsedTime.time, timeEnd: parsedTime.timeEnd, location };
		};

		const submit = (): void => {
			const res = validate();
			if (res === null) return;
			this.close();
			this.onSubmit(res.name, res.date, res.time, res.timeEnd, res.location);
		};

		for (const el of [nameInput, dateInput, timeInput, locationInput]) {
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

/**
 * Клик по полю даты открывает нативный селектор (showPicker), не отключая ручной
 * ввод. showPicker кидает вне user-gesture (NotAllowedError) и может отсутствовать
 * в старых рантаймах — обёрнуто в try/catch и опциональный вызов (как DatePromptModal).
 */
function bindShowPicker(input: HTMLInputElement): void {
	input.addEventListener("click", () => {
		try {
			(input as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
		} catch {
			/* NotAllowedError / нет поддержки — молча, ручной ввод остаётся рабочим */
		}
	});
}
