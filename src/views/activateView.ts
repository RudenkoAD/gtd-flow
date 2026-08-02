import type { WorkspaceLeaf } from "obsidian";
import type { GtdViewKind } from "./registry";
import { VIEW_TYPES } from "./registry";

export interface ViewWorkspacePort {
	getLeavesOfType(type: string): WorkspaceLeaf[];
	getLeaf(newLeaf?: boolean | "tab" | "split" | "window"): WorkspaceLeaf;
	revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
}

/** Activate an existing GTD leaf or create one, applying URI state first. */
export async function activateGtdView(
	workspace: ViewWorkspacePort,
	kind: GtdViewKind,
	pane: "tab" | "split" = "tab",
	state?: Record<string, unknown>,
): Promise<WorkspaceLeaf | null> {
	const type = VIEW_TYPES[kind];
	const existing = workspace.getLeavesOfType(type)[0];
	if (existing !== undefined) {
		if (state !== undefined) await existing.setViewState({ type, active: true, state });
		await workspace.revealLeaf(existing);
		return existing;
	}

	const leaf = workspace.getLeaf(pane);
	await leaf.setViewState({ type, active: true, ...(state === undefined ? {} : { state }) });
	await workspace.revealLeaf(leaf);
	return leaf;
}
