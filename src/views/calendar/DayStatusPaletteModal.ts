/**
 * Модал «Палитра статусов дней» (пробел C2): визуальная правка frontmatter-карты
 * `statuses` файла gtd-day-status. Список строк «цвет + имя + удалить», внизу
 * кнопки «＋ Статус» и «Сохранить». Сохранение применяет diff к текущей палитре
 * через DayStatusPort.setStatusDef/removeStatusDef.
 *
 * Переименование = удалить старое имя + записать новое. Назначения дней в теле
 * файла ссылаются на ИМЯ статуса, поэтому при переименовании показываем
 * предупреждение (mod-warning): старые назначения перестанут краситься, пока их
 * не перепривязать к новому имени.
 */
import { Modal, setIcon, type App } from "obsidian";
import { reportAsync } from "../common/runAction";

/** Узкий порт правки палитры (структурно удовлетворяется DayStatusPort). */
export interface DayStatusPalettePort {
	statuses: () => { name: string; color: string }[];
	setStatusDef: (name: string, color: string) => Promise<void>;
	removeStatusDef: (name: string) => Promise<void>;
}

const DEFAULT_COLOR = "#4c8bf5";

/** Значение для <input type=color>: только #rrggbb; #rgb расширяется, иначе дефолт. */
function toColorInputValue(color: string): string {
	const c = color.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(c)) return c;
	if (/^#[0-9a-f]{3}$/.test(c)) return "#" + [...c.slice(1)].map((ch) => ch + ch).join("");
	return DEFAULT_COLOR;
}

interface PaletteRow {
	/** Имя при открытии модала; null — строка добавлена пользователем. */
	origName: string | null;
	nameInput: HTMLInputElement;
	colorInput: HTMLInputElement;
}

export class DayStatusPaletteModal extends Modal {
	private rows: PaletteRow[] = [];
	private snapshot: { name: string; color: string }[] = [];

	constructor(
		app: App,
		private readonly port: DayStatusPalettePort,
	) {
		super(app);
	}

	override onOpen(): void {
		this.snapshot = this.port.statuses();
		this.titleEl.setText("Палитра статусов дней");

		const wrap = this.contentEl.createDiv({ cls: "gtd-ds-palette" });
		wrap.style.display = "flex";
		wrap.style.flexDirection = "column";
		wrap.style.gap = "8px";

		const hint = wrap.createDiv();
		hint.setText("Цвет и имя каждого статуса. Имя используется в назначениях дней.");
		hint.style.fontSize = "var(--font-ui-smaller, 0.85em)";
		hint.style.color = "var(--text-muted)";

		const list = wrap.createDiv({ cls: "gtd-ds-palette-list" });
		list.style.display = "flex";
		list.style.flexDirection = "column";
		list.style.gap = "6px";

		const warning = wrap.createDiv({ cls: "mod-warning" });
		warning.style.minHeight = "1.5em";
		warning.style.fontSize = "var(--font-ui-smaller, 0.85em)";
		warning.style.display = "none";

		const refreshWarning = (): void => {
			const renamed = this.rows
				.filter((r) => {
					const name = r.nameInput.value.trim();
					return r.origName !== null && name !== "" && name !== r.origName;
				})
				.map((r) => r.origName)
				.filter((n): n is string => n !== null);
			if (renamed.length === 0) {
				warning.style.display = "none";
				warning.setText("");
				return;
			}
			warning.style.display = "";
			warning.setText(
				`⚠ Переименование (${renamed.join(", ")}): назначения дней в файле ссылаются на старое имя и перестанут краситься, пока вы не перепривяжете их к новому имени.`,
			);
		};

		const addRow = (name: string, color: string, origName: string | null): PaletteRow => {
			const row = list.createDiv({ cls: "gtd-ds-palette-row" });
			row.style.display = "flex";
			row.style.alignItems = "center";
			row.style.gap = "8px";

			const colorInput = row.createEl("input", { type: "color" });
			colorInput.value = toColorInputValue(color);

			const nameInput = row.createEl("input", { type: "text", value: name });
			nameInput.placeholder = "Имя статуса";
			nameInput.style.flex = "1";

			const del = row.createEl("button", { attr: { "aria-label": "Удалить статус" } });
			setIcon(del, "trash-2");

			const entry: PaletteRow = { origName, nameInput, colorInput };
			this.rows.push(entry);

			nameInput.addEventListener("input", () => refreshWarning());
			del.addEventListener("click", () => {
				this.rows = this.rows.filter((r) => r !== entry);
				row.remove();
				refreshWarning();
			});
			return entry;
		};

		for (const s of this.snapshot) addRow(s.name, s.color, s.name);

		const footer = wrap.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "space-between";
		footer.style.gap = "8px";
		footer.style.marginTop = "4px";

		const addBtn = footer.createEl("button", { text: "＋ Статус" });
		addBtn.addEventListener("click", () => {
			const entry = addRow("", DEFAULT_COLOR, null);
			refreshWarning();
			entry.nameInput.focus();
		});

		const save = footer.createEl("button", { text: "Сохранить", cls: "mod-cta" });
		save.addEventListener("click", () =>
			reportAsync("сохранение палитры статусов дней", () => this.apply()),
		);

		refreshWarning();
	}

	/** Применить diff текущих строк к палитре через порт (минимум записей). */
	private async apply(): Promise<void> {
		const original = new Map(this.snapshot.map((s) => [s.name, s.color] as const));
		const finalRows = this.rows
			.map((r) => ({ name: r.nameInput.value.trim(), color: r.colorInput.value.trim() }))
			.filter((r) => r.name !== "");
		const finalNames = new Set(finalRows.map((r) => r.name));

		// Удалить исходные имена, исчезнувшие из списка (удаление строки или переименование).
		for (const name of original.keys()) {
			if (!finalNames.has(name)) await this.port.removeStatusDef(name);
		}
		// Upsert новых и изменивших цвет статусов.
		for (const { name, color } of finalRows) {
			if (original.get(name) !== color) await this.port.setStatusDef(name, color);
		}
		this.close();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.rows = [];
	}
}
