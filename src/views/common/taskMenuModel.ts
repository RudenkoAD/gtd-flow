/**
 * Чистая модель контекстного меню карточки (ТЗ §8, слой 3 — паритет без drag).
 *
 * buildMenuModel — единственное место, где решается, КАКИЕ пункты видны и что
 * они означают; ноль импортов obsidian — тестируется в голом node. Маппинг
 * модели на obsidian Menu (и интерактив пикеров) живёт в taskMenu.ts.
 *
 * Пункты с готовым Intent несут его данными ({kind:"intent"}); интерактивные
 * (пикеры дат/досок/проектов, карточка) — только маркер kind: их исполнение
 * требует модалов и портов, которых у чистой модели нет по построению.
 */
import type { Intent } from "../../core/intents/Intent";
import type { EstimateField } from "../../core/estimates/provenance";
import type { IsoDate, Task } from "../../core/model/Task";
import type { DeferPreset } from "../../settings/Settings";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "./cardFormat";
import { addDaysIso } from "./dates";

export type MenuSection =
	| "status"
	| "priority"
	| "schedule"
	| "defer"
	| "location"
	| "metadata"
	| "ai"
	| "move"
	| "card"
	| "nav";

export type MenuAction =
	| { kind: "intent"; intent: Intent }
	| { kind: "pick-due" } // «Запланировать…»: пикер даты → set-date due
	| { kind: "pick-scheduled" } // «Запланировать (⏳)…»: пикер даты → set-date scheduled
	| { kind: "pick-defer" } // «Отложить: дата…»: пикер даты → defer
	| { kind: "pick-location" } // «Добавить/Изменить место…»: prompt текста → set-location
	| { kind: "edit-metadata"; focus?: EstimateField } // one atomic duration/intensity/scope modal
	| { kind: "clear-metadata"; field: EstimateField }
	| { kind: "open-ai-run" }
	| { kind: "pick-column" } // «Переместить в колонку…»: доски × колонки → moveCard в конец
	| { kind: "pick-project" } // «В проект…»: пикер проектов → move-line
	| { kind: "make-template" } // «Сделать шаблоном…»: move-line в gtd-recurring файл
	| { kind: "archive" } // «Архивировать»: снять теги досок → move-line в archiveFile
	| { kind: "delete" } // «Удалить»: ConfirmModal → delete-line (задача создана по ошибке)
	| { kind: "open-card" } // CardPort.openOrCreate
	| { kind: "open-file" }; // openTaskInFile

export interface MenuItemModel {
	/** Стабильный id пункта — для тестов и отладки, в UI не показывается. */
	id: string;
	section: MenuSection;
	title: string;
	icon?: string;
	checked?: boolean;
	action: MenuAction;
}

/**
 * Подменю (obsidian 1.12 desktop, MenuItem.setSubmenu): группа листовых
 * пунктов под одним заголовком. Среды без setSubmenu (мобайл, старые версии)
 * сплющивают его через flattenSubmenu — модель одна, маппинг решает.
 */
export interface MenuSubmenuModel {
	kind: "submenu";
	id: string;
	section: MenuSection;
	label: string;
	icon?: string;
	children: MenuItemModel[];
}

export type MenuNode = MenuItemModel | MenuSubmenuModel;

/** Дискриминация по наличию kind: у листовых пунктов поля kind нет вовсе. */
export function isSubmenuNode(node: MenuNode): node is MenuSubmenuModel {
	return "kind" in node;
}

/**
 * Плоская форма подменю для сред без setSubmenu: дети становятся обычными
 * пунктами с префиксом из label без завершающего многоточия —
 * «Приоритет…» + «высокий» → «Приоритет: высокий» (как в доподменюшном UI).
 */
export function flattenSubmenu(node: MenuSubmenuModel): MenuItemModel[] {
	const prefix = node.label.replace(/…$/u, "");
	return node.children.map((c) => ({ ...c, title: `${prefix}: ${c.title}` }));
}

/** Плоский вход модели: наличие портов — булевы флаги, а не сами порты. */
export interface MenuModelInput {
	task: Task;
	today: IsoDate;
	deferPresets: readonly DeferPreset[];
	/** Пункт «Вернуть во входящие» (снять 🛫) — только из вида отложенных. */
	inTickler: boolean;
	/** Пункт «Архивировать» — только из вида доски (для готовых/отменённых). */
	inBoard: boolean;
	hasBoards: boolean;
	hasProjects: boolean;
	hasCards: boolean;
	hasTemplates: boolean;
	/** Optional narrow metadata port. It owns scope/provenance persistence. */
	hasMetadata: boolean;
	hasRelatedAiRun: boolean;
}

function intentItem(
	id: string,
	section: MenuSection,
	title: string,
	icon: string,
	intent: Intent,
): MenuItemModel {
	return { id, section, title, icon, action: { kind: "intent", intent } };
}

export function buildMenuModel(input: MenuModelInput): MenuNode[] {
	const { task, today } = input;
	const items: MenuNode[] = [];
	const isDone = task.statusChar === "x" || task.statusChar === "X";
	const isCancelled = task.statusChar === "-";

	// --- статус: «Выполнено» (пока задача не выполнена) + «Удалить».
	// Новая модель доски — «статус = чекбокс»: перевод в работу '/' и возврат в
	// очередь задаются галочкой карточки, а «Открыть заново» дублировало её
	// снятие — поэтому эти пункты убраны. Пункт «Отменить» (перевод в '-') убран
	// НАСОВСЕМ: пользователи гасили им ошибочно созданные задачи, но строка при
	// этом оставалась в файле — на его место встал честный «Удалить» (delete-line).
	// «Вернуть из отменённых» для уже отменённых '-' ОСТАВЛЕН: это восстановление
	// статуса (парсер '-' не трогаем), а не отмена. ---
	if (!isDone) {
		items.push(
			intentItem("status-done", "status", "Выполнено", "check", {
				type: "set-status",
				key: task.key,
				statusChar: "x",
				date: today,
			}),
		);
	}
	if (isCancelled) {
		items.push(
			intentItem("status-uncancel", "status", "Вернуть из отменённых", "rotate-ccw", {
				type: "set-status",
				key: task.key,
				statusChar: " ",
			}),
		);
	}
	// «Удалить» — на месте прежней «Отменить»: доступна для ЛЮБОЙ задачи, убирает
	// строку из файла (с подтверждением ConfirmModal — исполняет taskMenu.ts).
	items.push({
		id: "delete",
		section: "status",
		title: "Удалить",
		icon: "trash",
		action: { kind: "delete" },
	});

	// --- приоритет: подменю «Приоритет…» (5 уровней + сброс), checked на текущем;
	// статусные пункты выше намеренно НЕ группируются — они на расстоянии одного клика ---
	items.push({
		kind: "submenu",
		id: "priority",
		section: "priority",
		label: "Приоритет…",
		icon: "flag",
		children: PRIORITY_ORDER.map((p) => ({
			id: `priority-${p}`,
			section: "priority",
			title: PRIORITY_LABELS[p],
			checked: task.priority === p,
			action: {
				kind: "intent",
				intent: { type: "set-priority", key: task.key, priority: p },
			},
		})),
	});

	// --- запланировать (📅 due) ---
	items.push({
		id: "schedule-due",
		section: "schedule",
		title: "Запланировать…",
		icon: "calendar-check",
		action: { kind: "pick-due" },
	});

	// --- запланировать по ⏳ scheduled (альтернатива due; интент set-date уже умеет
	// field:"scheduled", а calendarPlacement допускает scheduled основным полем) ---
	items.push({
		id: "schedule-scheduled",
		section: "schedule",
		title: "Запланировать (⏳)…",
		icon: "calendar-clock",
		action: { kind: "pick-scheduled" },
	});

	// --- отложить (🛫): подменю «Отложить…» — пресеты + произвольная дата ---
	const deferChildren: MenuItemModel[] = input.deferPresets.map((preset, i) =>
		intentItem(`defer-preset-${i}`, "defer", preset.label, "alarm-clock", {
			type: "defer",
			key: task.key,
			until: addDaysIso(today, preset.offsetDays),
		}),
	);
	deferChildren.push({
		id: "defer-date",
		section: "defer",
		title: "Дата…",
		icon: "calendar",
		action: { kind: "pick-defer" },
	});
	items.push({
		kind: "submenu",
		id: "defer",
		section: "defer",
		label: "Отложить…",
		icon: "alarm-clock",
		children: deferChildren,
	});
	if (input.inTickler) {
		items.push(
			intentItem("defer-return", "defer", "Вернуть во входящие", "inbox", {
				type: "set-date",
				key: task.key,
				field: "start",
				date: null,
			}),
		);
	}

	// --- место (📍): у ЛЮБОЙ задачи во всех видах; подпись динамическая по
	// наличию места. Исполнение — prompt текста (pick-location в taskMenu.ts). ---
	const hasLocation = task.location !== null && task.location.trim() !== "";
	items.push({
		id: "set-location",
		section: "location",
		title: hasLocation ? "Изменить место…" : "Добавить место…",
		icon: "map-pin",
		action: { kind: "pick-location" },
	});

	// --- duration/intensity/scope: all field edits route through ONE modal and
	// ONE PatchTaskMetadata write. Individual entry points only set initial focus. ---
	if (input.hasMetadata) {
		items.push(
			{
				id: "edit-duration",
				section: "metadata",
				title: task.durationMinutes === null ? "Set duration…" : "Edit duration…",
				icon: "timer",
				action: { kind: "edit-metadata", focus: "duration" },
			},
			{
				id: "edit-cognitive-intensity",
				section: "metadata",
				title: "Edit cognitive intensity…",
				icon: "brain",
				action: { kind: "edit-metadata", focus: "cognitive" },
			},
			{
				id: "edit-emotional-intensity",
				section: "metadata",
				title: "Edit emotional intensity…",
				icon: "heart",
				action: { kind: "edit-metadata", focus: "emotional" },
			},
			{
				id: "edit-physical-intensity",
				section: "metadata",
				title: "Edit physical intensity…",
				icon: "dumbbell",
				action: { kind: "edit-metadata", focus: "physical" },
			},
			{
				id: "change-scope",
				section: "metadata",
				title: task.scopeId === null ? "Set scope…" : "Change scope…",
				icon: "compass",
				action: { kind: "edit-metadata", focus: "scope" },
			},
		);
		for (const [field, value, title] of [
			["duration", task.durationMinutes, "Clear duration"],
			["cognitive", task.cognitiveIntensity, "Clear cognitive intensity"],
			["emotional", task.emotionalIntensity, "Clear emotional intensity"],
			["physical", task.physicalIntensity, "Clear physical intensity"],
			["scope", task.scopeId, "Clear scope"],
		] as const) {
			if (value !== null) {
				items.push({
					id: `clear-${field}`,
					section: "metadata",
					title,
					icon: "x",
					action: { kind: "clear-metadata", field },
				});
			}
		}
	}
	if (input.hasRelatedAiRun) {
		items.push({
			id: "open-ai-run",
			section: "ai",
			title: "Open related AI run",
			icon: "messages-square",
			action: { kind: "open-ai-run" },
		});
	}

	// --- перемещение: только при живых портах (нет сервиса — нет пункта) ---
	if (input.hasBoards) {
		items.push({
			id: "move-column",
			section: "move",
			title: "Переместить в колонку…",
			icon: "kanban-square",
			action: { kind: "pick-column" },
		});
	}
	if (input.hasProjects) {
		items.push({
			id: "move-project",
			section: "move",
			title: "В проект…",
			icon: "git-fork",
			action: { kind: "pick-project" },
		});
	}
	if (input.hasTemplates) {
		items.push({
			id: "move-template",
			section: "move",
			title: "Сделать шаблоном…",
			icon: "repeat",
			action: { kind: "make-template" },
		});
	}

	// --- архив: только на доске и только для выполненных/отменённых карточек
	// (снимает теги всех досок и переносит строку в файл архива) ---
	if (input.inBoard && (isDone || isCancelled)) {
		items.push({
			id: "archive",
			section: "move",
			title: "Архивировать",
			icon: "archive",
			action: { kind: "archive" },
		});
	}

	// --- карточка и навигация ---
	if (input.hasCards) {
		items.push({
			id: "card-open",
			section: "card",
			title: "Открыть карточку",
			icon: "panel-right",
			action: { kind: "open-card" },
		});
	}
	items.push({
		id: "open-file",
		section: "nav",
		title: "Открыть в файле",
		icon: "file-text",
		action: { kind: "open-file" },
	});

	return items;
}
