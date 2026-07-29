import { describe, expect, it } from "vitest";
import type { AIProviderPort } from "../providers/AIProviderPort";
import { AgentRuntime } from "./AgentRuntime";

function throwingProvider(): AIProviderPort {
	return {
		complete: async () => {
			throw new Error("raw provider body with credential");
		},
		completeJson: async () => {
			throw new Error("raw structured provider body with prompt");
		},
		stream: async function* () {
			throw new Error("raw streaming provider body with task text");
		},
	};
}

describe("AgentRuntime error boundary", () => {
	it("redacts provider exceptions from complete", async () => {
		const runtime = new AgentRuntime(throwingProvider());
		await expect(runtime.complete({ messages: [] })).rejects.toMatchObject({
			name: "AIError",
			code: "network",
			message: "network",
			retryable: true,
		});
	});

	it("redacts provider exceptions from completeJson", async () => {
		const runtime = new AgentRuntime(throwingProvider());
		await expect(
			runtime.completeJson({
				messages: [],
				responseSchema: {
					name: "estimate",
					schema: { type: "object" },
					parse: (value) => value,
				},
			}),
		).rejects.toMatchObject({
			name: "AIError",
			code: "network",
			message: "network",
			retryable: true,
		});
	});

	it("emits only the classified error from stream", async () => {
		const runtime = new AgentRuntime(throwingProvider());
		const events = [];
		for await (const event of runtime.stream({ messages: [] })) events.push(event);

		expect(events).toEqual([
			{
				type: "response-failed",
				error: expect.objectContaining({
					code: "network",
					message: "network",
					retryable: true,
				}),
			},
		]);
		expect(JSON.stringify(events)).not.toContain("task text");
	});
});
