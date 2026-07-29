import { Notice, Plugin, requestUrl, type WorkspaceLeaf } from "obsidian";
import { VIEW_META, VIEW_TYPES, type GtdViewKind } from "./views/registry";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "./settings/Settings";
import { mergeSettingsWithDiagnostics } from "./settings/mergeSettings";
import { GtdSettingsTab } from "./settings/SettingsTab";
import { MetadataAdapter } from "./adapters/MetadataAdapter";
import { VaultAdapter } from "./adapters/VaultAdapter";
import { ObsidianClock } from "./adapters/ObsidianClock";
import { IndexerService } from "./services/IndexerService";
import { WritebackService } from "./services/WritebackService";
import { BoardService, secureBoardIdSuffix } from "./services/BoardService";
import { RecurrenceService } from "./services/RecurrenceService";
import { PromoteService } from "./services/PromoteService";
import { ProjectService } from "./services/ProjectService";
import { CardService } from "./services/CardService";
import { DayStatusService } from "./services/DayStatusService";
import { SyncService, type SyncResult } from "./sync/SyncService";
import { registerCommands } from "./commands";
import type { IsoDate } from "./core/model/Task";
import { createTaskStore, type TaskStore } from "./stores/taskStore";
import { createSettingsRevision } from "./stores/settingsRevision";
import { createGtdView } from "./views/createView";
import { DndService } from "./views/dnd/DndService";
import { reportAsync } from "./views/common/runAction";
import { createDemoVault, demoVaultNotice } from "./onboarding/demoVault";
import { WelcomeModal } from "./onboarding/WelcomeModal";
import { ensureCaptureFile } from "./views/common/taskActions";
import {
	runSerializedCompareAndSet,
	SerializedSettingsSaver,
} from "./settings/SerializedSettingsSaver";
import { ScopeCatalogService } from "./services/ScopeCatalogService";
import {
	cloneSettingsSnapshot,
	namespaceMigrationSettingsEqual,
	NamespaceMigrationService,
} from "./services/NamespaceMigrationService";
import {
	discoverLegacyNamespaceInventory,
	type LegacyNamespaceDiscovery,
} from "./services/LegacyNamespaceDiscovery";
import {
	readLegacyNamespaceSettings,
	type LegacyNamespaceCompatibilityFields,
	type LegacyNamespaceSettings,
	type NamespaceMigrationSettingsSnapshot,
} from "./core/scope/namespaceMigration";
import { isActiveScopeId } from "./core/scope/scope";
import { AiPluginServices } from "./ai/integration/AiPluginServices";
import type { AIViewController } from "./ai/integration/AIViewController";
import type { TaskMetadataService } from "./services/TaskMetadataService";
import { openTaskInFile } from "./views/common/openTask";

export default class GtdFlowPlugin extends Plugin {
	settings: GtdFlowSettings = DEFAULT_SETTINGS;
	/** Сигнал для уже смонтированных Svelte-видов: SettingsTab меняет settings
	 * in-place, поэтому ссылка объекта сама по себе не реактивна. */
	readonly settingsRevision = createSettingsRevision();
	/** saveData callers come from UI and concurrent calendar/background work.
	 * Snapshot + serialize them so an older completion cannot replace newer data. */
	private readonly settingsSaver = new SerializedSettingsSaver<Record<string, unknown>>(
		(snapshot) => this.saveData(snapshot),
	);
	indexer!: IndexerService;
	vaultAdapter!: VaultAdapter;
	taskStore!: TaskStore;
	dispatcher!: WritebackService;
	boards!: BoardService;
	dnd!: DndService;
	recurrence!: RecurrenceService;
	promote!: PromoteService;
	projects!: ProjectService;
	cards!: CardService;
	dayStatus!: DayStatusService;
	sync!: SyncService;
	scopes!: ScopeCatalogService;
	/** Explicitly invoked one-time executor for legacy namespace → scope migration. */
	namespaceMigration!: NamespaceMigrationService;
	/** Desktop-only AI composition root and narrow view/menu ports. */
	ai!: AiPluginServices;
	aiViewPort!: AIViewController;
	taskMetadata!: TaskMetadataService;
	/** Compatibility-only input for the explicit namespace migration modal. */
	private legacyNamespaceSettings: LegacyNamespaceSettings = {
		commonRoot: null,
		activeNamespace: null,
		namespaces: [],
	};
	/** Kept out of runtime settings, but re-serialized until the user-approved migration completes. */
	private legacyNamespacePersisted: LegacyNamespaceCompatibilityFields = {};
	private legacyTodayIso: () => IsoDate = () => new Date().toISOString().slice(0, 10) as IsoDate;
	private legacyInboxPaths: () => string[] = () => [];
	private legacyNamespaceOverride: (path: string) => string | null = () => null;
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
		this.legacyTodayIso = () => clock.todayIso();
		this.vaultAdapter = new VaultAdapter(this.app);
		// `gtd-namespace` is deliberately NOT a runtime frontmatter field. The
		// migration wizard is the sole compatibility reader that may inspect it.
		this.legacyInboxPaths = () =>
			fmIndexReady ? metadata.pathsByFrontmatterValue("gtd-inbox", true) : [];
		this.legacyNamespaceOverride = (path) => {
			const value = metadata.frontmatter(path)?.["gtd-namespace"];
			return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
		};
		this.indexer = new IndexerService({
			events: metadata,
			clock,
			initialScan: () => metadata.initialScan(),
			debounceMs: this.settings.debounceMs.fileReindex,
			// Первый spawn-проход регулярных — строго после полной сборки индекса (ТЗ §6).
			onReady: () => {
				this.indexReadyFlag = true;
				reportAsync("фоновый проход регулярных", () => this.recurrence.runPass());
				// «Всплытие во входящие» пропущенных откатов дня (приложение было
				// закрыто в момент наступления 🛫): при promoteTo="inbox" — не no-op.
				reportAsync("фоновое возвращение отложенных", () => this.promote.runPass());
				reportAsync("сверка владельцев AI-полей", () => this.ai.reconcileOwnership());
			},
		});
		this.taskStore = createTaskStore(this.indexer);
		this.scopes = new ScopeCatalogService(
			{
				read: (path) => this.vaultAdapter.read(path),
				writeAtomic: (path, content) => this.vaultAdapter.writeAtomic(path, content),
			},
			{
				countTasksWithScope: (scopeId) =>
					[...this.indexer.getIndex().all()].filter((task) => task.scopeId === scopeId)
						.length,
			},
		);
		await this.scopes.load();
		this.namespaceMigration = new NamespaceMigrationService(
			this.vaultAdapter,
			{
				snapshot: () => this.namespaceMigrationSettingsSnapshot(),
				compareAndSet: (expected, next) =>
					this.compareAndSetNamespaceMigrationSettings(expected, next),
			},
			{ now: () => new Date().toISOString() },
			{
				next: () =>
					`migration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
			},
			{
				isActive: (scopeId) => isActiveScopeId(this.scopes.current(), scopeId),
			},
		);
		this.dispatcher = new WritebackService({
			write: this.vaultAdapter,
			feed: this.indexer,
			autoInjectId: this.settings.autoInjectId,
			// зеркала внешних календарей (gtd-external) — read-only: их перезаписывает
			// синхронизация, ручная правка затёрлась бы. frontmatter читаем напрямую
			// (авторитетно, не зависит от отставания индекса); правки идут после старта,
			// когда кэш метаданных уже зарезолвлен.
			readOnlyFile: (path) => metadata.frontmatter(path)?.["gtd-external"] === true,
		});
		this.boards = new BoardService({
			feed: this.indexer,
			readFrontmatter: (path) => metadata.frontmatter(path),
			patchFrontmatter: async (path, fn) => {
				const changed = await this.vaultAdapter.processFrontmatter(path, fn);
				if (!changed) throw new Error(`board-frontmatter-write-failed:${path}`);
			},
			dispatcher: this.dispatcher,
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
			containerPaths: () =>
				fmIndexReady ? metadata.pathsByFrontmatterValue("gtd-board", true) : [],
			knownTaskId: (key) => this.dispatcher.knownTaskId(key),
			// UUID v4 comes from the platform CSPRNG (randomUUID, or getRandomValues
			// on older mobile WebViews); BoardService adds the readable name slug.
			genBoardIdSuffix: secureBoardIdSuffix,
		});
		this.dnd = new DndService(this);
		this.recurrence = new RecurrenceService({
			feed: this.indexer,
			write: this.vaultAdapter,
			dispatcher: this.dispatcher,
			settings: () => ({ inboxFile: this.settings.inboxFile, ...this.settings.recurring }),
			todayIso: () => clock.todayIso(),
			indexReady: () => this.indexReadyFlag,
			// Unified inbox is a capture container; mark it before writing instances.
			// при скоупе входящих «только GTD-файлы» копии регулярных стали бы
			// невидимы во входящих (ensureFile создал бы файл без флага)
			ensureFile: async (path) => {
				await ensureCaptureFile(this.vaultAdapter, path);
			},
		});
		clock.onDayRollover(() =>
			reportAsync("проход регулярных после смены дня", () => this.recurrence.runPass()),
		);
		// Deferred tasks promoted to inbox always land in the configured unified file.
		this.promote = new PromoteService({
			feed: this.indexer,
			dispatcher: this.dispatcher,
			todayIso: () => clock.todayIso(),
			indexReady: () => this.indexReadyFlag,
			settings: () => ({
				promoteTo: this.settings.promoteTo,
				includePlain: this.settings.inboxIncludePlain,
			}),
			inboxTargetFor: () => this.settings.inboxFile,
			ensureInboxFile: (path) => ensureCaptureFile(this.vaultAdapter, path),
			// окно прохода (lastRun, today]: первый проход усыновляет дату без обработки
			lastRun: () => (this.settings.promoteLastRun as IsoDate | null) ?? null,
			setLastRun: async (day) => {
				this.settings.promoteLastRun = day;
				await this.saveSettings();
			},
			// Promotion can clear fields and then move a line across files.  It always
			// receives a stable id and persists a retry record first, even when the
			// user's general autoInjectId preference is off.
			ensureTaskId: (key) => this.dispatcher.ensureTaskId(key),
			promotionRetries: () => this.settings.promoteRetries,
			setPromotionRetries: async (retries) => {
				this.settings.promoteRetries = retries.map((retry) => ({ ...retry }));
				await this.saveSettings();
			},
		});
		clock.onDayRollover(() =>
			reportAsync("возвращение отложенных после смены дня", () => this.promote.runPass()),
		);
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
			processFrontmatter: (path, fn) => this.vaultAdapter.processFrontmatter(path, fn),
			defaultFilePath: () => this.settings.dayStatusFile,
			onVaultChange: (cb) => {
				// после полного резолва кэша (в т.ч. первого после старта/перезагрузки)
				// — файл статусов уже обнаружим по frontmatter-флагу
				this.registerEvent(this.app.metadataCache.on("resolved", () => cb()));
				// refresh когда меняется сам файл статусов или файл с флагом
				this.registerEvent(
					this.app.metadataCache.on("changed", (file, _data, cache) => {
						if (
							cache?.frontmatter?.["gtd-day-status"] === true ||
							file.path === this.dayStatus.filePath()
						)
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
		// Зеркалирование внешних iCal-календарей (§внешние календари). Порты — обёртки
		// над obsidian (requestUrl — не fetch: CORS; vault для записи целиком). Таймер
		// стартует ниже, после layout-ready (см. .then); чистится в onunload.
		this.sync = new SyncService({
			fetch: async (url, _signal) => {
				// Obsidian's requestUrl has no AbortSignal support.  SyncService still
				// applies a deadline and generation fence, so a late response cannot
				// write a deleted/relocated mirror after its caller has timed out.
				const res = await requestUrl({ url, method: "GET", throw: true });
				return res.text;
			},
			vault: {
				read: (path) => this.vaultAdapter.readFile(path),
				write: async (path, content) => {
					const existing = this.app.vault.getFileByPath(path);
					if (existing === null) {
						const dir = path.split("/").slice(0, -1).join("/");
						if (dir !== "" && this.app.vault.getAbstractFileByPath(dir) === null)
							await this.app.vault.createFolder(dir).catch(() => undefined);
						await this.app.vault.create(path, content);
					} else {
						await this.app.vault.modify(existing, content);
					}
				},
				// удаление осиротевшего зеркала (подписку удалили/переименовали) — в
				// СИСТЕМНУЮ корзину (trash второй аргумент true): удалили зря — восстановимо
				delete: async (path) => {
					const file = this.app.vault.getFileByPath(path);
					if (file !== null) await this.app.vault.trash(file, true);
				},
				// metadata cache is fully resolved before SyncService.start().  We list
				// only generated gtd-external files, never their private ICS content.
				listManagedMirrors: async () =>
					this.app.vault.getMarkdownFiles().flatMap((file) => {
						const frontmatter = metadata.frontmatter(file.path);
						if (frontmatter?.["gtd-external"] !== true) return [];
						const rawId = frontmatter["gtd-external-id"];
						return [
							{
								path: file.path,
								subscriptionId: typeof rawId === "string" ? rawId : null,
							},
						];
					}),
			},
			clock: { now: () => new Date() },
			subscriptions: () => this.settings.externalCalendars,
			inboxFile: () => this.settings.inboxFile,
			intervalMin: () => this.settings.externalSyncIntervalMin,
			onResult: (id, result) => this.recordSyncResult(id, result),
			onLifecycleWarning: (message) => console.warn(`GTD Flow: ${message}`),
		});
		this.ai = new AiPluginServices({
			app: this.app,
			vault: this.vaultAdapter,
			dispatcher: this.dispatcher,
			scopes: this.scopes,
			projects: this.projects,
			boards: this.boards,
			allTasks: () => [...this.indexer.getIndex().all()],
			inboxFile: () => this.settings.inboxFile,
			ensureInbox: async (path) => {
				if (!(await ensureCaptureFile(this.vaultAdapter, path))) {
					throw new Error(`inbox-file-unavailable:${path}`);
				}
			},
			enabled: () => this.settings.ai.enabled,
			privacyPolicy: () =>
				this.settings.ai.privacyPolicy === "unconfigured"
					? null
					: this.settings.ai.privacyPolicy,
			credentialStorage: () =>
				this.settings.ai.credentialStorage === "memory-only" ? "memory-only" : null,
			durationLongStyle: () => this.settings.durationLongStyle,
			openTask: (task) => openTaskInFile(this.app, task),
			openAiView: async () => {
				await this.activateView("ai");
			},
		});
		this.aiViewPort = this.ai.view;
		this.taskMetadata = this.ai.metadata;
		this.register(this.indexer.onChange(() => this.ai.observeTasks()));
		if (this.settings.ai.storageVersion !== 1) {
			this.settings.ai.storageVersion = 1;
			reportAsync("сохранение версии AI-хранилища", () => this.saveSettings());
		}
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
		void Promise.all([layoutReady, cacheResolved])
			.then(() => {
				// с этого момента ленивому fm-индексу можно доверять (кэш зарезолвлен)
				fmIndexReady = true;
				// первичный refresh статусов дней — строго после резолва кэша (иначе
				// findByFrontmatterValue закэширует пустой обратный индекс, см. start())
				reportAsync("обновление статусов дней", () => this.dayStatus.refresh());
				// онбординг — тоже строго после резолва кэша: обратный fm-индекс уже полон,
				// иначе «чистое хранилище» ложно определилось бы на пустом кэше
				this.maybeOnboard(metadata);
				// поллинг внешних календарей — после layout-ready + резолва кэша (frontmatter
				// зеркал уже читается для read-only-защиты); стартовая синхронизация внутри start()
				this.sync.start();
				return this.indexer.start();
			})
			.catch((e: unknown) => console.error("GTD Flow: сбой первичной сборки индекса", e));

		for (const meta of Object.values(VIEW_META)) {
			this.registerView(meta.type, (leaf) => createGtdView(leaf, this, meta));
		}

		for (const meta of Object.values(VIEW_META)) {
			this.addCommand({
				id: `open-${meta.kind}`,
				name: `Открыть: ${meta.displayText.replace(/^GTD: /, "")}`,
				callback: () =>
					reportAsync(`открытие вида «${meta.displayText}»`, () =>
						this.activateView(meta.kind),
					),
			});
		}

		this.addCommand({
			id: "open-workspace",
			name: "Открыть рабочее пространство GTD",
			callback: () =>
				reportAsync("открытие рабочего пространства", () => this.openGtdWorkspace()),
		});

		// Демо-файлы доступны всегда (не только на первом запуске): удобно, если
		// пользователь пропустил приветственный диалог или хочет пересоздать пример.
		this.addCommand({
			id: "create-demo-vault",
			name: "Создать демо-файлы GTD",
			callback: () => reportAsync("создание демо-файлов", () => this.runCreateDemoVault()),
		});

		// Ярлыки всех видов в ленте; порядок — как в VIEW_META (регистрация задаёт
		// порядок иконок, пользователь может скрыть лишние через контекстное меню ленты).
		for (const meta of Object.values(VIEW_META)) {
			this.addRibbonIcon(meta.icon, meta.displayText, () =>
				reportAsync(`открытие вида «${meta.displayText}»`, () =>
					this.activateView(meta.kind),
				),
			);
		}

		// Ранний сброс отложенных позиций графа при закрытии приложения: onunload
		// Obsidian не await'ит, а beforeunload даёт шанс успеть стартовать запись
		// до смерти процесса (registerDomEvent снимет слушатель при выгрузке).
		this.registerDomEvent(window, "beforeunload", () => {
			reportAsync("сохранение позиций графа", () => this.projects.flushPending());
		});
	}

	onunload(): void {
		// Виды/события/интервалы зарегистрированы через register* — снимаются автоматически.
		// flushPending здесь — best-effort: Obsidian не ждёт async-выгрузку. При
		// ОТКЛЮЧЕНИИ плагина процесс жив и промис доедет; окно потери — только выход
		// из приложения, его сужает ранний сброс по beforeunload (см. onload).
		reportAsync("сохранение позиций графа", () => this.projects.flushPending());
		this.taskStore.dispose();
		this.indexer.dispose();
		this.sync.dispose();
		reportAsync("очистка локального AI-ключа", () => this.ai.dispose());
	}

	/** Записать статус синхронизации подписки (SyncService.onResult) + персист, если
	 *  что-то изменилось (лишний saveData будит sync-клиент data.json впустую). */
	private recordSyncResult(id: string, result: SyncResult): void {
		const sub = this.settings.externalCalendars.find((s) => s.id === id);
		if (sub === undefined) return;
		if (result.ok) {
			if (sub.lastSyncAt === result.at && sub.lastError === null) return;
			sub.lastSyncAt = result.at;
			sub.lastError = null;
		} else {
			if (sub.lastError === result.error) return;
			sub.lastError = result.error;
		}
		reportAsync("сохранение статуса синхронизации", () => this.saveSettings());
	}

	/** Открыть (или показать существующий) вид в основной области. */
	async activateView(
		kind: GtdViewKind,
		pane: "tab" | "split" = "tab",
	): Promise<WorkspaceLeaf | null> {
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
			reportAsync("сохранение статуса онбординга", () => this.saveSettings());
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
		const raw = (await this.loadData()) as unknown;
		this.legacyNamespaceSettings = readLegacyNamespaceSettings(raw);
		this.legacyNamespacePersisted = legacyNamespaceFields(raw);
		const merged = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, raw);
		this.settings = merged.settings;
		// Диагностика намеренно содержит только имена полей/версии (см. schema),
		// а не приватные значения из data.json (URL календарей, пути и т.п.).
		if (merged.diagnostics.length > 0)
			console.warn("GTD Flow: recovered invalid settings", merged.diagnostics);
	}

	async saveSettings(): Promise<void> {
		// Capture only after earlier settings transactions have completed. Otherwise
		// an ordinary background save could freeze a migration's speculative live
		// fields and persist them after that migration write fails and rolls back.
		const saved = await this.settingsSaver.saveFrom(() =>
			this.settingsForPersistence(this.settings),
		);
		// Бампим только когда успешно записан ПОСЛЕДНИЙ запрошенный снимок.
		// Более старый success уже durable, но live settings к этому моменту могут
		// содержать queued snapshot, который ещё не записан (и может упасть).
		if (saved.latest) this.settingsRevision.notifySaved();
	}

	/** Explicit user-requested export; credentials are not part of feedback events. */
	async exportAiLearningHistory(): Promise<string> {
		const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
		const path = `.gtd-flow/exports/learning-history-${timestamp}.json`;
		await this.vaultAdapter.writeAtomic(path, await this.ai.exportFeedback());
		return path;
	}

	/** Builds an inventory only when the user explicitly opens the migration UI. */
	legacyNamespaceMigrationInventory(): LegacyNamespaceDiscovery {
		return discoverLegacyNamespaceInventory({
			namespaces: this.legacyNamespaceSettings.namespaces,
			tasks: [...this.indexer.getIndex().all()],
			today: this.legacyTodayIso(),
			inboxPaths: this.legacyInboxPaths(),
			overrideForPath: this.legacyNamespaceOverride,
		});
	}

	private settingsForPersistence(snapshot: GtdFlowSettings): Record<string, unknown> {
		return { ...snapshot, ...this.legacyNamespacePersisted };
	}

	private namespaceMigrationSettingsSnapshot(): NamespaceMigrationSettingsSnapshot {
		return cloneSettingsSnapshot({
			inboxFile: this.settings.inboxFile,
			legacy: this.legacyNamespacePersisted,
		});
	}

	private async compareAndSetNamespaceMigrationSettings(
		expected: NamespaceMigrationSettingsSnapshot,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<boolean> {
		const result = await runSerializedCompareAndSet(this.settingsSaver, {
			read: () => this.namespaceMigrationSettingsSnapshot(),
			expected,
			next,
			equal: namespaceMigrationSettingsEqual,
			replace: (value) => this.replaceNamespaceMigrationSettings(value),
			restore: (before, speculative, current) =>
				this.restoredNamespaceMigrationSettings(before, speculative, current),
			persistenceSnapshot: () => this.settingsForPersistence(this.settings),
		});
		// A later queued save owns the notification and will observe the committed
		// or restored live migration fields when it reaches the queue head.
		if (result.latest) this.settingsRevision.notifySaved();
		return result.value;
	}

	private replaceNamespaceMigrationSettings(snapshot: NamespaceMigrationSettingsSnapshot): void {
		const copy = cloneSettingsSnapshot(snapshot);
		this.settings.inboxFile = copy.inboxFile;
		this.legacyNamespacePersisted = copy.legacy;
		this.legacyNamespaceSettings = readLegacyNamespaceSettings(copy.legacy);
	}

	private restoredNamespaceMigrationSettings(
		before: NamespaceMigrationSettingsSnapshot,
		speculative: NamespaceMigrationSettingsSnapshot,
		current: NamespaceMigrationSettingsSnapshot,
	): NamespaceMigrationSettingsSnapshot {
		const legacyStillSpeculative = namespaceMigrationSettingsEqual(
			{ inboxFile: current.inboxFile, legacy: current.legacy },
			{ inboxFile: current.inboxFile, legacy: speculative.legacy },
		);
		// Preserve a later user edit to either migration-owned field, but restore
		// every field that still contains this failed transaction's value.
		return {
			inboxFile:
				current.inboxFile === speculative.inboxFile ? before.inboxFile : current.inboxFile,
			legacy: legacyStillSpeculative ? before.legacy : current.legacy,
		};
	}
}

function legacyNamespaceFields(raw: unknown): LegacyNamespaceCompatibilityFields {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const kept: LegacyNamespaceCompatibilityFields = {};
	for (const key of ["commonRoot", "namespaces", "activeNamespace"] as const) {
		if (key in record) kept[key] = record[key];
	}
	return kept;
}
