import { describe, expect, it } from "vitest";
import { GTD_FLOW_PROTOCOL_ACTION } from "./gtdFlowProtocol";
import { gtdFlowProtocolNavigation } from "./gtdFlowNavigation";

describe("GTD Flow widget protocol navigation", () => {
	it("maps Inbox without adding view state", () => {
		expect(
			gtdFlowProtocolNavigation({
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "My Vault",
				view: "inbox",
			}),
		).toEqual({ kind: "inbox" });
	});

	it("maps a calendar date to the persisted day-view state", () => {
		expect(
			gtdFlowProtocolNavigation({
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "Дела и жизнь",
				view: "calendar",
				mode: "day",
				date: "2026-08-17",
			}),
		).toEqual({
			kind: "calendar",
			state: { mode: "day", anchor: "2026-08-17" },
		});
	});

	it("does not produce a navigation request for an invalid link", () => {
		expect(
			gtdFlowProtocolNavigation({
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "Vault",
				view: "calendar",
				mode: "day",
				date: "2026-02-29",
			}),
		).toBeNull();
	});

	it("does not navigate when Obsidian routed the link to another vault", () => {
		expect(
			gtdFlowProtocolNavigation(
				{
					action: GTD_FLOW_PROTOCOL_ACTION,
					vault: "My Vault",
					view: "inbox",
				},
				"Other Vault",
			),
		).toBeNull();
	});
});
