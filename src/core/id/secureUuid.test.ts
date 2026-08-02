import { describe, expect, it, vi } from "vitest";
import { secureUuid } from "./secureUuid";

describe("secureUuid", () => {
	it("prefers randomUUID when available", () => {
		const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000000");
		expect(secureUuid({ randomUUID, getRandomValues: vi.fn() })).toBe(
			"00000000-0000-4000-8000-000000000000",
		);
		expect(randomUUID).toHaveBeenCalledOnce();
	});

	it("uses getRandomValues when Android WebView lacks randomUUID", () => {
		const value = secureUuid({
			getRandomValues(bytes) {
				for (let index = 0; index < bytes.length; index++) bytes[index] = index;
				return bytes;
			},
		});
		expect(value).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
	});

	it("fails closed without a cryptographic source", () => {
		expect(() => secureUuid({})).toThrow("secure-id-generator-unavailable");
	});
});
