import { Notice, Plugin, requestUrl, WorkspaceLeaf } from "obsidian";
import { writable, type Writable } from "svelte/store";
import { VIEW_META, VIEW_TYPES, type GtdViewKind } from "./views/registry";
import { DEFAULT_SETTINGS, defaultUnderCommonRoot, type GtdFlowSettings } from "./settings/Settings";
import {
	NS_CONVENTION,
	type NamespaceFilter,
	normalizeActiveNamespace,
	nsCommonTarget,
	nsTargetPath,
	resolveNamespace,
} from "./core/namespace/namespace";
import { mergeSettings } from "./settings/mergeSettings";
import { GtdSettingsTab } from "./settings/SettingsTab";
import { MetadataAdapter } from "./adapters/MetadataAdapter";
import { VaultAdapter } from "./adapters/VaultAdapter";
import { ObsidianClock } from "./adapters/ObsidianClock";
import { IndexerService } from "./services/IndexerService";
import { WritebackService } from "./services/WritebackService";
import { BoardService } from "./services/BoardService";
import { RecurrenceService } from "./services/RecurrenceService";
import { PromoteService } from "./services/PromoteService";
import { ProjectService } from "./services/ProjectService";
import { CardService } from "./services/CardService";
import { DayStatusService } from "./services/DayStatusService";
import { SyncService, type SyncResult } from "./sync/SyncService";
import { registerCommands } from "./commands";
import type { IsoDate } from "./core/model/Task";
import { createTaskStore, type TaskStore } from "./stores/taskStore";
import { createGtdView } from "./views/createView";
import { GtdView } from "./views/GtdView";
import { DndService } from "./views/dnd/DndService";
import { createDemoVault, demoVaultNotice } from "./onboarding/demoVault";
import { WelcomeModal } from "./onboarding/WelcomeModal";
import {
	captureTargetInNamespace,
	ensureCaptureFile,
	ensureCaptureFileNs,
} from "./views/common/taskActions";

export default class GtdFlowPlugin extends Plugin {
	settings: GtdFlowSettings = DEFAULT_SETTINGS;
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
	/**
	 * ГЛОБАЛЬНЫЙ дефолт активного пространства (store). С итерации 2 фидбека виды
	 * переключаются ПОФАЙЛОВО и на него НЕ подписаны — он лишь задаёт стартовое
	 * пространство новой вкладки и цель палитры-захвата (плюс синхронен с
	 * settings.activeNamespace). Инициализируется в onload из настроек.
	 */
	activeNamespace$!: Writable<string>;
	private indexReadyFlag = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		// нормализованное активное пространство → реактивный store (см. поле выше)
		this.activeNamespace$ = writable(this.settings.activeNamespace);

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
				// «Всплытие во входящие» пропущенных откатов дня (приложение было
				// закрыто в момент наступления 🛫): при promoteTo="inbox" — не no-op.
				void this.promote.runPass();
			},
		});
		this.taskStore = createTaskStore(this.indexer);
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
				await this.vaultAdapter.processFrontmatter(path, fn);
			},
			dispatcher: this.dispatcher,
			ensureFile: (path) => this.vaultAdapter.ensureFile(path),
			containerPaths: () =>
				fmIndexReady ? metadata.pathsByFrontmatterValue("gtd-board", true) : [],
			knownTaskId: (key) => this.dispatcher.knownTaskId(key),
			namespaceFilter: () => this.namespaceFilter(),
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
			// копия регулярного идёт во входящие ПРОСТРАНСТВА ШАБЛОНА (не активного):
			// именованное — <root>/Входящие.md, «Общее» — глобальный spawnTarget.
			spawnTargetFor: (template) => {
				const ns = resolveNamespace(
					template.filePath,
					template.nsOverride ?? null,
					this.settings.namespaces,
				);
				return nsTargetPath(
					ns,
					this.settings.namespaces,
					NS_CONVENTION.inbox,
					this.settings.recurring.spawnTarget,
				);
			},
		});
		clock.onDayRollover(() => void this.recurrence.runPass());
		// Возврат отложенной задачи (фидбек): при promoteTo="inbox" задача, чья 🛫
		// наступила на откате дня, приходит во «Входящие» своего пространства
		// (снятие тегов досок + перенос строки в inbox-файл). "origin" — no-op.
		this.promote = new PromoteService({
			feed: this.indexer,
			dispatcher: this.dispatcher,
			todayIso: () => clock.todayIso(),
			indexReady: () => this.indexReadyFlag,
			settings: () => ({
				promoteTo: this.settings.promoteTo,
				includePlain: this.settings.inboxIncludePlain,
			}),
			// цель — inbox-файл ПРОСТРАНСТВА задачи (как quick-add во «Входящих»):
			// первый существующий gtd-inbox файл пространства, иначе конвенционный путь.
			inboxTargetFor: (task) => {
				const ns = resolveNamespace(
					task.filePath,
					task.nsOverride ?? null,
					this.settings.namespaces,
				);
				const fallback = nsCommonTarget(
					ns,
					this.settings.namespaces,
					NS_CONVENTION.inbox,
					this.settings.commonRoot,
				);
				return captureTargetInNamespace(
					this.indexer.getIndex().all(),
					ns,
					this.settings.namespaces,
					fallback,
				);
			},
			// файл входящих создаётся и помечается gtd-inbox (+ gtd-namespace для
			// файла-исключения) СТРОГО до переноса строки — иначе перенесённая задача
			// осела бы в plain-файле и снова не попала во входящие.
			ensureInboxFile: (path, task) => {
				const ns = resolveNamespace(
					task.filePath,
					task.nsOverride ?? null,
					this.settings.namespaces,
				);
				return ensureCaptureFileNs(this.vaultAdapter, path, ns, this.settings.namespaces);
			},
			// окно прохода (lastRun, today]: первый проход усыновляет дату без обработки
			lastRun: () => (this.settings.promoteLastRun as IsoDate | null) ?? null,
			setLastRun: async (day) => {
				this.settings.promoteLastRun = day;
				await this.saveSettings();
			},
		});
		clock.onDayRollover(() => void this.promote.runPass());
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
			namespaceFilter: () => this.namespaceFilter(),
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
			// дефолтный путь статусов «следует за commonRoot»: нетронутое поле
			// создаётся в «Корневой папке Общего», кастомное значение — как задано
			defaultFilePath: () =>
				defaultUnderCommonRoot(
					this.settings.dayStatusFile,
					DEFAULT_SETTINGS.dayStatusFile,
					this.settings.commonRoot,
				),
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
		// Зеркалирование внешних iCal-календарей (§внешние календари). Порты — обёртки
		// над obsidian (requestUrl — не fetch: CORS; vault для записи целиком). Таймер
		// стартует ниже, после layout-ready (см. .then); чистится в onunload.
		this.sync = new SyncService({
			fetch: async (url) => {
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
			},
			clock: { now: () => new Date() },
			subscriptions: () => this.settings.externalCalendars,
			namespaces: () => this.settings.namespaces,
			commonRoot: () => this.settings.commonRoot,
			intervalMin: () => this.settings.externalSyncIntervalMin,
			onResult: (id, result) => this.recordSyncResult(id, result),
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
		void Promise.all([layoutReady, cacheResolved]).then(() => {
			// с этого момента ленивому fm-индексу можно доверять (кэш зарезолвлен)
			fmIndexReady = true;
			// первичный refresh статусов дней — строго после резолва кэша (иначе
			// findByFrontmatterValue закэширует пустой обратный индекс, см. start())
			void this.dayStatus.refresh();
			// онбординг — тоже строго после резолва кэша: обратный fm-индекс уже полон,
			// иначе «чистое хранилище» ложно определилось бы на пустом кэше
			this.maybeOnboard(metadata);
			// поллинг внешних календарей — после layout-ready + резолва кэша (frontmatter
			// зеркал уже читается для read-only-защиты); стартовая синхронизация внутри start()
			this.sync.start();
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

		// Ранний сброс отложенных позиций графа при закрытии приложения: onunload
		// Obsidian не await'ит, а beforeunload даёт шанс успеть стартовать запись
		// до смерти процесса (registerDomEvent снимет слушатель при выгрузке).
		this.registerDomEvent(window, "beforeunload", () => {
			void this.projects.flushPending();
		});
	}

	onunload(): void {
		// Виды/события/интервалы зарегистрированы через register* — снимаются автоматически.
		// flushPending здесь — best-effort: Obsidian не ждёт async-выгрузку. При
		// ОТКЛЮЧЕНИИ плагина процесс жив и промис доедет; окно потери — только выход
		// из приложения, его сужает ранний сброс по beforeunload (см. onload).
		void this.projects.flushPending();
		this.taskStore.dispose();
		this.indexer.dispose();
		this.sync.dispose();
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
		void this.saveSettings();
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
		// активное пространство могло указывать на удалённое из namespaces — откат
		// к «Общему», иначе фильтр резал бы все виды в пустоту
		this.settings.activeNamespace = normalizeActiveNamespace(
			this.settings.activeNamespace,
			this.settings.namespaces,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Текущий фильтр пространства для сервисов (discovery, цели) — читает из
	 *  настроек (всегда актуальны, синхронны с activeNamespace$). */
	namespaceFilter(): NamespaceFilter {
		return { active: this.settings.activeNamespace, defs: this.settings.namespaces };
	}

	/**
	 * Сменить ГЛОБАЛЬНЫЙ дефолт активного пространства: персист в настройках + толчок
	 * store (дефолт новых вкладок + цель палитры-захвата). Неизвестное имя нормализуется
	 * к «Общему» (ALL_NS глобальному не даём — он только у вкладки «Все» календаря).
	 * ВАЖНО: с итерации 2 фидбека виды переключаются ПОФАЙЛОВО и на этот store НЕ
	 * подписаны — глобальный дефолт лишь задаёт стартовое пространство новой вкладки.
	 * SettingsTab зовёт это при правке списка; палитра — через setNamespaceEverywhere.
	 */
	setActiveNamespace(name: string): void {
		const next = normalizeActiveNamespace(name, this.settings.namespaces);
		if (next === this.settings.activeNamespace) return;
		this.settings.activeNamespace = next;
		this.activeNamespace$.set(next);
		void this.saveSettings();
	}

	/** Все открытые вкладки видов GTD (для команды палитры «переключить всё» и poke). */
	private gtdViews(): GtdView[] {
		const out: GtdView[] = [];
		for (const kind of Object.keys(VIEW_TYPES) as GtdViewKind[]) {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPES[kind])) {
				if (leaf.view instanceof GtdView) out.push(leaf.view);
			}
		}
		return out;
	}

	/**
	 * Команда палитры «Переключить пространство GTD»: меняет ГЛОБАЛЬНЫЙ дефолт И
	 * локальные пространства ВСЕХ открытых вкладок GTD (старое «переключить всё
	 * разом»). Отдельные виды по-прежнему переключаются своими селекторами шапок.
	 */
	setNamespaceEverywhere(name: string): void {
		this.setActiveNamespace(name);
		for (const v of this.gtdViews()) v.setLocalNamespace(name);
	}

	/**
	 * После правки СПИСКА пространств (SettingsTab): каждый открытый вид
	 * пере-нормализует своё локальное пространство (удалённое имя → «Общее») и
	 * толкает свой store — пере-рендер с обновлённым списком корней. Смена настроек
	 * эпоху индекса не бампает, поэтому именно этот толчок обновляет виды.
	 */
	pokeNamespaceViews(): void {
		for (const v of this.gtdViews()) v.pokeNamespace();
	}
}
