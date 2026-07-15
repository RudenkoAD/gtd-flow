<script lang="ts">
	import { Menu, Notice, type App } from "obsidian";
	import { isParseError } from "../../core/recurrence/grammar";
	import type { CardPort } from "../../services/CardService";
	import type { RecurrencePort, SpawnReport } from "../../services/RecurrenceService";
	import type { GtdFlowSettings } from "../../settings/Settings";
	import { templatesStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { segmentDescription } from "../common/cardFormat";
	import { openTaskInFile } from "../common/openTask";
	import { RuleEditModal } from "./RuleEditModal";
	import {
		buildTemplateVM,
		groupByFileAndHeading,
		historyOf,
		type TemplateVM,
	} from "./recurringLogic";

	let {
		taskStore,
		settings,
		app,
		recurrence = null,
		cards = null,
	}: {
		taskStore: TaskStore;
		settings: GtdFlowSettings;
		app: App;
		/** null — движок повторов не подключён: карточки read-only + подсказка. */
		recurrence?: RecurrencePort | null;
		/** null — сервис карточек не подключён: пункт «Открыть карточку» скрыт. */
		cards?: CardPort | null;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const templates = templatesStore(taskStore, settings.debounceMs.queryRecompute);
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;
	// svelte-ignore state_referenced_locally
	const epoch = taskStore.epoch;

	const groups = $derived(
		groupByFileAndHeading($templates.map((t) => buildTemplateVM(t, $today))),
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
			const parts = [`создано ${rep.spawned}`, `курсоров ${rep.advanced}`, `дедуп ${rep.deduped}`];
			if (rep.conflicts.length > 0) parts.push(`конфликтов ${rep.conflicts.length}`);
			if (rep.errors.length > 0) parts.push(`ошибок ${rep.errors.length}`);
			new Notice(`GTD Flow: проход повторов — ${parts.join(", ")}`);
		} catch (e) {
			new Notice(`GTD Flow: проход повторов не удался: ${String(e)}`);
		} finally {
			running = false;
		}
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
						new Notice(`GTD Flow: правило не сохранено: ${res.parseError ?? "unknown"}`);
					}
				} catch (e) {
					new Notice(`GTD Flow: правило не сохранено: ${String(e)}`);
				}
			})();
		}).open();
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
						void (async () => {
							const res = await cardPort.openOrCreate(vm.key);
							if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
						})(),
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
			disabled={recurrence === null || running}
			onclick={() => void checkNow()}
		>
			Проверить сейчас
		</button>
		{#if lastReport !== null}
			<span class="gtd-rec-report">
				создано {lastReport.spawned} · курсоров {lastReport.advanced} · дедуп {lastReport.deduped}
			</span>
		{/if}
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
				{#each lastReport.conflicts as c}
					<div class="gtd-rec-problem">⚠ {c}</div>
				{/each}
			{/if}
			{#if lastReport.errors.length > 0}
				<div class="gtd-rec-problems-title">Ошибки прохода ({lastReport.errors.length}):</div>
				{#each lastReport.errors as err}
					<div class="gtd-rec-problem">✕ {err.templateId ?? "без 🆔"}: {err.message}</div>
				{/each}
			{/if}
		</div>
	{/if}

	{#each groups as group}
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
							{#each segmentDescription(vm.description) as seg}{#if seg.tag}<span
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
									<span class="gtd-rec-badge is-error" title={vm.ruleParsed.error}>
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
									<span class="gtd-rec-history-date">➕ {item.created ?? "—"}</span>
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
			Шаблонов не найдено. Создайте заметку с frontmatter
			<code>gtd-recurring: true</code> и задачами с правилом <code>🔁</code>.
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
</style>
