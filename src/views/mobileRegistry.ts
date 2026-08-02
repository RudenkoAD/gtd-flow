import type { WorkspaceLeaf } from "obsidian";
import type GtdFlowPlugin from "../main";
import type { GtdView } from "./GtdView";
import { CalendarView } from "./calendar/CalendarView";
import { InboxView } from "./inbox/InboxView";
import { RecurringView } from "./recurring/RecurringView";
import { VIEW_META, type GtdViewKind, type ViewMeta } from "./registry";

/**
 * Views whose runtime dependency graph is supported by the Android build.
 * Keep this registry separate from createView.ts: importing the desktop
 * factory would eagerly evaluate AI, graph and desktop-only view modules even
 * when Obsidian never opens those leaves.
 */
export const MOBILE_VIEW_KINDS = ["inbox", "calendar", "recurring"] as const;

export type MobileViewKind = (typeof MOBILE_VIEW_KINDS)[number];

export const MOBILE_VIEW_META: Readonly<Record<MobileViewKind, ViewMeta>> = {
	inbox: VIEW_META.inbox,
	calendar: VIEW_META.calendar,
	recurring: VIEW_META.recurring,
};

export function isMobileViewKind(kind: GtdViewKind): kind is MobileViewKind {
	return (MOBILE_VIEW_KINDS as readonly GtdViewKind[]).includes(kind);
}

/** Fail closed if lifecycle code accidentally asks Android to create a desktop view. */
export function createMobileGtdView(
	leaf: WorkspaceLeaf,
	plugin: GtdFlowPlugin,
	meta: ViewMeta,
): GtdView {
	switch (meta.kind) {
		case "inbox":
			return new InboxView(leaf, plugin, meta);
		case "calendar":
			return new CalendarView(leaf, plugin, meta);
		case "recurring":
			return new RecurringView(leaf, plugin, meta);
		default:
			throw new Error(`GTD Flow view '${meta.kind}' is not available on mobile`);
	}
}
