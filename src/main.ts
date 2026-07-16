import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_META, VIEW_TYPES, type GtdViewKind } from "./views/registry";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "./settings/Settings";
import { mergeSettings } from "./settings/mergeSettings";
import { GtdSettingsTab } from "./settings/SettingsTab";
import { MetadataAdapter } from "./adapters/MetadataAdapter";
import { VaultAdapter } from "./adapters/VaultAdapter";
import { ObsidianClock } from "./adapters/ObsidianClock";
import { IndexerService } from "./services/IndexerService";
import { WritebackService } from "./services/WritebackService";
import { BoardService } from "./services/BoardService";
import { RecurrenceService } from "./services/RecurrenceService";
import { ProjectService } from "./services/ProjectService";
import { CardService } from "./services/CardService";
import { DayStatusService } from "./services/DayStatusService";
import { registerCommands } from "./commands";
import { createTaskStore, type TaskStore } from "./stores/taskStore";
import { createGtdView } from "./views/createView";
import { DndService } from "./views/dnd/DndService";
import { createDemoVault, demoVaultNotice } from "./onboarding/demoVault";
import { WelcomeModal } from "./onboarding/WelcomeModal";
import { ensureCaptureFile } from "./views/common/taskActions";

export default class GtdFlowPlugin extends Plugin {
	settings: GtdFlowSettings = DEFAULT_SETTINGS;
	indexer!: IndexerService;
	vaultAdapter!: VaultAdapter;
	taskStore!: TaskStore;
	dispatcher!: WritebackService;
	boards!: BoardService;
	dnd!: DndService;
	recurrence!: RecurrenceService;
	projects!: ProjectService;
	cards!: CardService;
	dayStatus!: DayStatusService;
	private indexReadyFlag = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		const metadata = new MetadataAdapter(this);
		// Гейт ленивого frontmatter-индекса: до резолва metadataCache он построился
		// бы ПУСТЫМ и закэшировался навсегда (см. память проекта). Восстановленная
		// раскладка монтирует виды на layout-ready — их discovery может обогнать
		// resolve, поэтому containerPaths до готовности отдаёт [] без побочек.
		let fmIndexReady = false;
		const clock = new ObsidianClock(this);
		this.vaultAdapter = new VaultAdapter(this.app);
		this.indexer = new IndexerService({
			events: metadata,
			clock,
			initialScan: () => metadata.initialScan(),
			debounceMs: this.settings.debounceMs.fileReindex,
			// Первый spawn-проход регулярных — строго после полной сборки индекса (ТЗ §6).
			onReady: () => {
				this.indexReadyFlag = true;
				void this.recurrence.runPass();
			},
		});
		this.taskStore = createTaskStore(this.indexer);
		this.dispatcher = new WritebackService({
			write: this.vaultAdapter,
			feed: this.indexer,
			autoInjectId: this.settings.autoInjectId,
		});
		this.boards = new BoardService({
			feed: this.indexer,
			readFrontmatter: (path) => metadata.frontmatter(path),
			patchFrontmatter: async (path, fn) => {
				await this.vaultAdapter.processFrontmatter(path, fn);
			},
			dispatcher: this.dispatcher,
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
			containerPaths: () =>
				fmIndexReady ? metadata.pathsByFrontmatterValue("gtd-board", true) : [],
			knownTaskId: (key) => this.dispatcher.knownTaskId(key),
		});
		this.dnd = new DndService(this);
		this.recurrence = new RecurrenceService({
			feed: this.indexer,
			write: this.vaultAdapter,
			dispatcher: this.dispatcher,
			settings: () => this.settings.recurring,
			todayIso: () => clock.todayIso(),
			indexReady: () => this.indexReadyFlag,
			// spawnTarget — цель захвата: помечаем gtd-inbox (идемпотентно), иначе
			// при скоупе входящих «только GTD-файлы» копии регулярных стали бы
			// невидимы во входящих (ensureFile создал бы файл без флага)
			ensureFile: async (path) => {
				await ensureCaptureFile(this.vaultAdapter, path);
			},
		});
		clock.onDayRollover(() => void this.recurrence.runPass());
		this.projects = new ProjectService({
			feed: this.indexer,
			write: this.vaultAdapter,
			readFrontmatter: (path) => metadata.frontmatter(path),
			patchFrontmatter: async (path, fn) => {
				await this.vaultAdapter.processFrontmatter(path, fn);
			},
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
			containerPaths: () =>
				fmIndexReady ? metadata.pathsByFrontmatterValue("gtd-project", true) : [],
			dispatcher: this.dispatcher,
			todayIso: () => clock.todayIso(),
		});
		this.cards = new CardService({
			feed: this.indexer,
			write: this.vaultAdapter,
			dispatcher: this.dispatcher,
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
			settings: () => ({
				cardsFolder: this.settings.cardsFolder,
				cardLinkInLine: this.settings.cardLinkInLine,
			}),
			openFile: async (path) => {
				const file = this.app.vault.getFileByPath(path);
				if (file !== null) await this.app.workspace.getLeaf(true).openFile(file);
			},
			findCardFile: (taskId) => metadata.findByFrontmatterValue("gtd-card-of", taskId),
		});
		this.dayStatus = new DayStatusService({
			discoverFile: () => metadata.findByFrontmatterValue("gtd-day-status", true),
			readFrontmatter: (path) => metadata.frontmatter(path),
			readFile: (path) => this.vaultAdapter.readFile(path),
			processFile: (path, transform) => this.vaultAdapter.processFile(path, transform),
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
			processFrontmatter: async (path, fn) => {
				await this.vaultAdapter.processFrontmatter(path, fn);
			},
			defaultFilePath: () => this.settings.dayStatusFile,
			onVaultChange: (cb) => {
				// после полного резолва кэша (в т.ч. первого после старта/перезагрузки)
				// — файл статусов уже обнаружим по frontmatter-флагу
				this.registerEvent(this.app.metadataCache.on("resolved", () => cb()));
				// refresh когда меняется сам файл статусов или файл с флагом
				this.registerEvent(
					this.app.metadataCache.on("changed", (file, _data, cache) => {
						if (cache?.frontmatter?.["gtd-day-status"] === true || file.path === this.dayStatus.filePath())
							cb();
					}),
				);
				this.registerEvent(
					this.app.vault.on("delete", (file) => {
						if (file.path === this.dayStatus.filePath()) cb();
					}),
				);
				this.registerEvent(this.app.vault.on("rename", () => cb()));
			},
		});
		this.dayStatus.start();
		registerCommands(this);
		this.addSettingTab(new GtdSettingsTab(this.app, this));
		// Первичная сборка — вне критического пути старта, строго после
		// onLayoutReady И полного resolve кэша метаданных (ТЗ §2): до resolve
		// getFileCache пуст, снапшоты вышли бы без задач и с неверным контекстом,
		// а гейт регулярных (§6) открылся бы на заведомо неполном индексе.
		// Подписка на 'resolved' — прямо в onload: на тёплом старте resolve может
		// завершиться раньше layout-ready, и события до следующей правки не будет.
		const layoutReady = new Promise<void>((res) => this.app.workspace.onLayoutReady(res));
		const cacheResolved = new Promise<void>((res) => metadata.onResolved(res));
		void Promise.all([layoutReady, cacheResolved]).then(() => {
			// с этого момента ленивому fm-индексу можно доверять (кэш зарезолвлен)
			fmIndexReady = true;
			// первичный refresh статусов дней — строго после резолва кэша (иначе
			// findByFrontmatterValue закэширует пустой обратный индекс, см. start())
			void this.dayStatus.refresh();
			// онбординг — тоже строго после резолва кэша: обратный fm-индекс уже полон,
			// иначе «чистое хранилище» ложно определилось бы на пустом кэше
			this.maybeOnboard(metadata);
			// .catch: rejection скана не должен пропадать беззвучно
			return this.indexer.start().catch((e: unknown) => console.error("GTD Flow: сбой первичной сборки индекса", e));
		});

		for (const meta of Object.values(VIEW_META)) {
			this.registerView(meta.type, (leaf) => createGtdView(leaf, this, meta));
		}

		for (const meta of Object.values(VIEW_META)) {
			this.addCommand({
				id: `open-${meta.kind}`,
				name: `Открыть: ${meta.displayText.replace(/^GTD: /, "")}`,
				callback: () => void this.activateView(meta.kind),
			});
		}

		this.addCommand({
			id: "open-workspace",
			name: "Открыть рабочее пространство GTD",
			callback: () => void this.openGtdWorkspace(),
		});

		// Демо-файлы доступны всегда (не только на первом запуске): удобно, если
		// пользователь пропустил приветственный диалог или хочет пересоздать пример.
		this.addCommand({
			id: "create-demo-vault",
			name: "Создать демо-файлы GTD",
			callback: () => void this.runCreateDemoVault(),
		});

		// Ярлыки всех видов в ленте; порядок — как в VIEW_META (регистрация задаёт
		// порядок иконок, пользователь может скрыть лишние через контекстное меню ленты).
		for (const meta of Object.values(VIEW_META)) {
			this.addRibbonIcon(meta.icon, meta.displayText, () => void this.activateView(meta.kind));
		}
	}

	onunload(): void {
		// Виды/события/интервалы зарегистрированы через register* — снимаются автоматически.
		void this.projects.flushPending();
		this.taskStore.dispose();
		this.indexer.dispose();
	}

	/** Открыть (или показать существующий) вид в основной области. */
	async activateView(kind: GtdViewKind, pane: "tab" | "split" = "tab"): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;
		const type = VIEW_TYPES[kind];

		const existing = workspace.getLeavesOfType(type)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return existing;
		}

		const leaf = workspace.getLeaf(pane);
		await leaf.setViewState({ type, active: true });
		await workspace.revealLeaf(leaf);
		return leaf;
	}

	/** Раскладка по умолчанию: Входящие | Доска | Отложенные — три сплита
	 *  в основной области (правая боковая панель по умолчанию свёрнута,
	 *  спрятанные туда «Отложенные» пользователь не видел — фидбек №7). */
	async openGtdWorkspace(): Promise<void> {
		await this.activateView("inbox", "tab");
		await this.activateView("kanban", "split");
		await this.activateView("tickler", "split");
	}

	/**
	 * Онбординг первого запуска. Приветственный диалог — ТОЛЬКО на хранилище без
	 * единого GTD-файла (проверка по frontmatter-флагам, дёшево после резолва
	 * кэша). Хранилище с GTD-файлами — существующий пользователь: помечаем
	 * пройденным молча, без диалога. Строго после резолва кэша (вызыватель).
	 */
	private maybeOnboard(metadata: MetadataAdapter): void {
		if (this.settings.onboarded) return;
		const flags = ["gtd-inbox", "gtd-board", "gtd-project", "gtd-recurring", "gtd-events"];
		const clean = flags.every((f) => metadata.findByFrontmatterValue(f, true) === null);
		if (!clean) {
			// уже есть GTD-файлы — не новичок: помечаем пройденным без диалога
			this.settings.onboarded = true;
			void this.saveSettings();
			return;
		}
		new WelcomeModal(this.app, {
			vault: this.vaultAdapter,
			markOnboarded: async () => {
				this.settings.onboarded = true;
				await this.saveSettings();
			},
			openWorkspace: async () => {
				await this.openGtdWorkspace();
				await this.activateView("calendar", "split");
			},
		}).open();
	}

	/** Команда палитры «Создать демо-файлы GTD»: засеять демо + уведомление. */
	private async runCreateDemoVault(): Promise<void> {
		try {
			const report = await createDemoVault(this.vaultAdapter);
			new Notice(demoVaultNotice(report));
		} catch (e) {
			new Notice(`GTD Flow: не удалось создать демо-файлы: ${String(e)}`);
		}
	}

	async loadSettings(): Promise<void> {
		// поключевое слияние вложенных объектов — плоский assign терял бы
		// вложенные дефолты при частичном data.json (см. mergeSettings)
		this.settings = mergeSettings(DEFAULT_SETTINGS, (await this.loadData()) as unknown);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
