import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore } from "./MemoryCredentialStore";
import { OpenRouterCodeExchange, OpenRouterOAuthConnection } from "./DesktopOpenRouterOAuth";

describe("desktop OpenRouter OAuth adapters", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.doUnmock("node:http");
		vi.resetModules();
	});

	// §мобильность: `node:http` подтягивается ЛЕНИВО, внутри open(). Верхний
	// import ронял бы весь плагин на телефоне, из-за чего manifest и уводили в
	// isDesktopOnly. Отсутствие модуля — понятная configuration-ошибка.
	it("loads node:http lazily and reports its absence as a configuration error", async () => {
		vi.resetModules();
		vi.doMock("node:http", () => {
			throw new Error("mobile-runtime-has-no-node-builtins");
		});

		const { LoopbackOAuthCallback } = await import("./DesktopOpenRouterOAuth");

		await expect(new LoopbackOAuthCallback().open()).rejects.toMatchObject({
			code: "configuration",
			retryable: false,
		});
	});

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
	// §fetch-brand-check: дефолтный обменник обязан звать глобальный fetch от
	// globalThis — иначе в Obsidian (Chromium) обмен кода падал с «Illegal
	// invocation» и пользователь видел «нет сети» при рабочей сети.
	it("calls the default global fetch with a global receiver", async () => {
		function brandCheckedFetch(this: unknown): Promise<Response> {
			if (this !== globalThis) {
				throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
			}
			return Promise.resolve(
				new Response(JSON.stringify({ key: "device-key" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}
		vi.stubGlobal("fetch", brandCheckedFetch);

		const exchange = new OpenRouterCodeExchange();
		await expect(
			exchange.exchangeAuthorizationCode({
				code: "code-1",
				codeVerifier: "verifier-1",
				redirectUri: "http://127.0.0.1:1234/callback",
			}),
		).resolves.toEqual({ apiKey: "device-key" });
	});
});
