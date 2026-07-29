import { describe, expect, it } from "vitest";
import { asAIError, retryAfterMs } from "./errors";

describe("AI error safety", () => {
	it("rejects unrepresentable Retry-After delays", () => {
		expect(retryAfterMs("9007199254741", 0)).toBeNull();
	});

	it("classifies ordinary AbortError instances without exposing their message", () => {
		const raw = new Error("prompt and credential text");
		raw.name = "AbortError";

		const classified = asAIError(raw);
		expect(classified).toMatchObject({
			code: "cancelled",
			retryable: false,
			retryAfterMs: null,
			statusCode: null,
		});
		expect(classified.message).toBe("cancelled");
		expect(classified.message).not.toContain("credential");
	});
});
