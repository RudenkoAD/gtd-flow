/**
 * Команды палитры (ТЗ §8, слой 3 — обязательный паритет без drag).
 *
 * Команды «под курсором» работают из ЛЮБОГО markdown-редактора — это главный
 * паритет для мобильных: single pane, кросс-видовой drag выключен, а строка
 * задачи всегда под рукой в нативном редакторе.
 *
 * Подключение: оркестратор вызывает registerCommands(plugin) из main.ts —
 * сам main.ts здесь не трогаем.
 */
import { Modal, Notice, type App, type Editor } from "obsidian";
import type GtdFlowPlugin from "./main";
import type { CardPort } from "./services/CardService";
import type { Task } from "./core/model/Task";
import { ESTIMATE_FIELDS, type EstimateField } from "./core/estimates/provenance";
import { activeScopes } from "./core/scope/scope";
import {
	planNamespaceMigration,
	type CommonTaskPolicy,
	type NamespaceMigrationJournal,
	type NamespaceMigrationPreview,
} from "./core/scope/namespaceMigration";
import { appendLine } from "./views/calendar/calendarLogic";
import { pickBoardColumn, pickDate } from "./views/common/pickers";
import { reportAsync } from "./views/common/runAction";
import { ensureCaptureFile, findTaskAtLine, quickCaptureLine } from "./views/common/taskActions";
import { recreateScopeCatalogWithConfirm } from "./views/common/scopeRecovery";
import type { ProcessInboxSummary } from "./ai/processing/InboxProcessor";

export interface CommandRegistrationOptions {
	desktopFeatures?: boolean;
	/**
	 * Гейт внешней синхронизации календарей. Отдельно от desktopFeatures,
	 * чтобы календарная синхронизация не зависела от политики AI-фич;
	 * по умолчанию наследует desktopFeatures.
	 */
	calendarSync?: boolean;
}

export function registerCommands(
	plugin: GtdFlowPlugin,
	options: CommandRegistrationOptions = {},
): void {
	plugin.addCommand({
		id: "quick-capture",
		name: "Быстрый ввод во входящие",
		callback: () => {
			new QuickCaptureModal(plugin.app, (text) =>
				reportAsync("быстрый ввод не сохранён", () => capture(plugin, text)),
			).open();
		},
	});

	plugin.addCommand({
		id: "run-recurrence-pass",
		name: "Проверить регулярные сейчас",
		callback: () => reportAsync("проход повторов не выполнен", () => runRecurrencePass(plugin)),
	});

	// Доступно и на Android: раздел scope в настройках есть на обеих платформах,
	// а повреждённый каталог блокирует создание scope везде одинаково.
	plugin.addCommand({
		id: "recreate-scope-catalog",
		name: "Пересоздать каталог scope…",
		callback: () =>
			reportAsync("каталог scope не пересоздан", async () => {
				await recreateScopeCatalogWithConfirm(plugin.app, plugin.scopes);
			}),
	});

	if ((options.calendarSync ?? options.desktopFeatures) !== false) {
		plugin.addCommand({
			id: "sync-external-calendars",
			name: "Синхронизировать внешние календари",
			callback: () =>
				reportAsync("синхронизация внешних календарей не выполнена", () =>
					syncExternalCalendars(plugin),
				),
		});
	}

	// Android MVP intentionally exposes only commands backed by its registered
	// Inbox/Calendar/Recurring surface. In particular, no AI callback is ever
	// registered against the absent desktop composition root.
	if (options.desktopFeatures === false) return;

	plugin.addCommand({
		id: "migrate-legacy-namespaces",
		name: "Мигрировать пространства в scope…",
		callback: () => new LegacyNamespaceMigrationModal(plugin).open(),
	});

	plugin.addCommand({
		id: "process-inbox-with-ai",
		name: "Обработать входящие с AI",
		callback: () =>
			reportAsync("AI-обработка входящих не выполнена", () => processInboxWithAi(plugin)),
	});

	plugin.addCommand({
		id: "cancel-active-ai-inbox-processing",
		name: "Отменить активную AI-обработку входящих",
		callback: () => cancelActiveAiInboxProcessing(plugin),
	});

	plugin.addCommand({
		id: "reprocess-task-at-cursor-with-ai",
		name: "Переоценить задачу под курсором с AI",
		editorCallback: (editor, ctx) =>
			reportAsync("AI-переоценка задачи не выполнена", () =>
				reprocessAtCursorWithAi(plugin, editor, ctx.file?.path ?? null),
			),
	});

	plugin.addCommand({
		id: "unlock-ai-field-at-cursor",
		name: "Разблокировать AI-поле задачи под курсором…",
		editorCallback: (editor, ctx) =>
			reportAsync("AI-поле не разблокировано", () =>
				unlockAiFieldAtCursor(plugin, editor, ctx.file?.path ?? null),
			),
	});

	plugin.addCommand({
		id: "open-last-ai-run",
		name: "Открыть разговор последнего AI-запуска",
		callback: () =>
			reportAsync("последний AI-запуск не открыт", async () => {
				if (!(await desktopAi(plugin).openLastRun())) {
					new Notice("GTD Flow: сохранённых AI-запусков пока нет");
				}
			}),
	});

	plugin.addCommand({
		id: "retry-waiting-ai-jobs",
		name: "Повторить ожидающие AI-запуски",
		callback: () =>
			reportAsync("ожидающие AI-запуски не повторены", () => retryWaitingAiJobs(plugin)),
	});

	plugin.addCommand({
		id: "resume-legacy-namespace-migration",
		name: "Продолжить миграцию пространств…",
		callback: () =>
			new MigrationJournalModal(plugin.app, "resume", (id) =>
				reportAsync("миграция пространств не продолжена", () =>
					resumeNamespaceMigration(plugin, id),
				),
			).open(),
	});

	plugin.addCommand({
		id: "rollback-legacy-namespace-migration",
		name: "Откатить миграцию пространств…",
		callback: () =>
			new MigrationJournalModal(plugin.app, "rollback", (id) =>
				reportAsync("миграция пространств не откачена", () =>
					rollbackNamespaceMigration(plugin, id),
				),
			).open(),
	});

	plugin.addCommand({
		id: "card-at-cursor",
		name: "Карточка задачи под курсором",
		editorCallback: (editor, ctx) =>
			reportAsync("не удалось открыть карточку", () =>
				cardAtCursor(plugin, editor, ctx.file?.path ?? null),
			),
	});

	plugin.addCommand({
		id: "defer-at-cursor",
		name: "Отложить задачу под курсором…",
		editorCallback: (editor, ctx) =>
			reportAsync("не удалось отложить задачу", () =>
				deferAtCursor(plugin, editor, ctx.file?.path ?? null),
			),
	});

	plugin.addCommand({
		id: "move-to-column-at-cursor",
		name: "Задачу под курсором — в колонку…",
		editorCallback: (editor, ctx) =>
			reportAsync("не удалось переместить задачу в колонку", () =>
				columnAtCursor(plugin, editor, ctx.file?.path ?? null),
			),
	});
}

// ---------------------------------------------------------------------------
// Быстрый ввод (паттерн quick-add календаря): append СТРОГО в единый
// settings.inboxFile. Пространств больше нет; путь для legacy-хранилищ выводит
// миграция v1 → v2 (legacyInboxCandidates), а не конвенция по пространству.
// ---------------------------------------------------------------------------

class QuickCaptureModal extends Modal {
	constructor(
		app: App,
		private readonly onSubmit: (text: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Быстрый ввод во входящие");
		const wrap = this.contentEl.createDiv({ cls: "gtd-quick-capture" });
		const input = wrap.createEl("input", { type: "text", placeholder: "Новая задача…" });
		const submit = (): void => {
			const value = input.value;
			this.close();
			this.onSubmit(value);
		};
		input.addEventListener("keydown", (e) => {
			// Enter в IME подтверждает композицию, а не отправку; keyCode 229 —
			// WebKit/iOS, где на коммит-Enter isComposing уже false
			if (e.isComposing || e.keyCode === 229) return;
			if (e.key === "Enter") submit();
		});
		const ok = wrap.createEl("button", { text: "OK", cls: "mod-cta" });
		ok.addEventListener("click", submit);
		wrap.style.display = "flex";
		wrap.style.gap = "8px";
		input.style.flex = "1 1 auto";
		input.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class EstimateFieldPickerModal extends Modal {
	constructor(
		app: App,
		private readonly fields: readonly EstimateField[],
		private readonly onSubmit: (field: EstimateField) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Какое поле разблокировать и переоценить?");
		const labels: Record<EstimateField, string> = {
			duration: "Длительность",
			cognitive: "Когнитивная интенсивность",
			emotional: "Эмоциональная интенсивность",
			physical: "Физическая интенсивность",
			scope: "Scope",
		};
		for (const field of this.fields) {
			const button = this.contentEl.createEl("button", {
				text: labels[field],
			});
			button.style.display = "block";
			button.style.marginBottom = "8px";
			button.addEventListener("click", () => {
				this.close();
				this.onSubmit(field);
			});
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** The preview/mapping UI creates the journal; this small recovery hook keeps
 * interrupted migrations operable from the command palette after a restart. */
class MigrationJournalModal extends Modal {
	constructor(
		app: App,
		private readonly action: "resume" | "rollback",
		private readonly onSubmit: (id: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(
			this.action === "resume"
				? "Продолжить миграцию пространств"
				: "Откатить миграцию пространств",
		);
		const wrap = this.contentEl.createDiv({ cls: "gtd-namespace-migration-journal" });
		const input = wrap.createEl("input", {
			type: "text",
			placeholder: "ID миграции из .gtd-flow/ai/migrations",
		});
		const submit = (): void => {
			const id = input.value.trim();
			if (id === "") return;
			this.close();
			this.onSubmit(id);
		};
		input.addEventListener("keydown", (event) => {
			if (event.isComposing || event.keyCode === 229) return;
			if (event.key === "Enter") submit();
		});
		const label = this.action === "resume" ? "Продолжить" : "Откатить";
		const button = wrap.createEl("button", { text: label, cls: "mod-warning" });
		button.addEventListener("click", submit);
		input.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * The one-time migration wizard intentionally requires two explicit decisions:
 * D1 (all tasks vs inbox only) and D2 (what to do with legacy Common). It
 * renders a deterministic dry run first; only a second click creates the
 * durable journal and mutates the vault.
 */
class LegacyNamespaceMigrationModal extends Modal {
	private preview: NamespaceMigrationPreview | null = null;
	private previewRevision = 0;

	constructor(private readonly plugin: GtdFlowPlugin) {
		super(plugin.app);
	}

	override onOpen(): void {
		this.render();
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.previewRevision += 1;
		this.contentEl.empty();
		this.titleEl.setText("Миграция пространств в scope");
		const discovered = this.plugin.legacyNamespaceMigrationInventory();
		const scopes = activeScopes(this.plugin.scopes.current());
		if (scopes.length === 0) {
			this.contentEl.createEl("p", {
				text: "Сначала создайте хотя бы один активный scope: сопоставление требует scope для каждого пространства.",
			});
			return;
		}
		const invalidatePreview = (): void => {
			this.previewRevision += 1;
			this.preview = null;
			this.contentEl.querySelector(".gtd-namespace-migration-preview")?.remove();
		};

		const coverage = this.contentEl.createEl("select");
		coverage.addEventListener("change", invalidatePreview);
		coverage.createEl("option", {
			value: "",
			text: "D1: выберите охват миграции…",
		});
		coverage.createEl("option", {
			value: "inbox-only",
			text: "D1: только задачи из legacy Inbox",
		});
		coverage.createEl("option", { value: "all-tasks", text: "D1: все задачи пространств" });
		const common = this.contentEl.createEl("select");
		common.addEventListener("change", invalidatePreview);
		common.createEl("option", { value: "", text: "D2: выберите обработку Common…" });
		common.createEl("option", {
			value: "leave-unscoped",
			text: "D2: Common оставить без scope",
		});
		for (const scope of scopes)
			common.createEl("option", { value: scope.id, text: `D2: Common → ${scope.name}` });

		const mappings = new Map<string, HTMLSelectElement>();
		for (const namespace of discovered.inventory.namespaces) {
			this.contentEl.createEl("p", { text: `Пространство «${namespace.name}» →` });
			const select = this.contentEl.createEl("select");
			for (const scope of scopes)
				select.createEl("option", { value: scope.id, text: scope.name });
			const sameName = scopes.find(
				(scope) =>
					scope.name.localeCompare(namespace.name, undefined, {
						sensitivity: "accent",
					}) === 0,
			);
			select.value = (sameName ?? scopes[0]!).id;
			select.addEventListener("change", invalidatePreview);
			mappings.set(namespace.name, select);
		}

		const previewButton = this.contentEl.createEl("button", { text: "Показать dry-run" });
		previewButton.addEventListener("click", () => {
			if (coverage.value !== "inbox-only" && coverage.value !== "all-tasks") {
				new Notice("GTD Flow: выберите D1 — охват миграции пространств");
				return;
			}
			if (
				common.value !== "leave-unscoped" &&
				!scopes.some((scope) => scope.id === common.value)
			) {
				new Notice("GTD Flow: выберите D2 — обработку Common задач");
				return;
			}
			const byNamespace: Record<string, string> = {};
			for (const [name, select] of mappings) byNamespace[name] = select.value;
			const commonTasks: CommonTaskPolicy =
				common.value === "leave-unscoped"
					? { kind: "leave-unscoped" }
					: { kind: "assign", scopeId: common.value };
			const planned = planNamespaceMigration(
				discovered.inventory,
				{ byNamespace },
				{
					taskCoverage: coverage.value,
					commonTasks,
					targetInboxPath: this.plugin.settings.inboxFile,
				},
				this.plugin.scopes.current(),
			);
			if (!planned.ok) {
				new Notice(`GTD Flow: dry-run не построен: ${planned.errors.join("; ")}`);
				return;
			}
			const revision = ++this.previewRevision;
			previewButton.disabled = true;
			void this.bindAndRenderPreview(planned.preview, revision, previewButton);
		});
	}

	private async bindAndRenderPreview(
		preview: NamespaceMigrationPreview,
		revision: number,
		button: HTMLButtonElement,
	): Promise<void> {
		try {
			const bound = await this.plugin.namespaceMigration.bindPreview(preview);
			if (revision !== this.previewRevision) return;
			this.preview = bound;
			this.renderPreview();
		} catch (error: unknown) {
			if (revision === this.previewRevision) {
				new Notice(`GTD Flow: не удалось зафиксировать dry-run: ${String(error)}`);
			}
		} finally {
			button.disabled = false;
		}
	}

	private renderPreview(): void {
		if (this.preview === null) return;
		const p = this.preview;
		this.contentEl.querySelector(".gtd-namespace-migration-preview")?.remove();
		const wrap = this.contentEl.createDiv({ cls: "gtd-namespace-migration-preview" });
		wrap.createEl("h3", { text: "Dry-run (до записи в vault)" });
		wrap.createEl("pre", {
			text: [
				`🆔 Якоря (внутри журнала): ${p.anchors?.length ?? 0}`,
				...(p.anchors ?? []).map(
					(item) => `${item.filePath}:${item.line + 1} → 🆔 ${item.taskId}`,
				),
				`🧭 Аннотации: ${p.annotations.length}`,
				...p.annotations.map(
					(item) => `${item.filePath}:${item.line + 1} ${item.taskId} → ${item.scopeId}`,
				),
				`↪ Переносы Inbox: ${p.inboxMoves.length}`,
				...p.inboxMoves.map((item) => `${item.taskId}: ${item.fromPath} → ${item.toPath}`),
				`Пропущено: ${p.skipped.length}`,
			].join("\n"),
		});
		const apply = wrap.createEl("button", { text: "Подтвердить и применить" });
		apply.addEventListener("click", () => {
			this.contentEl.querySelectorAll("select, button").forEach((control) => {
				(control as HTMLSelectElement | HTMLButtonElement).disabled = true;
			});
			void this.applyPreview(p);
		});
	}

	private async applyPreview(approved: NamespaceMigrationPreview): Promise<void> {
		const currentInventory = this.plugin.legacyNamespaceMigrationInventory();
		const currentPlan = planNamespaceMigration(
			currentInventory.inventory,
			{
				byNamespace: Object.fromEntries(
					approved.namespaceMappings.map((item) => [item.namespace, item.scopeId]),
				),
			},
			{ ...approved.policy, targetInboxPath: this.plugin.settings.inboxFile },
			this.plugin.scopes.current(),
		);
		let currentPreview: NamespaceMigrationPreview | null = null;
		if (currentPlan.ok) {
			try {
				currentPreview = await this.plugin.namespaceMigration.bindPreview(
					currentPlan.preview,
				);
			} catch {
				currentPreview = null;
			}
		}
		if (
			currentPreview === null ||
			JSON.stringify(currentPreview) !== JSON.stringify(approved)
		) {
			this.preview = null;
			new Notice(
				"GTD Flow: vault или scopes изменились после dry-run; постройте план снова.",
			);
			this.render();
			return;
		}
		let journal: NamespaceMigrationJournal;
		try {
			journal = await this.plugin.namespaceMigration.prepare(approved);
		} catch (error: unknown) {
			this.preview = null;
			new Notice(
				`GTD Flow: исходные задачи изменились после dry-run; постройте план снова (${String(error)}).`,
			);
			this.render();
			return;
		}
		const result = await this.plugin.namespaceMigration.apply(journal.id);
		if (!result.ok) {
			new Notice(`GTD Flow: миграция остановлена: ${result.error}. Журнал: ${journal.id}`);
			return;
		}
		new Notice(`GTD Flow: миграция завершена. Журнал: ${journal.id}`);
		this.close();
	}
}

async function capture(plugin: GtdFlowPlugin, text: string): Promise<void> {
	const line = quickCaptureLine(text);
	if (line === null) return; // пустой ввод — молча ничего
	const target = plugin.settings.inboxFile;
	try {
		if (!(await ensureCaptureFile(plugin.vaultAdapter, target))) {
			new Notice(
				`GTD Flow: не удалось подготовить файл входящих ${target}\nТекст: ${text}`,
				0,
			);
			return;
		}
		const ok = await plugin.vaultAdapter.processFile(target, (content) =>
			appendLine(content, line),
		);
		if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}`);
	} catch (e) {
		// модалка уже закрыта — возвращаем текст в уведомлении, чтобы ввод
		// не пропал молча (ensureFile кидает на гонке create/кривом пути)
		new Notice(`GTD Flow: не удалось записать в ${target}: ${String(e)}\nТекст: ${text}`, 0);
	}
}

// ---------------------------------------------------------------------------
// Проход регулярных
// ---------------------------------------------------------------------------

async function syncExternalCalendars(plugin: GtdFlowPlugin): Promise<void> {
	if (plugin.settings.externalCalendars.length === 0) {
		new Notice("GTD Flow: внешние календари не настроены");
		return;
	}
	new Notice("GTD Flow: синхронизация внешних календарей…");
	// Терминальный отчёт (§10): dispatch не есть успех — уведомление обязано
	// различать ok/partial/error и не имеет права показывать сырые ошибки.
	const report = await plugin.desktopCalendarSync().syncAll();
	const failed = report.subscriptions.filter((s) => s.status === "error").length;
	const attempted = report.subscriptions.filter((s) => s.status !== "skipped").length;
	if (report.status === "ok") {
		new Notice(
			`GTD Flow: синхронизация завершена (обновлено зеркал: ${report.changedMirrors})`,
		);
	} else if (report.status === "partial") {
		new Notice(
			`GTD Flow: синхронизация выполнена частично — с ошибкой ${failed} из ${attempted} подписок (см. настройки)`,
		);
	} else {
		new Notice("GTD Flow: синхронизация не удалась — все подписки с ошибками (см. настройки)");
	}
}

async function resumeNamespaceMigration(plugin: GtdFlowPlugin, id: string): Promise<void> {
	const result = await plugin.namespaceMigration.apply(id);
	if (!result.ok) {
		new Notice(`GTD Flow: миграция ${id} остановлена: ${result.error}`);
		return;
	}
	new Notice(`GTD Flow: миграция ${id} завершена`);
}

async function rollbackNamespaceMigration(plugin: GtdFlowPlugin, id: string): Promise<void> {
	const result = await plugin.namespaceMigration.rollback(id);
	if (!result.ok) {
		new Notice(`GTD Flow: откат ${id} остановлен: ${result.error}`);
		return;
	}
	new Notice(`GTD Flow: миграция ${id} откачена`);
}

async function runRecurrencePass(plugin: GtdFlowPlugin): Promise<void> {
	try {
		const rep = await plugin.recurrence.runPass();
		const parts = [
			`создано ${rep.spawned}`,
			`курсоров ${rep.advanced}`,
			`дедуп ${rep.deduped}`,
		];
		if (rep.conflicts.length > 0) parts.push(`конфликтов ${rep.conflicts.length}`);
		if (rep.errors.length > 0) parts.push(`ошибок ${rep.errors.length}`);
		new Notice(`GTD Flow: проход повторов — ${parts.join(", ")}`);
	} catch (e) {
		new Notice(`GTD Flow: проход повторов не удался: ${String(e)}`);
	}
}

async function processInboxWithAi(plugin: GtdFlowPlugin): Promise<void> {
	const summary = await desktopAi(plugin).process();
	await showAiProcessingSummary(plugin, summary);
}

function cancelActiveAiInboxProcessing(plugin: GtdFlowPlugin): void {
	const cancelled = desktopAi(plugin).cancelProcessing();
	new Notice(
		cancelled === 0
			? "GTD Flow: активных AI-обработок входящих нет"
			: `GTD Flow: отменено AI-обработок входящих — ${cancelled}`,
	);
}

async function reprocessAtCursorWithAi(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const summary = await desktopAi(plugin).reprocessTask(task);
	await showAiProcessingSummary(plugin, summary);
}

async function unlockAiFieldAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	if (task.taskId === null) {
		new Notice("GTD Flow: у задачи ещё нет AI-истории или стабильного 🆔");
		return;
	}
	const provenance = await plugin.taskMetadata.provenanceForTask(task.taskId);
	const fields = ESTIMATE_FIELDS.filter(
		(field) =>
			provenance?.fields[field].locked === true || provenance?.fields[field].owner === "user",
	);
	if (fields.length === 0) {
		new Notice("GTD Flow: у задачи нет заблокированных AI-полей");
		return;
	}
	new EstimateFieldPickerModal(plugin.app, fields, (field) =>
		reportAsync("AI-поле не разблокировано", async () => {
			const result = await plugin.taskMetadata.unlockFieldAndReprocess(task, field);
			if (!result.ok) {
				new Notice(`GTD Flow: ${result.reason}`);
				return;
			}
			new Notice("GTD Flow: поле разблокировано и переоценено");
		}),
	).open();
}

async function retryWaitingAiJobs(plugin: GtdFlowPlugin): Promise<void> {
	const summaries = await desktopAi(plugin).retryWaiting();
	if (summaries.length === 0) {
		new Notice("GTD Flow: готовых к повтору AI-запусков нет");
		return;
	}
	const applied = summaries.reduce((sum, item) => sum + item.applied, 0);
	const rateLimited = summaries.filter((item) => item.state === "rate_limited").length;
	const retryWaiting = summaries.filter((item) => item.state === "retry_waiting").length;
	new Notice(
		`GTD Flow: повторено запусков ${summaries.length}, применено задач ${applied}, лимит ёмкости ожидают ${rateLimited}, повторную попытку ожидают ${retryWaiting}`,
	);
}

async function showAiProcessingSummary(
	plugin: GtdFlowPlugin,
	summary: ProcessInboxSummary,
): Promise<void> {
	if (summary.state === "blocked-no-scopes") {
		new Notice("GTD Flow: сначала создайте хотя бы один активный scope в настройках");
		return;
	}
	if (summary.state === "nothing-to-process") {
		new Notice("GTD Flow: подходящих задач для AI-обработки нет");
		return;
	}
	if (summary.state === "rate_limited") {
		new Notice(
			`GTD Flow: бесплатная ёмкость исчерпана; запуск ожидает${summary.nextEligibleAt ? ` до ${summary.nextEligibleAt}` : ""}`,
		);
		return;
	}
	if (summary.state === "retry_waiting") {
		new Notice(
			`GTD Flow: временная ошибка AI; запуск ожидает повторной попытки${summary.nextEligibleAt ? ` до ${summary.nextEligibleAt}` : ""}`,
		);
		return;
	}
	if (summary.state === "cancelled") {
		new Notice("GTD Flow: AI-обработка отменена");
		return;
	}
	const details = [
		`применено ${summary.applied}`,
		`защищённых полей ${summary.skippedLocked}`,
		`ошибок ${summary.failed.length}`,
		`вопросов ${summary.questions.length}`,
	];
	new Notice(`GTD Flow: AI-обработка — ${details.join(", ")}`);
	if (summary.questions.length > 0 && summary.sessionId !== null) {
		await desktopAi(plugin).openSession(summary.sessionId);
	}
}

function desktopAi(plugin: GtdFlowPlugin): NonNullable<GtdFlowPlugin["ai"]> {
	if (plugin.ai === null) throw new Error("desktop-ai-unavailable");
	return plugin.ai;
}

// ---------------------------------------------------------------------------
// Команды «под курсором»
// ---------------------------------------------------------------------------

/** Задача индекса по строке под курсором; null — не задача / индекс отстаёт. */
function taskUnderCursor(plugin: GtdFlowPlugin, editor: Editor, path: string | null): Task | null {
	if (path === null) return null;
	const lineNo = editor.getCursor().line;
	return findTaskAtLine(
		plugin.taskStore.index().fileTasks(path),
		editor.getLine(lineNo),
		path,
		lineNo,
	);
}

function noticeNoTask(): void {
	new Notice("GTD Flow: под курсором нет задачи (или индекс её ещё не увидел)");
}

async function cardAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	// поле cards появляется на плагине при связке CardService в main.ts — читаем опционально
	const cards = (plugin as GtdFlowPlugin & { cards?: CardPort }).cards ?? null;
	if (cards === null) {
		new Notice("GTD Flow: сервис карточек недоступен");
		return;
	}
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const res = await cards.openOrCreate(task.key);
	if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
}

async function deferAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const date = await pickDate(plugin.app, "Отложить до", task.start ?? undefined);
	if (date === null) return;
	const res = await plugin.dispatcher.dispatch({ type: "defer", key: task.key, until: date });
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
}

async function columnAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const found = plugin.boards.discoverBoards().boards;
	if (found.length === 0) {
		new Notice("GTD Flow: досок не найдено");
		return;
	}
	const choice = await pickBoardColumn(plugin.app, found);
	if (choice === null) return;
	// «в конец колонки»: insertIntoColumnOrder клампит индекс к длине
	const res = await plugin.boards.moveCard(
		choice.boardPath,
		choice.def,
		task.key,
		choice.colId,
		Number.MAX_SAFE_INTEGER,
	);
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
}
