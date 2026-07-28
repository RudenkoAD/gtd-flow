/** Shared keyboard contract for pointer-first calendar surfaces. */

export type CalendarKeyboardAction =
	"quick-add" | "menu" | "move-left" | "move-right" | "move-up" | "move-down" | null;

/** Enter/Space mirror primary click; Menu/Shift+F10 mirror context-menu. */
export function surfaceKeyboardAction(key: string, shiftKey = false): CalendarKeyboardAction {
	if (key === "Enter" || key === " ") return "quick-add";
	if (key === "ContextMenu" || (key === "F10" && shiftKey)) return "menu";
	return null;
}

/** Timed event occurrences use arrows as a drag-free movement affordance. */
export function occurrenceKeyboardAction(key: string): CalendarKeyboardAction {
	switch (key) {
		case "ArrowLeft":
			return "move-left";
		case "ArrowRight":
			return "move-right";
		case "ArrowUp":
			return "move-up";
		case "ArrowDown":
			return "move-down";
		default:
			return null;
	}
}

export function isResizeKeyboardAction(key: string, shiftKey: boolean): boolean {
	return shiftKey && (key === "ArrowUp" || key === "ArrowDown");
}
