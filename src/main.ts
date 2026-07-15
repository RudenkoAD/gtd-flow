import { Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_META, VIEW_TYPES, type GtdViewKind } from "./views/registry";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "./settings/Settings";
import { MetadataAdapter } from "./adapters/MetadataAdapter";
import { VaultAdapter } from "./adapters/VaultAdapter";
import { ObsidianClock } from "./adapters/ObsidianClock";
import { IndexerService } from "./services/IndexerService";
import { WritebackService } from "./services/WritebackService";
import { createTaskStore, type TaskStore } from "./stores/taskStore";
import { createGtdView } from "./views/createView";

export default class GtdFlowPlugin extends Plugin {
	settings: GtdFlowSettings = DEFAULT_SETTINGS;
	indexer!: IndexerService;
	vaultAdapter!: VaultAdapter;
	taskStore!: TaskStore;
	dispatcher!: WritebackService;

	async onload(): Promise<void> {
		await this.loadSettings();

		const metadata = new MetadataAdapter(this);
		this.vaultAdapter = new VaultAdapter(this.app);
		this.indexer = new IndexerService({
			events: metadata,
			clock: new ObsidianClock(this),
			initialScan: () => metadata.initialScan(),
			debounceMs: this.settings.debounceMs.fileReindex,
		});
		this.taskStore = createTaskStore(this.indexer);
		this.dispatcher = new WritebackService({
			write: this.vaultAdapter,
			feed: this.indexer,
			autoInjectId: this.settings.autoInjectId,
		});
		// Первичная сборка — вне критического пути старта (ТЗ §2).
		this.app.workspace.onLayoutReady(() => void this.indexer.start());

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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
