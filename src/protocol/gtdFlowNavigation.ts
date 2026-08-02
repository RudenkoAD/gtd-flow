import type { GtdViewKind } from "../views/registry";
import { parseGtdFlowProtocolTarget } from "./gtdFlowProtocol";

export interface GtdFlowProtocolNavigation {
	kind: Extract<GtdViewKind, "inbox" | "calendar">;
	state?: { mode: "day"; anchor: string };
}

/**
 * Translate an external widget URI into the exact view activation request.
 * Keeping this mapping outside the plugin lifecycle makes the Android contract
 * independently testable and prevents partially valid links changing layout.
 */
export function gtdFlowProtocolNavigation(
	params: Readonly<Record<string, unknown>>,
	expectedVault?: string,
): GtdFlowProtocolNavigation | null {
	const target = parseGtdFlowProtocolTarget(params, expectedVault);
	if (target === null) return null;
	if (target.view === "inbox") return { kind: "inbox" };
	return {
		kind: "calendar",
		state: { mode: "day", anchor: target.date },
	};
}
