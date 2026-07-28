/**
 * Единое контекстное меню карточки (ТЗ §8, слой 3 — обязательный паритет без
 * drag). Модель пунктов строит чистый buildMenuModel (taskMenuModel.ts);
 * здесь — только маппинг модели на obsidian Menu и исполнение интерактивных
 * действий (пикеры, порты сервисов).
 *
 * Порты приходят опционально: нет сервиса — нет пункта (модель сама скрывает).
 */
import { Menu, Notice, type App, type MenuItem } from "obsidian";
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
import { reportAsync } from "./runAction";
import { TextPromptModal } from "./TextPromptModal";
import {
	NS_CONVENTION,
	nsTargetPath,
	resolveNamespace,
	type NamespaceFilter,
} from "../../core/namespace/namespace";
import {
	ensureArchiveFile,
	moveTaskToTemplates,
	recurringFilePathsInNamespace,
	type FrontmatterVaultPort,
} from "./taskActions";
import {
	buildMenuModel,
	flattenSubmenu,
	isSubmenuNode,
	type MenuAction,
	type MenuItemModel,
	type MenuSubmenuModel,
} from "./taskMenuModel";

export type { CardPort } from "../../services/CardService";

// ---------------------------------------------------------------------------
// Порты (структурные срезы сервисов — виды не тянут классы целиком)
// ---------------------------------------------------------------------------

/** Срез BoardService: обнаружение досок + перенос карточки. filter — пространство
 *  ЗАДАЧИ (перенос внутри её пространства, не активного вида). */
export interface BoardMenuPort {
	discoverBoards(filter?: NamespaceFilter): { boards: DiscoveredBoard[] };
	moveCard(
		boardPath: string,
		def: BoardDef,
		taskKey: string,
		toColId: string,
		insertIndex: number,
	): Promise<IntentResult>;
}

/** Срез ProjectService: только список проектов (перенос — move-line). filter —
 *  пространство ЗАДАЧИ (перенос внутри её пространства, не активного вида). */
export interface ProjectMenuPort {
	discoverProjects(filter?: NamespaceFilter): ProjectSummary[];
}

/** Порты «Сделать шаблоном…»: где лежат шаблоны и чем создать файл.
 *  Методы принимают задачу: цели считаются в ЕЁ пространстве (не активном) —
 *  иначе шаблон утекал бы в первый глобальный файл регулярных (ревью). */
export interface TemplateMenuPort {
	recurringFiles(task: Task): string[];
	spawnTarget(task: Task): string;
	vault: FrontmatterVaultPort;
}

/** Связка портов паритета; каждый опционален — вид работает и без них. */
export interface TaskMenuPorts {
	boards?: BoardMenuPort | null;
	projects?: ProjectMenuPort | null;
	cards?: CardPort | null;
	template?: TemplateMenuPort | null;
	/** Создать файл архива и проставить gtd-archive: true — для «Архивировать». */
	archive?: FrontmatterVaultPort | null;
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
		archive: {
			ensureFile: (path) => plugin.vaultAdapter.ensureFile(path),
			processFrontmatter: (path, fn) => plugin.vaultAdapter.processFrontmatter(path, fn),
		},
		template: {
			// пространство ЗАДАЧИ (не активное): шаблон уходит в регулярные своего
			// пространства; «Общее» с пустым defs — прежнее глобальное поведение
			recurringFiles: (task) =>
				recurringFilePathsInNamespace(
					plugin.taskStore.index().all(),
					resolveNamespace(
						task.filePath,
						task.nsOverride ?? null,
						plugin.settings.namespaces,
					),
					plugin.settings.namespaces,
				),
			spawnTarget: (task) =>
				nsTargetPath(
					resolveNamespace(
						task.filePath,
						task.nsOverride ?? null,
						plugin.settings.namespaces,
					),
					plugin.settings.namespaces,
					NS_CONVENTION.inbox,
					plugin.settings.recurring.spawnTarget,
				),
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
	/** Пункт «Архивировать» — только из вида доски. */
	inBoard?: boolean;
	ports?: TaskMenuPorts | null;
}

export function buildTaskMenu(ctx: TaskMenuCtx): Menu {
	const ports = ctx.ports ?? null;
	const model = buildMenuModel({
		task: ctx.task,
		today: ctx.today,
		deferPresets: ctx.settings.deferPresets,
		inTickler: ctx.inTickler === true,
		inBoard: ctx.inBoard === true,
		hasBoards: ports?.boards != null,
		hasProjects: ports?.projects != null,
		hasCards: ports?.cards != null,
		hasTemplates: ports?.template != null,
	});
	const menu = new Menu();
	for (const node of model) {
		if (isSubmenuNode(node)) addSubmenuNode(menu, ctx, node);
		else addLeaf(menu, ctx, node);
	}
	return menu;
}

// ---------------------------------------------------------------------------
// Маппинг модели на obsidian Menu
// ---------------------------------------------------------------------------

/** MenuItem.setSubmenu есть в obsidian 1.12+ на десктопе; в типах 1.7 и в
 *  мобильном рантайме его нет — только безопасный каст с проверкой typeof. */
type MenuItemMaybeSubmenu = MenuItem & { setSubmenu?: () => Menu };

function configureLeaf(mi: MenuItem, ctx: TaskMenuCtx, item: MenuItemModel): void {
	mi.setSection(item.section).setTitle(item.title);
	if (item.icon !== undefined) mi.setIcon(item.icon);
	if (item.checked !== undefined) mi.setChecked(item.checked);
	mi.onClick(() =>
		reportAsync("не удалось выполнить действие с задачей", () =>
			runMenuAction(ctx, item.action),
		),
	);
}

function addLeaf(menu: Menu, ctx: TaskMenuCtx, item: MenuItemModel): void {
	menu.addItem((mi) => configureLeaf(mi, ctx, item));
}

/**
 * Подменю-узел: при живом setSubmenu — настоящее вложенное меню, иначе
 * (мобайл / obsidian < 1.12) — рекурсивное сплющивание с префиксом
 * («Приоритет: высокий» — как в плоском меню до подменю).
 *
 * Возможность узнаётся только изнутри addItem (нужен экземпляр MenuItem),
 * колбэк которого obsidian зовёт синхронно: уже созданный пункт при
 * отсутствии setSubmenu становится ПЕРВЫМ сплющенным ребёнком, остальные
 * добавляются следом — пробных/пустых пунктов в меню не остаётся.
 */
function addSubmenuNode(menu: Menu, ctx: TaskMenuCtx, node: MenuSubmenuModel): void {
	if (node.children.length === 0) return; // пустая группа — нечего показывать
	let flatRest: MenuItemModel[] = [];
	menu.addItem((mi) => {
		const cast = mi as MenuItemMaybeSubmenu;
		if (typeof cast.setSubmenu === "function") {
			mi.setSection(node.section).setTitle(node.label);
			if (node.icon !== undefined) mi.setIcon(node.icon);
			const sub = cast.setSubmenu();
			for (const child of node.children) addLeaf(sub, ctx, child);
		} else {
			const flat = flattenSubmenu(node);
			configureLeaf(mi, ctx, flat[0]!);
			flatRest = flat.slice(1);
		}
	});
	for (const child of flatRest) addLeaf(menu, ctx, child);
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

/**
 * «Архивировать» (пункт меню доски для готовых/отменённых): двухфазно —
 * (1) снять ВСЕ теги '#kanban/' задачи одним move-column ⇒ карточка мгновенно
 * уходит со всех досок; (2) убедиться в файле архива с флагом gtd-archive: true
 * (контейнер архива — полная инертность) и перенести строку туда.
 * Частичный сбой безопасен: при отказе фазы 2 тег-less строка остаётся в
 * исходном файле (её всегда можно заархивировать повторно), поэтому потери нет.
 */
async function archiveTask(ctx: TaskMenuCtx): Promise<void> {
	const kanbanTags = ctx.task.tags
		.map((t) => (t.startsWith("#") ? t : "#" + t))
		.filter((t) => t.startsWith("#kanban/"));

	// Фаза 1 — снять теги колонок всех досок.
	const stripRes = await ctx.dispatcher.dispatch({
		type: "move-column",
		key: ctx.task.key,
		fromTag: null,
		toTag: null,
		fromTags: kanbanTags,
	});
	if (!stripRes.ok) {
		new Notice(`GTD Flow: ${stripRes.reason}`);
		return;
	}

	// Фаза 2 — файл архива (создать + пометить gtd-archive СТРОГО до move-line) + перенос строки.
	const archive = ctx.ports?.archive;
	if (archive == null) {
		new Notice("GTD Flow: архивирование недоступно");
		return;
	}
	// архив ПРОСТРАНСТВА задачи: именованное — <root>/Архив.md, «Общее» — настройка
	const archiveFile = nsTargetPath(
		resolveNamespace(ctx.task.filePath, ctx.task.nsOverride ?? null, ctx.settings.namespaces),
		ctx.settings.namespaces,
		NS_CONVENTION.archive,
		ctx.settings.archiveFile,
	);
	if (!(await ensureArchiveFile(archive, archiveFile))) {
		new Notice("GTD Flow: не удалось создать файл архива");
		return;
	}
	const moveRes = await ctx.dispatcher.dispatch({
		type: "move-line",
		key: ctx.task.key,
		toFile: archiveFile,
	});
	if (!moveRes.ok) new Notice(`GTD Flow: ${moveRes.reason}`);
	else new Notice("GTD Flow: заархивировано");
}

/**
 * Пространство ЗАДАЧИ как фильтр discovery: пикеры «В колонку…»/«В проект…» показывают
 * доски/проекты пространства самой задачи, а не активного вида. По UX это правильнее —
 * перенос идёт внутри пространства задачи (решение фидбека итерации 2).
 */
function taskNamespaceFilter(ctx: TaskMenuCtx): NamespaceFilter {
	return {
		active: resolveNamespace(
			ctx.task.filePath,
			ctx.task.nsOverride ?? null,
			ctx.settings.namespaces,
		),
		defs: ctx.settings.namespaces,
	};
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

		case "pick-scheduled": {
			// как pick-due, но пишет ⏳ scheduled; time: null (поле пусто) снимает
			// существующее время, строка — ставит. Взаимоисключение с 🛫 — только у
			// 📅 due (см. Intent.clearStart), поэтому здесь его нет.
			const choice = await pickDate(
				ctx.app,
				"Запланировать (⏳) на",
				ctx.task.scheduled ?? undefined,
				true,
				ctx.task.scheduledTime,
			);
			if (choice === null) return;
			return void (await dispatchNoticing(ctx.dispatcher, {
				type: "set-date",
				key: ctx.task.key,
				field: "scheduled",
				date: choice.date,
				time: choice.time,
			}));
		}

		case "pick-defer": {
			const date = await pickDate(ctx.app, "Отложить до", ctx.task.start ?? undefined);
			if (date === null) return;
			return dispatchDefer(ctx, date);
		}

		case "pick-location": {
			// «Добавить/Изменить место…» — prompt с текущим 📍. TextPromptModal
			// триммит; пустой сабмит (пусто/пробелы) → null: места не было —
			// setValueField отдаёт ту же строку, applyToLine это видит как no-op без
			// записи; было — поле снимается (та же семантика, что у событий).
			new TextPromptModal(
				ctx.app,
				"Место задачи",
				(value) =>
					reportAsync("не удалось изменить место задачи", () =>
						dispatchNoticing(ctx.dispatcher, {
							type: "set-location",
							key: ctx.task.key,
							location: value === "" ? null : value,
						}),
					),
				ctx.task.location ?? "",
				"Адрес или место (пусто — убрать)",
			).open();
			return;
		}

		case "pick-column": {
			const boards = ports?.boards;
			if (boards == null) return; // недостижимо: пункт скрыт моделью
			const found = boards.discoverBoards(taskNamespaceFilter(ctx)).boards;
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
			const found = projects.discoverProjects(taskNamespaceFilter(ctx));
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
				recurringFiles: tpl.recurringFiles(ctx.task),
				spawnTarget: tpl.spawnTarget(ctx.task),
				vault: tpl.vault,
				dispatcher: ctx.dispatcher,
			});
			if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
			else new Notice("GTD Flow: перенесено в шаблоны — заполните правило 🔁");
			return;
		}

		case "archive":
			return archiveTask(ctx);

		case "delete": {
			// «Удалить» (задача создана по ошибке): подтверждение → delete-line.
			// withChildren: строка уходит вместе со своим вложенным блоком.
			const ok = await confirm(
				ctx.app,
				"Удалить задачу?",
				`Задача «${ctx.task.description}» будет удалена из файла безвозвратно ` +
					`(вместе с её вложенными строками, если есть).`,
				"Удалить",
			);
			if (!ok) return;
			const res = await dispatchNoticing(ctx.dispatcher, {
				type: "delete-line",
				key: ctx.task.key,
				withChildren: true,
			});
			if (res.ok) new Notice("GTD Flow: задача удалена");
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
