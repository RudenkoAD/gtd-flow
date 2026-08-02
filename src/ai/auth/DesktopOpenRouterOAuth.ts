import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AIError, cancelledError, classifyHttpError } from "../core/errors";
import type { AIConnectionPort } from "../integration/AIViewController";
import type { CredentialStorePort } from "./CredentialStorePort";
import {
	OpenRouterOAuth,
	type OAuthBrowserPort,
	type OAuthCallbackPort,
	type OAuthCallbackSession,
	type OAuthDisconnectResult,
	type OAuthExchangePort,
} from "./OpenRouterOAuth";

const AUTHORIZATION_ENDPOINT = "https://openrouter.ai/auth";
const EXCHANGE_ENDPOINT = "https://openrouter.ai/api/v1/auth/keys";

export class DesktopOAuthBrowser implements OAuthBrowserPort {
	async openExternal(url: string): Promise<void> {
		const { shell } = await import("electron");
		if (!shell) throw new Error("desktop-shell-unavailable");
		await shell.openExternal(url);
	}
}

/** Temporary loopback callback bound to 127.0.0.1 on an arbitrary free port. */
export class LoopbackOAuthCallback implements OAuthCallbackPort {
	constructor(private readonly timeoutMs = 5 * 60_000) {}

	async open(): Promise<OAuthCallbackSession> {
		// Obsidian Mobile cannot resolve Node built-ins while evaluating main.js.
		// The callback adapter is constructed only by the desktop composition root,
		// and the runtime import keeps the universal plugin bundle loadable on mobile.
		const { createServer } = await import("node:http");
		let settle:
			| {
					resolve(value: { code: string; state: string }): void;
					reject(reason: unknown): void;
			  }
			| undefined;
		const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
			settle = { resolve, reject };
		});
		let settled = false;
		const server = createServer((request, response) => {
			if (settled) {
				response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("This authorization callback is already complete.");
				return;
			}
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Not found.");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code || !state) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Authorization failed. Return to Obsidian and try again.");
				settled = true;
				settle!.reject(authenticationError());
				return;
			}
			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			});
			response.end(
				"<!doctype html><meta charset=utf-8><title>GTD Flow connected</title>" +
					"<p>GTD Flow is connected. You can close this tab and return to Obsidian.</p>",
			);
			settled = true;
			settle!.resolve({ code, state });
		});
		server.on("error", (error) => {
			if (!settled) {
				settled = true;
				settle!.reject(error);
			}
		});
		await listen(server);
		const address = server.address() as AddressInfo;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			settle!.reject(cancelledError());
		}, this.timeoutMs);

		return {
			redirectUri: `http://127.0.0.1:${address.port}/callback`,
			waitForCallback: async (signal) => {
				if (signal?.aborted) throw cancelledError();
				const abort = (): void => {
					if (settled) return;
					settled = true;
					settle!.reject(cancelledError());
				};
				signal?.addEventListener("abort", abort, { once: true });
				try {
					return await callback;
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			},
			close: async () => {
				clearTimeout(timer);
				await close(server);
			},
		};
	}
}

export class OpenRouterCodeExchange implements OAuthExchangePort {
	constructor(private readonly fetchFn: typeof fetch = fetch) {}

	async exchangeAuthorizationCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		signal?: AbortSignal;
	}): Promise<{ apiKey: string }> {
		let response: Response;
		try {
			response = await this.fetchFn(EXCHANGE_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					code: input.code,
					code_verifier: input.codeVerifier,
					code_challenge_method: "S256",
				}),
				signal: input.signal,
			});
		} catch (_error: unknown) {
			if (input.signal?.aborted) throw cancelledError();
			throw new AIError({
				code: "network",
				retryable: true,
				retryAfterMs: null,
				statusCode: null,
			});
		}
		if (!response.ok) throw classifyHttpError(response.status, response.headers);
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw authenticationError();
		}
		if (
			typeof value !== "object" ||
			value === null ||
			typeof (value as Record<string, unknown>)["key"] !== "string" ||
			((value as Record<string, unknown>)["key"] as string).trim() === ""
		) {
			throw authenticationError();
		}
		return { apiKey: (value as { key: string }).key };
	}
}

export class OpenRouterOAuthConnection implements AIConnectionPort {
	readonly oauth: OpenRouterOAuth;

	constructor(
		private readonly credentials: CredentialStorePort,
		options: {
			browser?: OAuthBrowserPort;
			callback?: OAuthCallbackPort;
			exchange?: OAuthExchangePort;
		} = {},
	) {
		this.oauth = new OpenRouterOAuth({
			authorizationEndpoint: AUTHORIZATION_ENDPOINT,
			credentialStore: credentials,
			browser: options.browser ?? new DesktopOAuthBrowser(),
			callback: options.callback ?? new LoopbackOAuthCallback(),
			exchange: options.exchange ?? new OpenRouterCodeExchange(),
		});
	}

	async isConnected(): Promise<boolean> {
		return (await this.credentials.get()) !== null;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		await this.oauth.connect(signal);
	}

	async disconnect(signal?: AbortSignal): Promise<void> {
		await this.disconnectWithResult(signal);
	}

	/** Detailed result for callers that need to explain remote revocation support. */
	disconnectWithResult(signal?: AbortSignal): Promise<OAuthDisconnectResult> {
		return this.oauth.disconnect(signal);
	}
}

function authenticationError(): AIError {
	return new AIError({
		code: "authentication",
		retryable: false,
		retryAfterMs: null,
		statusCode: null,
	});
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}
