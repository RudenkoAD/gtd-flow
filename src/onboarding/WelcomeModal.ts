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

export interface WelcomeDeps {
	/** Порт записи демо-файлов (VaultAdapter плагина). */
	vault: DemoVaultPort;
	/** Пометить онбординг пройденным и сохранить настройки. */
	markOnboarded: () => Promise<void>;
	/** Открыть рабочее пространство GTD и вид «Календарь». */
	openWorkspace: () => Promise<void>;
}

export class WelcomeModal extends Modal {
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
			void this.onCreateDemo();
		});

		const blank = row.createEl("button", { text: "Начать с чистого листа" });
		blank.addEventListener("click", () => {
			this.close();
			void this.deps.markOnboarded();
		});
	}

	override onClose(): void {
		// Esc/клик по фону = «онбординг пройден»: иначе диалог всплывал бы на
		// каждом запуске, пока пользователь не нажмёт кнопку. markOnboarded
		// идемпотентен — после веток кнопок повторный вызов безвреден.
		void this.deps.markOnboarded();
		this.contentEl.empty();
	}

	private async onCreateDemo(): Promise<void> {
		// онбординг помечаем пройденным ДО записи: диалог больше не всплывёт,
		// даже если создание частично не удастся (флаг в data.json надёжнее файлов)
		await this.deps.markOnboarded();
		try {
			const report = await createDemoVault(this.deps.vault);
			new Notice(demoVaultNotice(report));
		} catch (e) {
			new Notice(`GTD Flow: не удалось создать демо-файлы: ${String(e)}`);
			return;
		}
		await this.deps.openWorkspace();
	}
}
