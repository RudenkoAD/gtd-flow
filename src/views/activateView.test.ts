import { describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { activateGtdView, type ViewWorkspacePort } from "./activateView";
import { VIEW_TYPES } from "./registry";

function leaf() {
	return {
		setViewState: vi.fn(async () => undefined),
	} as unknown as WorkspaceLeaf;
}

describe("activateGtdView", () => {
	it("applies day state to an existing calendar leaf before revealing it", async () => {
		const existing = leaf();
		const revealLeaf = vi.fn(async () => undefined);
		const workspace = {
			getLeavesOfType: vi.fn(() => [existing]),
			getLeaf: vi.fn(() => leaf()),
			revealLeaf,
		} as unknown as ViewWorkspacePort;

		await expect(
			activateGtdView(workspace, "calendar", "tab", {
				mode: "day",
				anchor: "2026-08-17",
			}),
		).resolves.toBe(existing);
		expect(existing.setViewState).toHaveBeenCalledWith({
			type: VIEW_TYPES.calendar,
			active: true,
			state: { mode: "day", anchor: "2026-08-17" },
		});
		expect(workspace.getLeaf).not.toHaveBeenCalled();
		expect(revealLeaf).toHaveBeenCalledWith(existing);
	});

	it("creates a calendar tab with the same day state when no leaf exists", async () => {
		const created = leaf();
		const revealLeaf = vi.fn(async () => undefined);
		const workspace = {
			getLeavesOfType: vi.fn(() => []),
			getLeaf: vi.fn(() => created),
			revealLeaf,
		} as unknown as ViewWorkspacePort;

		await expect(
			activateGtdView(workspace, "calendar", "tab", {
				mode: "day",
				anchor: "2026-08-17",
			}),
		).resolves.toBe(created);
		expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
		expect(created.setViewState).toHaveBeenCalledWith({
			type: VIEW_TYPES.calendar,
			active: true,
			state: { mode: "day", anchor: "2026-08-17" },
		});
		expect(revealLeaf).toHaveBeenCalledWith(created);
	});
});
