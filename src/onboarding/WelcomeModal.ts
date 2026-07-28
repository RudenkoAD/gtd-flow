/**
 * Приветственный диалог онбординга (показывается один раз на чистом хранилище,
 * см. main.ts). Две ветки: создать демо-файлы или начать с чистого листа — обе
 * помечают онбординг пройденным. «Создать» дополнительно засевает демо и
 * открывает рабочее пространство.
 *
 * Импорт obsidian допустим (это UI-склейка, не сервис/ядро). Зависимости —
 * узкий порт, а не весь plugin: модал не знает про сервисы, только про действия.
 */
import { Modal, Notice, type App } from "obsidian";
import { createDemoVault, demoVaultNotice, type DemoVaultPort } from "./demoVault";
import { reportAsync, runVoidAction } from "../views/common/runAction";

export interface WelcomeDeps {
	/** Порт записи демо-файлов (VaultAdapter плагина). */
	vault: DemoVaultPort;
	/** Пометить онбординг пройденным и сохранить настройки. */
	markOnboarded: () => Promise<void>;
	/** Открыть рабочее пространство GTD и вид «Календарь». */
	openWorkspace: () => Promise<void>;
}

export class WelcomeModal extends Modal {
	/** One completion write is shared by the button path and onClose. */
	private onboarded: Promise<boolean> | null = null;

	constructor(
		app: App,
		private readonly deps: WelcomeDeps,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Добро пожаловать в GTD Flow");

		this.contentEl.createEl("p", {
			text:
				"GTD Flow — это система задач поверх обычных Markdown-файлов: входящие, " +
				"kanban-доски, календарь, отложенные, регулярные задачи и проекты-графы.",
		});
		this.contentEl.createEl("p", {
			text:
				"Демо-файлы создадут небольшой пример каждого вида (доску, проект с " +
				"зависимостями, регулярную задачу и событие), чтобы попробовать всё сразу. " +
				"Ваши остальные заметки не затрагиваются.",
		});

		const row = this.contentEl.createDiv({ cls: "modal-button-container" });

		const create = row.createEl("button", { text: "Создать демо-файлы", cls: "mod-cta" });
		create.addEventListener("click", () => {
			this.close();
			reportAsync("не удалось создать демо-файлы", () => this.onCreateDemo());
		});

		const blank = row.createEl("button", { text: "Начать с чистого листа" });
		blank.addEventListener("click", () => {
			this.close();
		});
	}

	override onClose(): void {
		// Esc/клик по фону = «онбординг пройден»: иначе диалог всплывал бы на
		// каждом запуске, пока пользователь не нажмёт кнопку. markOnboarded
		// идемпотентен — кнопка «Создать» ожидает тот же Promise до записи демо.
		reportAsync("не удалось завершить онбординг", () => this.markOnboarded());
		this.contentEl.empty();
	}

	/** Completing onboarding must precede demo writes, yet close remains idempotent. */
	private markOnboarded(): Promise<boolean> {
		this.onboarded ??= runVoidAction("не удалось завершить онбординг", () =>
			this.deps.markOnboarded(),
		);
		return this.onboarded;
	}

	private async onCreateDemo(): Promise<void> {
		// онбординг помечаем пройденным ДО записи: диалог больше не всплывёт,
		// даже если создание частично не удастся (флаг в data.json надёжнее файлов)
		if (!(await this.markOnboarded())) return;
		try {
			const report = await createDemoVault(this.deps.vault);
			new Notice(demoVaultNotice(report));
		} catch (e) {
			new Notice(`GTD Flow: не удалось создать демо-файлы: ${String(e)}`);
			return;
		}
		try {
			await this.deps.openWorkspace();
		} catch (e) {
			new Notice(`GTD Flow: не удалось открыть рабочее пространство: ${String(e)}`);
		}
	}
}
