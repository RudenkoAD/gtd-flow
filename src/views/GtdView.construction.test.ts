/**
 * Регрессия живой верификации в Obsidian 1.12: конструктор View вызывает
 * getViewType() до присвоения параметр-свойств подкласса — виды обязаны
 * отвечать через статические метаданные класса, а не через this.meta.
 * Стаб ItemView (src/testing/obsidianStub.ts) воспроизводит этот порядок.
 */
import { describe, expect, it } from "vitest";
import { InboxView } from "./inbox/InboxView";
import { KanbanView } from "./kanban/KanbanView";
import { TicklerView } from "./tickler/TicklerView";
import { RecurringView } from "./recurring/RecurringView";
import { ProjectsOverviewView } from "./projects/ProjectsOverviewView";
import { VIEW_META } from "./registry";
import type GtdFlowPlugin from "../main";

const leaf = {} as never;
const plugin = {
	settings: { inboxFile: "GTD/Inbox.md" },
} as unknown as GtdFlowPlugin;

describe("конструирование видов: getViewType до присвоения this.meta", () => {
	it("InboxView конструируется и отвечает правильным типом", () => {
		const v = new InboxView(leaf, plugin, VIEW_META.inbox);
		expect(v.getViewType()).toBe(VIEW_META.inbox.type);
	});

	it("KanbanView / TicklerView / RecurringView конструируются", () => {
		expect(new KanbanView(leaf, plugin, VIEW_META.kanban).getViewType()).toBe(
			VIEW_META.kanban.type,
		);
		expect(new TicklerView(leaf, plugin, VIEW_META.tickler).getViewType()).toBe(
			VIEW_META.tickler.type,
		);
		expect(new RecurringView(leaf, plugin, VIEW_META.recurring).getViewType()).toBe(
			VIEW_META.recurring.type,
		);
	});

	it("ProjectsOverviewView конструируется и отвечает правильным типом", () => {
		expect(new ProjectsOverviewView(leaf, plugin, VIEW_META.projects).getViewType()).toBe(
			VIEW_META.projects.type,
		);
	});
});
