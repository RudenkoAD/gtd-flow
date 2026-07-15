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
import type { IsoDate, Task } from "../../core/model/Task";
import type { DeferPreset } from "../../settings/Settings";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "./cardFormat";
import { addDaysIso } from "./dates";

export type MenuSection = "status" | "priority" | "schedule" | "defer" | "move" | "card" | "nav";

export type MenuAction =
	| { kind: "intent"; intent: Intent }
	| { kind: "pick-due" } // «Запланировать…»: пикер даты → set-date due
	| { kind: "pick-defer" } // «Отложить: дата…»: пикер даты → defer
	| { kind: "pick-column" } // «Переместить в колонку…»: доски × колонки → moveCard в конец
	| { kind: "pick-project" } // «В проект…»: пикер проектов → move-line
	| { kind: "make-template" } // «Сделать шаблоном…»: move-line в gtd-recurring файл
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

/** Плоский вход модели: наличие портов — булевы флаги, а не сами порты. */
export interface MenuModelInput {
	task: Task;
	today: IsoDate;
	deferPresets: readonly DeferPreset[];
	/** Пункт «Вернуть во входящие» (снять 🛫) — только из вида отложенных. */
	inTickler: boolean;
	hasBoards: boolean;
	hasProjects: boolean;
	hasCards: boolean;
	hasTemplates: boolean;
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

export function buildMenuModel(input: MenuModelInput): MenuItemModel[] {
	const { task, today } = input;
	const items: MenuItemModel[] = [];
	const isDone = task.statusChar === "x" || task.statusChar === "X";
	const isDoing = task.statusChar === "/";
	const isCancelled = task.statusChar === "-";

	// --- статус: выполнено/заново, в работе '/', отменить '-' ---
	items.push(
		isDone
			? intentItem("status-reopen", "status", "Открыть заново", "rotate-ccw", {
					type: "set-status",
					key: task.key,
					statusChar: " ",
				})
			: intentItem("status-done", "status", "Выполнено", "check", {
					type: "set-status",
					key: task.key,
					statusChar: "x",
					date: today,
				}),
	);
	items.push(
		isDoing
			? intentItem("status-pause", "status", "Вернуть в очередь", "undo-2", {
					type: "set-status",
					key: task.key,
					statusChar: " ",
				})
			: intentItem("status-doing", "status", "В работу", "play", {
					type: "set-status",
					key: task.key,
					statusChar: "/",
				}),
	);
	items.push(
		isCancelled
			? intentItem("status-uncancel", "status", "Вернуть из отменённых", "rotate-ccw", {
					type: "set-status",
					key: task.key,
					statusChar: " ",
				})
			: intentItem("status-cancel", "status", "Отменить", "x", {
					type: "set-status",
					key: task.key,
					statusChar: "-",
					date: today,
				}),
	);

	// --- приоритет: 5 уровней + сброс, checked на текущем ---
	for (const p of PRIORITY_ORDER) {
		items.push({
			id: `priority-${p}`,
			section: "priority",
			title: `Приоритет: ${PRIORITY_LABELS[p]}`,
			checked: task.priority === p,
			action: {
				kind: "intent",
				intent: { type: "set-priority", key: task.key, priority: p },
			},
		});
	}

	// --- запланировать (📅 due) ---
	items.push({
		id: "schedule-due",
		section: "schedule",
		title: "Запланировать…",
		icon: "calendar-check",
		action: { kind: "pick-due" },
	});

	// --- отложить (🛫): пресеты + произвольная дата ---
	for (let i = 0; i < input.deferPresets.length; i++) {
		const preset = input.deferPresets[i]!;
		items.push(
			intentItem(`defer-preset-${i}`, "defer", `Отложить: ${preset.label}`, "alarm-clock", {
				type: "defer",
				key: task.key,
				until: addDaysIso(today, preset.offsetDays),
			}),
		);
	}
	items.push({
		id: "defer-date",
		section: "defer",
		title: "Отложить: дата…",
		icon: "calendar",
		action: { kind: "pick-defer" },
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
