import { describe, expect, it } from "vitest";
import {
	OAuthStateMismatchError,
	OpenRouterOAuth,
	buildAuthorizationUrl,
	generatePkce,
} from "./OpenRouterOAuth";
import type { CredentialStorePort } from "./CredentialStorePort";

function bytes(value: number): Uint8Array {
	return new Uint8Array(64).fill(value);
}

describe("OpenRouterOAuth", () => {
	it("generates URL-safe PKCE S256 values and authorization parameters", async () => {
		let calls = 0;
		const pkce = await generatePkce({
			randomBytes: () => bytes(++calls),
			sha256: async () => bytes(3),
		});
		expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/u);
		const url = new URL(
			buildAuthorizationUrl({
				authorizationEndpoint: "https://openrouter.example/auth",
				callbackUrl: "http://127.0.0.1:4545/callback",
				state: pkce.state,
				codeChallenge: pkce.codeChallenge,
			}),
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(new URL(url.searchParams.get("callback_url")!).searchParams.get("state")).toBe(
			pkce.state,
		);
	});

	it("validates callback state, stores only the exchanged key, and closes loopback server", async () => {
		const stored: string[] = [];
		let openedUrl = "";
		let closed = false;
		let exchangedVerifier = "";
		const store: CredentialStorePort = {
			get: async () => null,
			set: async (secret) => {
				stored.push(secret);
			},
			clear: async () => undefined,
		};
		const oauth = new OpenRouterOAuth({
			authorizationEndpoint: "https://openrouter.example/auth",
			credentialStore: store,
			browser: { openExternal: (url) => void (openedUrl = url) },
			callback: {
				open: async () => ({
					redirectUri: "http://127.0.0.1:4545/callback",
					waitForCallback: async () => ({
						code: "code",
						state:
							new URL(
								new URL(openedUrl).searchParams.get("callback_url")!,
							).searchParams.get("state") ?? "",
					}),
					close: () => void (closed = true),
				}),
			},
			exchange: {
				exchangeAuthorizationCode: async ({ codeVerifier }) => {
					exchangedVerifier = codeVerifier;
					return { apiKey: "device-local-key" };
				},
			},
			crypto: { randomBytes: () => bytes(7), sha256: async () => bytes(8) },
		});

		await oauth.connect();
		expect(exchangedVerifier).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(stored).toEqual(["device-local-key"]);
		expect(closed).toBe(true);
	});

	it("rejects a state mismatch without exchanging or storing a credential", async () => {
		let exchanged = false;
		let stored = false;
		const oauth = new OpenRouterOAuth({
			authorizationEndpoint: "https://openrouter.example/auth",
			credentialStore: {
				get: async () => null,
				set: async () => void (stored = true),
				clear: async () => undefined,
			},
			browser: { openExternal: () => undefined },
			callback: {
				open: async () => ({
					redirectUri: "http://127.0.0.1:4545/callback",
					waitForCallback: async () => ({ code: "code", state: "wrong" }),
					close: () => undefined,
				}),
			},
			exchange: {
				exchangeAuthorizationCode: async () => {
					exchanged = true;
					return { apiKey: "must-not-store" };
				},
			},
			crypto: { randomBytes: () => bytes(1), sha256: async () => bytes(2) },
		});

		await expect(oauth.connect()).rejects.toBeInstanceOf(OAuthStateMismatchError);
		expect(exchanged).toBe(false);
		expect(stored).toBe(false);
	});

	it("closes the temporary callback when OAuth is cancelled", async () => {
		let closed = false;
		let exchanged = false;
		const controller = new AbortController();
		const oauth = new OpenRouterOAuth({
			authorizationEndpoint: "https://openrouter.example/auth",
			credentialStore: {
				get: async () => null,
				set: async () => undefined,
				clear: async () => undefined,
			},
			browser: { openExternal: () => undefined },
			callback: {
				open: async () => ({
					redirectUri: "http://127.0.0.1:4545/callback",
					waitForCallback: async (signal) => {
						if (signal?.aborted) throw new Error("aborted");
						return new Promise<{ code: string; state: string }>((_resolve, reject) => {
							signal?.addEventListener("abort", () => reject(new Error("aborted")), {
								once: true,
							});
						});
					},
					close: () => void (closed = true),
				}),
			},
			exchange: {
				exchangeAuthorizationCode: async () => {
					exchanged = true;
					return { apiKey: "must-not-store" };
				},
			},
		});

		const pending = oauth.connect(controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "cancelled" });
		expect(exchanged).toBe(false);
		expect(closed).toBe(true);
	});

	it("clears the local key and explicitly reports that self-revocation is unsupported", async () => {
		let credential: string | null = "device-local-key";
		const oauth = new OpenRouterOAuth({
			authorizationEndpoint: "https://openrouter.example/auth",
			credentialStore: {
				get: async () => credential,
				set: async (secret) => void (credential = secret),
				clear: async () => void (credential = null),
			},
			browser: { openExternal: () => undefined },
			callback: {
				open: async () => {
					throw new Error("unused");
				},
			},
			exchange: {
				exchangeAuthorizationCode: async () => {
					throw new Error("unused");
				},
			},
		});

		const result = await oauth.disconnect();
		expect(result).toEqual({
			localCredentialCleared: true,
			remoteRevocation: "unsupported",
			reason: "openrouter-oauth-key-self-revocation-not-supported",
		});
		expect(credential).toBeNull();
		expect(JSON.stringify(result)).not.toContain("device-local-key");
	});
});
