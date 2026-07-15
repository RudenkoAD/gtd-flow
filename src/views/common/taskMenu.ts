/**
 * Единое контекстное меню карточки (ТЗ §8, слой 3 — обязательный паритет без
 * drag). Модель пунктов строит чистый buildMenuModel (taskMenuModel.ts);
 * здесь — только маппинг модели на obsidian Menu и исполнение интерактивных
 * действий (пикеры, порты сервисов).
 *
 * Порты приходят опционально: нет сервиса — нет пункта (модель сама скрывает).
 */
import { Menu, Notice, type App } from "obsidian";
import type { Readable } from "svelte/store";
import type { Intent } from "../../core/intents/Intent";
import type { IsoDate, Task } from "../../core/model/Task";
import type { BoardDef } from "../../core/board/boardFile";
import type { CardPort } from "../../services/CardService";
import type { DiscoveredBoard } from "../../services/BoardService";
import type { ProjectSummary } from "../../services/ProjectService";
import type { IntentDispatcher, IntentResult } from "../../services/WritebackService";
import type { GtdFlowSettings } from "../../settings/Settings";
import type GtdFlowPlugin from "../../main";
import { localTodayIso } from "../../services/snapshotHelpers";
import { confirm } from "./ConfirmModal";
import { openTaskInFile } from "./openTask";
import { pickBoardColumn, pickDate, pickProject } from "./pickers";
import {
	moveTaskToTemplates,
	recurringFilePaths,
	type TemplateVaultPort,
} from "./taskActions";
import { buildMenuModel, type MenuAction } from "./taskMenuModel";

export type { CardPort } from "../../services/CardService";

// ---------------------------------------------------------------------------
// Порты (структурные срезы сервисов — виды не тянут классы целиком)
// ---------------------------------------------------------------------------

/** Срез BoardService: обнаружение досок + перенос карточки. */
export interface BoardMenuPort {
	discoverBoards(): { boards: DiscoveredBoard[] };
	moveCard(
		boardPath: string,
		def: BoardDef,
		taskKey: string,
		toColId: string,
		insertIndex: number,
	): Promise<IntentResult>;
}

/** Срез ProjectService: только список проектов (перенос — move-line). */
export interface ProjectMenuPort {
	discoverProjects(): ProjectSummary[];
}

/** Порты «Сделать шаблоном…»: где лежат шаблоны и чем создать файл. */
export interface TemplateMenuPort {
	recurringFiles(): string[];
	spawnTarget(): string;
	vault: TemplateVaultPort;
}

/** Связка портов паритета; каждый опционален — вид работает и без них. */
export interface TaskMenuPorts {
	boards?: BoardMenuPort | null;
	projects?: ProjectMenuPort | null;
	cards?: CardPort | null;
	template?: TemplateMenuPort | null;
	/** Смена индекса — для реактивного прогресса n/m на карточке. */
	epoch?: Readable<number> | null;
}

/**
 * Сборка портов из полей плагина — единая точка для всех *View.ts.
 * Поля читаются опционально (паттерн видов): чего нет — того нет в меню.
 */
export function taskMenuPortsFromPlugin(plugin: GtdFlowPlugin): TaskMenuPorts {
	const p = plugin as GtdFlowPlugin & { cards?: CardPort };
	return {
		boards: plugin.boards ?? null,
		projects: plugin.projects ?? null,
		cards: p.cards ?? null,
		template: {
			recurringFiles: () => recurringFilePaths(plugin.taskStore.index().all()),
			spawnTarget: () => plugin.settings.recurring.spawnTarget,
			vault: {
				ensureFile: (path) => plugin.vaultAdapter.ensureFile(path),
				processFrontmatter: (path, fn) => plugin.vaultAdapter.processFrontmatter(path, fn),
			},
		},
		epoch: plugin.taskStore.epoch,
	};
}

// ---------------------------------------------------------------------------
// Меню
// ---------------------------------------------------------------------------

export interface TaskMenuCtx {
	task: Task;
	app: App;
	dispatcher: IntentDispatcher;
	settings: GtdFlowSettings;
	today: IsoDate;
	/** Пункт «Вернуть во входящие» — только из вида отложенных. */
	inTickler?: boolean;
	ports?: TaskMenuPorts | null;
}

export function buildTaskMenu(ctx: TaskMenuCtx): Menu {
	const ports = ctx.ports ?? null;
	const model = buildMenuModel({
		task: ctx.task,
		today: ctx.today,
		deferPresets: ctx.settings.deferPresets,
		inTickler: ctx.inTickler === true,
		hasBoards: ports?.boards != null,
		hasProjects: ports?.projects != null,
		hasCards: ports?.cards != null,
		hasTemplates: ports?.template != null,
	});
	const menu = new Menu();
	for (const item of model) {
		menu.addItem((mi) => {
			mi.setSection(item.section).setTitle(item.title);
			if (item.icon !== undefined) mi.setIcon(item.icon);
			if (item.checked !== undefined) mi.setChecked(item.checked);
			mi.onClick(() => void runMenuAction(ctx, item.action));
		});
	}
	return menu;
}

/** Единая точка write-back меню: отказ — уведомление, а не тихо съеденный клик. */
async function dispatchNoticing(
	dispatcher: IntentDispatcher,
	intent: Intent,
): Promise<IntentResult> {
	const res = await dispatcher.dispatch(intent);
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	return res;
}

/**
 * Defer с явным откликом: карточка после отложки исчезает из текущего вида
 * (или вовсе не меняется видимо, если 🛫 уже стоял на эту дату) — без Notice
 * это читалось как «кнопка ничего не делает».
 *
 * Политика «🛫 и 📅 взаимоисключающие»: отложить запланированную задачу
 * можно только сняв её с плана — конфликт решает пользователь диалогом,
 * запись обоих полей атомарна (defer + clearDue в одной трансформации).
 */
async function dispatchDefer(ctx: TaskMenuCtx, until: IsoDate): Promise<void> {
	let clearDue = false;
	if (ctx.task.due !== null) {
		const ok = await confirm(
			ctx.app,
			"Снять с плана?",
			`Задача запланирована на ${ctx.task.due}. Отложенная задача не может ` +
				`оставаться в плане: отложить до ${until} и снять с плана?`,
			"Отложить и снять план",
		);
		if (!ok) return;
		clearDue = true;
	}
	const res = await dispatchNoticing(ctx.dispatcher, {
		type: "defer",
		key: ctx.task.key,
		until,
		clearDue,
	});
	if (res.ok) new Notice(clearDue ? `Отложена до ${until}, план снят` : `Отложена до ${until}`);
}

async function runMenuAction(ctx: TaskMenuCtx, action: MenuAction): Promise<void> {
	const ports = ctx.ports ?? null;
	switch (action.kind) {
		case "intent":
			if (action.intent.type === "defer") return dispatchDefer(ctx, action.intent.until);
			return void (await dispatchNoticing(ctx.dispatcher, action.intent));

		case "pick-due": {
			// «Запланировать…» — единственный поток с временем (📅 HH:mm);
			// time: null (поле пусто) снимает существующее время, строка — ставит
			const choice = await pickDate(
				ctx.app,
				"Запланировать на",
				ctx.task.due ?? undefined,
				true,
				ctx.task.dueTime,
			);
			if (choice === null) return;
			// «🛫 и 📅 взаимоисключающие»: планирование реально отложенной задачи
			// (🛫 в будущем) возвращает её из отложенных — с подтверждением.
			// Инертный 🛫 в прошлом конфликтом не считается.
			let clearStart = false;
			if (ctx.task.start !== null && ctx.task.start > localTodayIso(new Date())) {
				const ok = await confirm(
					ctx.app,
					"Вернуть из отложенных?",
					`Задача отложена до ${ctx.task.start}. Запланированная задача не может ` +
						`оставаться отложенной: запланировать на ${choice.date} и вернуть из отложенных?`,
					"Запланировать и вернуть",
				);
				if (!ok) return;
				clearStart = true;
			}
			return void (await dispatchNoticing(ctx.dispatcher, {
				type: "set-date",
				key: ctx.task.key,
				field: "due",
				clearStart,
				date: choice.date,
				time: choice.time,
			}));
		}

		case "pick-defer": {
			const date = await pickDate(ctx.app, "Отложить до", ctx.task.start ?? undefined);
			if (date === null) return;
			return dispatchDefer(ctx, date);
		}

		case "pick-column": {
			const boards = ports?.boards;
			if (boards == null) return; // недостижимо: пункт скрыт моделью
			const found = boards.discoverBoards().boards;
			if (found.length === 0) {
				new Notice("GTD Flow: досок не найдено");
				return;
			}
			const choice = await pickBoardColumn(ctx.app, found);
			if (choice === null) return;
			// «в конец колонки»: insertIntoColumnOrder клампит индекс к длине
			const res = await boards.moveCard(
				choice.boardPath,
				choice.def,
				ctx.task.key,
				choice.colId,
				Number.MAX_SAFE_INTEGER,
			);
			if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			return;
		}

		case "pick-project": {
			const projects = ports?.projects;
			if (projects == null) return;
			const found = projects.discoverProjects();
			if (found.length === 0) {
				new Notice("GTD Flow: проектов не найдено");
				return;
			}
			const choice = await pickProject(ctx.app, found);
			if (choice === null) return;
			if (choice.path === ctx.task.filePath) return; // уже в этом проекте — no-op
			return void (await dispatchNoticing(ctx.dispatcher, {
				type: "move-line",
				key: ctx.task.key,
				toFile: choice.path,
			}));
		}

		case "make-template": {
			const tpl = ports?.template;
			if (tpl == null) return;
			const res = await moveTaskToTemplates({
				taskKey: ctx.task.key,
				recurringFiles: tpl.recurringFiles(),
				spawnTarget: tpl.spawnTarget(),
				vault: tpl.vault,
				dispatcher: ctx.dispatcher,
			});
			if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			else new Notice("GTD Flow: перенесено в шаблоны — заполните правило 🔁");
			return;
		}

		case "open-card": {
			const cards = ports?.cards;
			if (cards == null) return;
			const res = await cards.openOrCreate(ctx.task.key);
			if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
			return;
		}

		case "open-file":
			return openTaskInFile(ctx.app, ctx.task);
	}
}
