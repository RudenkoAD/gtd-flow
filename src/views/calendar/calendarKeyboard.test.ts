import { describe, expect, it } from "vitest";
import {
	isResizeKeyboardAction,
	occurrenceKeyboardAction,
	surfaceKeyboardAction,
} from "./calendarKeyboard";

describe("calendar keyboard contract", () => {
	it("maps Enter/Space and both standard context-menu shortcuts", () => {
		expect(surfaceKeyboardAction("Enter")).toBe("quick-add");
		expect(surfaceKeyboardAction(" ")).toBe("quick-add");
		expect(surfaceKeyboardAction("ContextMenu")).toBe("menu");
		expect(surfaceKeyboardAction("F10", true)).toBe("menu");
		expect(surfaceKeyboardAction("F10")).toBeNull();
	});

	it("maps arrows to timed-occurrence movement and reserves Shift+vertical arrows for resize", () => {
		expect(occurrenceKeyboardAction("ArrowLeft")).toBe("move-left");
		expect(occurrenceKeyboardAction("ArrowDown")).toBe("move-down");
		expect(occurrenceKeyboardAction("Enter")).toBeNull();
		expect(isResizeKeyboardAction("ArrowUp", true)).toBe(true);
		expect(isResizeKeyboardAction("ArrowLeft", true)).toBe(false);
	});
});
