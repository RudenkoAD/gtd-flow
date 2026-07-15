import { Plugin, WorkspaceLeaf } from "obsidian";
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
import { registerCommands } from "./commands";
import { createTaskStore, type TaskStore } from "./stores/taskStore";
import { createGtdView } from "./views/createView";
import { DndService } from "./views/dnd/DndService";

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
	private indexReadyFlag = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		const metadata = new MetadataAdapter(this);
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
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
		});
		clock.onDayRollover(() => void this.recurrence.runPass());
		this.projects = new ProjectService({
			feed: this.indexer,
			write: this.vaultAdapter,
			readFrontmatter: (path) => metadata.frontmatter(path),
			patchFrontmatter: async (path, fn) => {
				await this.vaultAdapter.processFrontmatter(path, fn);
			},
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
		void Promise.all([layoutReady, cacheResolved]).then(() =>
			// .catch: rejection скана не должен пропадать беззвучно
			this.indexer.start().catch((e: unknown) => console.error("GTD Flow: сбой первичной сборки индекса", e)),
		);

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

		this.addRibbonIcon("inbox", "GTD Flow: Входящие", () => void this.activateView("inbox"));
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

	/** Раскладка по умолчанию: Входящие | Доска, справа — Календарь. */
	async openGtdWorkspace(): Promise<void> {
		await this.activateView("inbox", "tab");
		await this.activateView("kanban", "split");
		const right = this.app.workspace.getRightLeaf(false);
		if (right) {
			await right.setViewState({ type: VIEW_TYPES.tickler, active: false });
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
