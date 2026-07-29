/** Типы видов и их метаданные — единый реестр для регистрации и команд. */

export const VIEW_TYPES = {
	inbox: "gtd-flow-inbox",
	kanban: "gtd-flow-kanban",
	calendar: "gtd-flow-calendar",
	tickler: "gtd-flow-tickler",
	ai: "gtd-flow-ai",
	recurring: "gtd-flow-recurring",
	projects: "gtd-flow-projects",
	project: "gtd-flow-project",
} as const;

export type GtdViewKind = keyof typeof VIEW_TYPES;

export interface ViewMeta {
	kind: GtdViewKind;
	type: string;
	displayText: string;
	icon: string; // lucide
}

export const VIEW_META: Record<GtdViewKind, ViewMeta> = {
	inbox: { kind: "inbox", type: VIEW_TYPES.inbox, displayText: "GTD: Входящие", icon: "inbox" },
	kanban: {
		kind: "kanban",
		type: VIEW_TYPES.kanban,
		displayText: "GTD: Доска",
		icon: "kanban-square",
	},
	calendar: {
		kind: "calendar",
		type: VIEW_TYPES.calendar,
		displayText: "GTD: Календарь",
		icon: "calendar-days",
	},
	tickler: {
		kind: "tickler",
		type: VIEW_TYPES.tickler,
		displayText: "GTD: Отложенные",
		icon: "alarm-clock",
	},
	ai: { kind: "ai", type: VIEW_TYPES.ai, displayText: "GTD: AI", icon: "sparkles" },
	recurring: {
		kind: "recurring",
		type: VIEW_TYPES.recurring,
		displayText: "GTD: Регулярные",
		icon: "repeat",
	},
	projects: {
		kind: "projects",
		type: VIEW_TYPES.projects,
		displayText: "GTD: Проекты",
		icon: "folder-kanban",
	},
	project: {
		kind: "project",
		type: VIEW_TYPES.project,
		displayText: "GTD: Проект",
		icon: "git-fork",
	},
};
