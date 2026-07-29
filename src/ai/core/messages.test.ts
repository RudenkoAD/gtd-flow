import { describe, expect, it } from "vitest";
import { AgentMessageSchema } from "./messages";

const timestamp = "2026-07-28T12:00:00.000Z";

describe("AgentMessageSchema tool boundaries", () => {
	it("accepts a correlated tool result", () => {
		expect(
			AgentMessageSchema.safeParse({
				id: "message-1",
				role: "tool",
				content: '{"ok":true}',
				createdAt: timestamp,
				toolCallId: "call-1",
			}).success,
		).toBe(true);
	});

	it("rejects an uncorrelated tool result", () => {
		const result = AgentMessageSchema.safeParse({
			id: "message-1",
			role: "tool",
			content: '{"ok":true}',
			createdAt: timestamp,
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error("fixture failed");
		expect(result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: ["toolCallId"],
					message: "Tool messages must identify their tool call",
				}),
			]),
		);
	});

	it("rejects duplicate tool-call IDs in one assistant response", () => {
		const result = AgentMessageSchema.safeParse({
			id: "message-1",
			role: "assistant",
			content: "",
			createdAt: timestamp,
			toolCalls: [
				{ id: "call-1", name: "get_task", arguments: { taskId: "task-1" } },
				{ id: "call-1", name: "get_task", arguments: { taskId: "task-2" } },
			],
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error("fixture failed");
		expect(result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: ["toolCalls", 1, "id"],
					message: "Tool call IDs must be unique within one response",
				}),
			]),
		);
	});

	it("bounds the combined serialized tool-call arguments", () => {
		const ordinary = AgentMessageSchema.safeParse({
			id: "message-1",
			role: "assistant",
			content: "",
			createdAt: timestamp,
			toolCalls: [{ id: "call-1", name: "get_task", arguments: { taskId: "task-1" } }],
		});
		expect(ordinary.success).toBe(true);

		const oversized = AgentMessageSchema.safeParse({
			id: "message-2",
			role: "assistant",
			content: "",
			createdAt: timestamp,
			toolCalls: [
				{ id: "call-2", name: "search_vault", arguments: { query: "x".repeat(60_001) } },
			],
		});
		expect(oversized.success).toBe(false);
		if (oversized.success) throw new Error("fixture failed");
		expect(oversized.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: ["toolCalls"],
					message: "Tool call arguments must be bounded JSON",
				}),
			]),
		);
	});
});
