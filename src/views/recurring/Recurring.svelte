<script lang="ts">
	import { Menu, Notice, type App } from "obsidian";
	import { derived, get, type Readable } from "svelte/store";
	import {
		DEFAULT_NS,
		NS_CONVENTION,
		nsTargetPath,
		type NamespaceDef,
		type NamespaceFilter,
	} from "../../core/namespace/namespace";
	import type { Task } from "../../core/model/Task";
	import { isParseError } from "../../core/recurrence/grammar";
	import type { CardPort } from "../../services/CardService";
	import type { RecurrencePort, SpawnReport } from "../../services/RecurrenceService";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { templatesStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { segmentDescription } from "../common/cardFormat";
	import { confirm } from "../common/ConfirmModal";
	import NamespaceSwitcher from "../common/NamespaceSwitcher.svelte";
	import { namespaceLabel } from "../common/namespaceSwitcher";
	import { openTaskInFile } from "../common/openTask";
	import { reportAsync } from "../common/runAction";
	import { recurringFilePathsInNamespace } from "../common/taskActions";
	import { RuleEditModal } from "./RuleEditModal";
	import { TemplateCreateModal } from "./TemplateCreateModal";
	import {
		buildTemplateVM,
		createTemplate,
		deleteTemplateBody,
		groupByFileAndHeading,
		historyOf,
		type TemplateVaultPort,
		type TemplateVM,
	} from "./recurringLogic";

	let {
		taskStore,
		dispatcher,
		settings,
		settingsRevision,
		app,
		recurrence = null,
		cards = null,
		vault,
		activeNamespace,
		namespaces: _namespaces,
		setActiveNamespace,
	}: {
		taskStore: TaskStore;
		/** Удаление строки-шаблона идёт штатным delete-line, а не RecurrencePort. */
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		settingsRevision: Readable<number>;
		app: App;
		/** null — движок повторов не подключён: карточки read-only + подсказка. */
		recurrence?: RecurrencePort | null;
		/** null — сервис карточек не подключён: пункт «Открыть карточку» скрыт. */
		cards?: CardPort | null;
		/** Структурный порт файла шаблонов (создание шаблона с нуля); ~ VaultAdapter. */
		vault: TemplateVaultPort;
		/** Реактивное ЛОКАЛЬНОЕ активное пространство вида (per-tab, см. GtdView). */
		activeNamespace: Readable<string>;
		/** Снимок списка пространств (settings.namespaces). */
		namespaces: readonly NamespaceDef[];
		/** Смена ЛОКАЛЬНОГО пространства этого вида (persist в viewState). */
		setActiveNamespace: (name: string) => void;
	} = $props();

	const liveNamespaces = $derived.by(() => {
		void $settingsRevision;
		return settings.namespaces;
	});
	// Фильтр пространства для templatesStore: смена ЛОКАЛЬНОГО пространства вида
	// пере-рендерит вид подпиской стора (эпоху индекса не бампает).
	// svelte-ignore state_referenced_locally
	const namespace$: Readable<NamespaceFilter> = derived(activeNamespace, (a) => ({
		active: a,
		defs: liveNamespaces,
	}));

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	let templates = $state<Task[]>([]);
	$effect(() => {
		void $settingsRevision;
		const store = templatesStore(
			taskStore,
			settings.debounceMs.queryRecompute,
			namespace$,
			settingsRevision,
		);
		return store.subscribe((value) => (templates = value));
	});
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;
	// svelte-ignore state_referenced_locally
	const epoch = taskStore.epoch;
	/** Метка активного пространства для шапки/пустого состояния — только когда настроено. */
	const nsLabel = $derived(liveNamespaces.length === 0 ? null : namespaceLabel($activeNamespace));

	const groups = $derived(
		groupByFileAndHeading(templates.map((t) => buildTemplateVM(t, $today))),
	);

	// история читает индекс напрямую (копии — не шаблоны, в $templates их нет);
	// $epoch в зависимостях — пересчёт на каждую смену индекса
	const allTasks = $derived.by(() => {
		void $epoch;
		return [...taskStore.index().all()];
	});

	let openHistory = $state<Record<string, boolean>>({});
	/** Последний отчёт runPass — живёт только в сессии вида, не персистится. */
	let lastReport = $state<SpawnReport | null>(null);
	let running = $state(false);

	async function checkNow(): Promise<void> {
		const port = recurrence;
		if (port === null || running) return;
		running = true;
		try {
			const rep = await port.runPass();
			lastReport = rep;
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
		} finally {
			running = false;
		}
	}

	/** «＋ Шаблон»: имя+правило → append строки `- [ ] <имя> 🔁 <правило>` в файл
	 *  шаблонов (создаётся с gtd-recurring при отсутствии). Движок повторов для
	 *  записи не нужен — строка появится в виде на ближайший bump индекса. */
	function createTemplateNow(): void {
		new TemplateCreateModal(app, (name, ruleText) => {
			void (async () => {
				try {
					// цель ＋ Шаблон — в АКТИВНОМ пространстве: первый его gtd-recurring
					// файл, иначе <root>/Регулярные.md (именованное) / логика spawnTarget
					// («Общее»). Значение активного берём в момент подтверждения модала.
					const active = get(activeNamespace);
					const res = await createTemplate({
						vault,
						recurringFiles: recurringFilePathsInNamespace(
							taskStore.index().all(),
							active,
							liveNamespaces,
						),
						spawnTarget: settings.recurring.spawnTarget,
						recurringFallback:
							active === DEFAULT_NS
								? undefined
								: nsTargetPath(active, liveNamespaces, NS_CONVENTION.recurring, ""),
						name,
						ruleText,
					});
					new Notice(
						res.ok
							? `GTD Flow: шаблон создан → ${res.path}`
							: `GTD Flow: шаблон не создан: ${res.reason}`,
					);
				} catch (e) {
					new Notice(`GTD Flow: шаблон не создан: ${String(e)}`);
				}
			})();
		}).open();
	}

	async function togglePause(port: RecurrencePort, vm: TemplateVM): Promise<void> {
		try {
			if (vm.paused) await port.resume(vm.key);
			else await port.pause(vm.key);
		} catch (e) {
			new Notice(`GTD Flow: не удалось переключить шаблон: ${String(e)}`);
		}
	}

	async function spawnNow(port: RecurrencePort, vm: TemplateVM): Promise<void> {
		try {
			const res = await port.spawnNow(vm.key);
			new Notice(
				res.ok
					? "GTD Flow: копия создана"
					: `GTD Flow: спавн не выполнен: ${res.reason ?? "unknown"}`,
			);
		} catch (e) {
			new Notice(`GTD Flow: спавн не выполнен: ${String(e)}`);
		}
	}

	function editRule(port: RecurrencePort, vm: TemplateVM): void {
		new RuleEditModal(app, vm.ruleText, (text) => {
			void (async () => {
				try {
					const res = await port.setRule(vm.key, text);
					if (!res.ok) {
						new Notice(
							`GTD Flow: правило не сохранено: ${res.parseError ?? "unknown"}`,
						);
					}
				} catch (e) {
					new Notice(`GTD Flow: правило не сохранено: ${String(e)}`);
				}
			})();
		}).open();
	}

	async function deleteTemplate(vm: TemplateVM): Promise<void> {
		const ok = await confirm(
			app,
			"Удалить шаблон?",
			deleteTemplateBody(vm.description),
			"Удалить шаблон",
		);
		if (!ok) return;
		// delete-line сверяет rawLine — для строки из индекса совпадение гарантировано
		const res = await dispatcher.dispatch({ type: "delete-line", key: vm.key });
		if (res.ok) new Notice("GTD Flow: шаблон удалён");
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	function openMenu(e: MouseEvent, vm: TemplateVM): void {
		const menu = new Menu();
		const port = recurrence;
		if (port !== null) {
			menu.addItem((item) =>
				item
					.setSection("actions")
					.setIcon(vm.paused ? "play" : "pause")
					.setTitle(vm.paused ? "Возобновить" : "Пауза")
					.onClick(() => void togglePause(port, vm)),
			);
			menu.addItem((item) =>
				item
					.setSection("actions")
					.setIcon("zap")
					.setTitle("Запустить сейчас")
					.onClick(() => void spawnNow(port, vm)),
			);
			menu.addItem((item) =>
				item
					.setSection("actions")
					.setIcon("pencil")
					.setTitle("Изменить правило…")
					.onClick(() => editRule(port, vm)),
			);
		}
		const cardPort = cards;
		if (cardPort !== null) {
			menu.addItem((item) =>
				item
					.setSection("nav")
					.setIcon("panel-right")
					.setTitle("Открыть карточку")
					.onClick(() =>
						reportAsync("не удалось открыть карточку", async () => {
							const res = await cardPort.openOrCreate(vm.key);
							if (!res.ok)
								new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
						}),
					),
			);
		}
		menu.addItem((item) =>
			item
				.setSection("nav")
				.setIcon("file-text")
				.setTitle("Открыть в файле")
				.onClick(() => void openTaskInFile(app, vm.task)),
		);
		// Удаление строки — обычный delete-line через dispatcher, независимо от того,
		// подключён ли движок повторов (симметрия к «Удалить серию» у событий).
		menu.addItem((item) =>
			item
				.setSection("danger")
				.setIcon("trash-2")
				.setTitle("Удалить шаблон…")
				.onClick(() => reportAsync("не удалось удалить шаблон", () => deleteTemplate(vm))),
		);
		menu.showAtMouseEvent(e);
	}

	function toggleHistory(key: string): void {
		openHistory[key] = openHistory[key] !== true;
	}
</script>

<div class="gtd-recurring">
	<div class="gtd-rec-header">
		<button
			class="mod-cta"
			onclick={createTemplateNow}
			title="Создать шаблон регулярной задачи"
		>
			＋ Шаблон
		</button>
		<button disabled={recurrence === null || running} onclick={() => void checkNow()}>
			Проверить сейчас
		</button>
		{#if lastReport !== null}
			<span class="gtd-rec-report">
				создано {lastReport.spawned} · курсоров {lastReport.advanced} · дедуп {lastReport.deduped}
			</span>
		{/if}
		<span class="gtd-rec-spacer"></span>
		<NamespaceSwitcher
			active={activeNamespace}
			namespaces={liveNamespaces}
			onSelect={setActiveNamespace}
		/>
	</div>

	{#if recurrence === null}
		<div class="gtd-rec-hint">
			Движок повторов не подключён — шаблоны в режиме «только чтение».
		</div>
	{/if}

	{#if lastReport !== null && (lastReport.conflicts.length > 0 || lastReport.errors.length > 0)}
		<div class="gtd-rec-problems">
			{#if lastReport.conflicts.length > 0}
				<div class="gtd-rec-problems-title">
					Конфликты дедупа ({lastReport.conflicts.length}) — разберите вручную:
				</div>
				{#each lastReport.conflicts as c, index (index)}
					<div class="gtd-rec-problem">⚠ {c}</div>
				{/each}
			{/if}
			{#if lastReport.errors.length > 0}
				<div class="gtd-rec-problems-title">
					Ошибки прохода ({lastReport.errors.length}):
				</div>
				{#each lastReport.errors as err, index (index)}
					<div class="gtd-rec-problem">✕ {err.templateId ?? "без 🆔"}: {err.message}</div>
				{/each}
			{/if}
		</div>
	{/if}

	{#each groups as group, index (index)}
		<section class="gtd-rec-group">
			<div class="gtd-rec-group-title">
				<span class="gtd-rec-group-file">{group.filePath}</span>
				{#if group.heading !== null}
					<span class="gtd-rec-group-heading">› {group.heading}</span>
				{/if}
			</div>
			{#each group.templates as vm (vm.key)}
				<div class="gtd-rec-card" class:is-paused={vm.paused}>
					<div class="gtd-rec-main">
						<div class="gtd-rec-desc">
							{#each segmentDescription(vm.description) as seg (seg.text)}{#if seg.tag}<span
										class="tag">{seg.text}</span
									>{:else}{seg.text}{/if}{/each}
						</div>
						<div class="gtd-rec-rule">🔁 {vm.ruleText !== "" ? vm.ruleText : "—"}</div>
						<div class="gtd-rec-next">след. вхождение: 🔜 {vm.nextSpawn ?? "—"}</div>
						{#if vm.badges.length > 0}
							<div class="gtd-rec-badges">
								{#if vm.paused}
									<span class="gtd-rec-badge is-paused-badge">⏸ пауза</span>
								{/if}
								{#if isParseError(vm.ruleParsed)}
									<span
										class="gtd-rec-badge is-error"
										title={vm.ruleParsed.error}
									>
										⚠ {vm.ruleParsed.error}
									</span>
								{/if}
								{#if vm.expired}
									<span class="gtd-rec-badge is-expired">⌛ истекло</span>
								{/if}
							</div>
						{/if}
					</div>
					<div class="gtd-rec-actions">
						<button
							class="gtd-rec-btn"
							aria-expanded={openHistory[vm.key] === true}
							onclick={() => toggleHistory(vm.key)}
						>
							История
						</button>
						<button
							class="gtd-rec-btn gtd-rec-more"
							aria-label="Меню шаблона"
							onclick={(e) => openMenu(e, vm)}
						>
							⋯
						</button>
					</div>
				</div>
				{#if openHistory[vm.key] === true}
					<div class="gtd-rec-history">
						{#if vm.task.taskId === null}
							<div class="gtd-rec-history-empty">
								У шаблона нет 🆔 — история копий недоступна.
							</div>
						{:else}
							{#each historyOf(allTasks, vm.task.taskId) as item (item.key)}
								<div class="gtd-rec-history-item">
									<span class="gtd-rec-history-status">[{item.statusChar}]</span>
									<span class="gtd-rec-history-desc">{item.description}</span>
									<span class="gtd-rec-history-date"
										>➕ {item.created ?? "—"}</span
									>
									<button
										class="gtd-rec-btn"
										onclick={() => void openTaskInFile(app, item)}
									>
										Открыть в файле
									</button>
								</div>
							{:else}
								<div class="gtd-rec-history-empty">Копий пока нет.</div>
							{/each}
						{/if}
					</div>
				{/if}
			{/each}
		</section>
	{:else}
		<div class="gtd-rec-empty">
			<p>Пока нет ни одного шаблона{nsLabel !== null ? ` · ${nsLabel}` : ""}.</p>
			<button class="mod-cta" onclick={createTemplateNow}>＋ Создать шаблон</button>
		</div>
	{/each}
</div>

<style>
	.gtd-recurring {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
	.gtd-rec-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-rec-report {
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-rec-spacer {
		flex: 1 1 auto;
	}
	.gtd-rec-hint {
		padding: 6px 10px;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		background: var(--background-secondary);
	}
	.gtd-rec-problems {
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
	}
	.gtd-rec-problems-title {
		font-weight: 600;
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-warning, var(--text-muted));
	}
	.gtd-rec-problem {
		padding-left: 8px;
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.gtd-rec-group-title {
		display: flex;
		gap: 6px;
		align-items: baseline;
		padding: 8px 10px 4px;
		font-weight: 600;
		background: var(--background-secondary);
	}
	.gtd-rec-group-heading {
		color: var(--text-muted);
		font-weight: 400;
	}
	.gtd-rec-card {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-rec-card:hover {
		background: var(--background-secondary);
	}
	.gtd-rec-card.is-paused .gtd-rec-desc {
		color: var(--text-muted);
	}
	.gtd-rec-main {
		flex: 1 1 auto;
		min-width: 0;
	}
	.gtd-rec-desc {
		overflow-wrap: anywhere;
	}
	.gtd-rec-desc .tag {
		color: var(--text-accent);
		background: var(--background-secondary-alt);
		border-radius: var(--radius-s, 4px);
		padding: 0 4px;
		font-size: 0.9em;
	}
	.gtd-rec-rule,
	.gtd-rec-next {
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
		margin-top: 2px;
		overflow-wrap: anywhere;
	}
	.gtd-rec-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 3px;
	}
	.gtd-rec-badge {
		font-size: var(--font-ui-smaller, 0.85em);
		border-radius: var(--radius-s, 4px);
		padding: 0 6px;
		background: var(--background-secondary-alt);
		color: var(--text-muted);
	}
	.gtd-rec-badge.is-error {
		color: var(--text-error, var(--text-normal));
		overflow-wrap: anywhere;
	}
	.gtd-rec-badge.is-expired {
		color: var(--text-warning, var(--text-muted));
	}
	.gtd-rec-actions {
		flex: none;
		display: flex;
		gap: 4px;
	}
	.gtd-rec-btn {
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px 6px;
		border-radius: var(--radius-s, 4px);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-rec-btn:hover {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
	}
	.gtd-rec-more {
		font-size: inherit;
	}
	.gtd-rec-history {
		padding: 4px 10px 8px 26px;
		border-bottom: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
	}
	.gtd-rec-history-item {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 2px 0;
		font-size: var(--font-ui-smaller, 0.9em);
	}
	.gtd-rec-history-status {
		font-family: var(--font-monospace);
		color: var(--text-muted);
		flex: none;
	}
	.gtd-rec-history-desc {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.gtd-rec-history-date {
		color: var(--text-muted);
		flex: none;
	}
	.gtd-rec-history-empty {
		color: var(--text-faint);
		font-size: var(--font-ui-smaller, 0.85em);
		padding: 2px 0;
	}
	.gtd-rec-empty {
		padding: 24px 12px;
		text-align: center;
		color: var(--text-muted);
	}
	.gtd-rec-empty p {
		margin: 0 0 12px;
	}
</style>
