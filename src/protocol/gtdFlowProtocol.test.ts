import { describe, expect, it } from "vitest";
import { GTD_FLOW_PROTOCOL_ACTION, parseGtdFlowProtocolTarget } from "./gtdFlowProtocol";

describe("GTD Flow widget protocol", () => {
	it("accepts the Inbox view contract for an explicit vault", () => {
		expect(
			parseGtdFlowProtocolTarget({
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "My Vault",
				view: "inbox",
			}),
		).toEqual({ view: "inbox" });
	});

	it("accepts only a real ISO date in day mode for calendar navigation", () => {
		expect(
			parseGtdFlowProtocolTarget({
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "Дела",
				view: "calendar",
				mode: "day",
				date: "2026-08-17",
			}),
		).toEqual({ view: "calendar", mode: "day", date: "2026-08-17" });

		for (const date of ["2026-02-29", "2026-13-01", "2026-8-17", "not-a-date"]) {
			expect(
				parseGtdFlowProtocolTarget({
					action: GTD_FLOW_PROTOCOL_ACTION,
					vault: "Дела",
					view: "calendar",
					mode: "day",
					date,
				}),
			).toBeNull();
		}
	});

	it("rejects missing vaults, unsupported views/modes, and ambiguous Inbox params", () => {
		const invalid = [
			{ action: GTD_FLOW_PROTOCOL_ACTION, view: "inbox" },
			{ action: GTD_FLOW_PROTOCOL_ACTION, vault: "", view: "inbox" },
			{ action: "other", vault: "V", view: "inbox" },
			{ action: GTD_FLOW_PROTOCOL_ACTION, vault: "V", view: "kanban" },
			{
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "V",
				view: "calendar",
				mode: "week",
				date: "2026-08-17",
			},
			{
				action: GTD_FLOW_PROTOCOL_ACTION,
				vault: "V",
				view: "inbox",
				mode: "day",
				date: "2026-08-17",
			},
		];

		for (const params of invalid) expect(parseGtdFlowProtocolTarget(params)).toBeNull();
	});

	it("fails closed when the handler is running in a different vault", () => {
		expect(
			parseGtdFlowProtocolTarget(
				{
					action: GTD_FLOW_PROTOCOL_ACTION,
					vault: "Work Vault",
					view: "inbox",
				},
				"Life Vault",
			),
		).toBeNull();
	});
});
