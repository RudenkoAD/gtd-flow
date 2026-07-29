import type { WorkspaceLeaf } from "obsidian";
import type GtdFlowPlugin from "../main";
import { GtdView } from "./GtdView";
import type { ViewMeta } from "./registry";
import { CalendarView } from "./calendar/CalendarView";
import { InboxView } from "./inbox/InboxView";
import { KanbanView } from "./kanban/KanbanView";
import { ProjectView } from "./project/ProjectView";
import { ProjectsOverviewView } from "./projects/ProjectsOverviewView";
import { RecurringView } from "./recurring/RecurringView";
import { TicklerView } from "./tickler/TicklerView";
import { AIView } from "./ai/AIView";

/** Фабрика для registerView: реализованные виды — свои классы, остальные — заглушка. */
export function createGtdView(leaf: WorkspaceLeaf, plugin: GtdFlowPlugin, meta: ViewMeta): GtdView {
	switch (meta.kind) {
		case "inbox":
			return new InboxView(leaf, plugin, meta);
		case "kanban":
			return new KanbanView(leaf, plugin, meta);
		case "calendar":
			return new CalendarView(leaf, plugin, meta);
		case "tickler":
			return new TicklerView(leaf, plugin, meta);
		case "ai":
			return new AIView(leaf, plugin, meta);
		case "recurring":
			return new RecurringView(leaf, plugin, meta);
		case "projects":
			return new ProjectsOverviewView(leaf, plugin, meta);
		case "project":
			return new ProjectView(leaf, plugin, meta);
		default:
			return new GtdView(leaf, plugin, meta);
	}
}
