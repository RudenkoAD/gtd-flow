import { describe, expect, it } from "vitest";
import type GtdFlowPlugin from "../main";
import { CalendarView } from "./calendar/CalendarView";
import { InboxView } from "./inbox/InboxView";
import {
	createMobileGtdView,
	isMobileViewKind,
	MOBILE_VIEW_KINDS,
	MOBILE_VIEW_META,
} from "./mobileRegistry";
import { RecurringView } from "./recurring/RecurringView";
import { VIEW_META } from "./registry";

const leaf = {} as never;
const plugin = {} as GtdFlowPlugin;

describe("mobile view registry", () => {
	it("contains only the Android-supported view metadata", () => {
		expect(MOBILE_VIEW_KINDS).toEqual(["inbox", "calendar", "recurring"]);
		expect(Object.values(MOBILE_VIEW_META).map((meta) => meta.type)).toEqual([
			VIEW_META.inbox.type,
			VIEW_META.calendar.type,
			VIEW_META.recurring.type,
		]);
		expect(isMobileViewKind("calendar")).toBe(true);
		expect(isMobileViewKind("ai")).toBe(false);
	});

	it("constructs supported views without the all-view desktop factory", () => {
		expect(createMobileGtdView(leaf, plugin, VIEW_META.inbox)).toBeInstanceOf(InboxView);
		expect(createMobileGtdView(leaf, plugin, VIEW_META.calendar)).toBeInstanceOf(CalendarView);
		expect(createMobileGtdView(leaf, plugin, VIEW_META.recurring)).toBeInstanceOf(
			RecurringView,
		);
	});

	it("fails closed for a desktop-only kind", () => {
		expect(() => createMobileGtdView(leaf, plugin, VIEW_META.ai)).toThrow(
			"GTD Flow view 'ai' is not available on mobile",
		);
	});
});
