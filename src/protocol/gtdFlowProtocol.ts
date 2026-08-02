import type { IsoDate } from "../core/model/Task";
import { isValidIsoDate } from "../core/recurrence/dateMath";

/** Custom Obsidian URI action shared with the Android widgets. */
export const GTD_FLOW_PROTOCOL_ACTION = "gtd-flow";

export type GtdFlowProtocolTarget =
	{ view: "inbox" } | { view: "calendar"; mode: "day"; date: IsoDate };

/**
 * Parse the narrow widget-navigation contract. Invalid or incomplete links
 * fail closed instead of opening a surprising view or date.
 */
export function parseGtdFlowProtocolTarget(
	params: Readonly<Record<string, unknown>>,
	expectedVault?: string,
): GtdFlowProtocolTarget | null {
	if (params["action"] !== GTD_FLOW_PROTOCOL_ACTION) return null;
	const vault = params["vault"];
	if (typeof vault !== "string" || vault.trim() === "") return null;
	if (expectedVault !== undefined && vault !== expectedVault) return null;

	if (params["view"] === "inbox") {
		return params["mode"] === undefined && params["date"] === undefined
			? { view: "inbox" }
			: null;
	}

	if (params["view"] !== "calendar" || params["mode"] !== "day") return null;
	const date = params["date"];
	return typeof date === "string" && isValidIsoDate(date)
		? { view: "calendar", mode: "day", date }
		: null;
}
