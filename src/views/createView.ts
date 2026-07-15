import type { WorkspaceLeaf } from "obsidian";
import type GtdFlowPlugin from "../main";
import { GtdView } from "./GtdView";
import type { ViewMeta } from "./registry";
import { InboxView } from "./inbox/InboxView";
import { KanbanView } from "./kanban/KanbanView";
import { TicklerView } from "./tickler/TicklerView";

/** Фабрика для registerView: реализованные виды — свои классы, остальные — заглушка. */
export function createGtdView(leaf: WorkspaceLeaf, plugin: GtdFlowPlugin, meta: ViewMeta): GtdView {
	switch (meta.kind) {
		case "inbox":
			return new InboxView(leaf, plugin, meta);
		case "kanban":
			return new KanbanView(leaf, plugin, meta);
		case "tickler":
			return new TicklerView(leaf, plugin, meta);
		default:
			return new GtdView(leaf, plugin, meta);
	}
}
