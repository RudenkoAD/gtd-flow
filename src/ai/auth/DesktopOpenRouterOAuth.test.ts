import { describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "./MemoryCredentialStore";
import { OpenRouterCodeExchange, OpenRouterOAuthConnection } from "./DesktopOpenRouterOAuth";

describe("desktop OpenRouter OAuth adapters", () => {
	it("keeps the fallback credential only in memory", async () => {
		const store = new MemoryCredentialStore();
		expect(await store.get()).toBeNull();
		await store.set("local-secret");
		expect(await store.get()).toBe("local-secret");
		await store.clear();
		expect(await store.get()).toBeNull();
		expect(JSON.stringify(store)).not.toContain("local-secret");
	});

	it("exchanges PKCE code without sending a redirect or credential", async () => {
		let body: unknown;
		const exchange = new OpenRouterCodeExchange(async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ key: "device-key" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		await expect(
			exchange.exchangeAuthorizationCode({
				code: "auth-code",
				codeVerifier: "verifier",
				redirectUri: "http://127.0.0.1:1234/callback",
			}),
		).resolves.toEqual({ apiKey: "device-key" });
		expect(body).toEqual({
			code: "auth-code",
			code_verifier: "verifier",
			code_challenge_method: "S256",
		});
	});

	it("connects and disconnects through injected desktop ports", async () => {
		const store = new MemoryCredentialStore();
		let opened = "";
		const connection = new OpenRouterOAuthConnection(store, {
			browser: { openExternal: (url) => void (opened = url) },
			callback: {
				open: async () => ({
					redirectUri: "http://127.0.0.1:1234/callback",
					waitForCallback: async () => {
						const callbackUrl = new URL(opened).searchParams.get("callback_url")!;
						return {
							code: "code",
							state: new URL(callbackUrl).searchParams.get("state")!,
						};
					},
					close: async () => undefined,
				}),
			},
			exchange: {
				exchangeAuthorizationCode: async () => ({ apiKey: "device-key" }),
			},
		});
		await connection.connect();
		expect(await connection.isConnected()).toBe(true);
		await expect(connection.disconnectWithResult()).resolves.toEqual({
			localCredentialCleared: true,
			remoteRevocation: "unsupported",
			reason: "openrouter-oauth-key-self-revocation-not-supported",
		});
		expect(await connection.isConnected()).toBe(false);
	});
});
