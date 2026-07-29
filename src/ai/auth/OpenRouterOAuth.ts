import { AIError, cancelledError } from "../core/errors";
import type { CredentialStorePort } from "./CredentialStorePort";

export interface OAuthCryptoPort {
	randomBytes(length: number): Uint8Array;
	sha256(value: string): Promise<Uint8Array>;
}

export interface OAuthBrowserPort {
	openExternal(url: string): Promise<void> | void;
}

export interface OAuthCallbackSession {
	/** Loopback redirect URI chosen by the session's temporary server. */
	redirectUri: string;
	waitForCallback(signal?: AbortSignal): Promise<{ code: string; state: string }>;
	close(): Promise<void> | void;
}

export interface OAuthCallbackPort {
	open(): Promise<OAuthCallbackSession>;
}

export interface OAuthExchangePort {
	exchangeAuthorizationCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		signal?: AbortSignal;
	}): Promise<{ apiKey: string }>;
}

export interface OpenRouterOAuthOptions {
	authorizationEndpoint: string;
	credentialStore: CredentialStorePort;
	browser: OAuthBrowserPort;
	callback: OAuthCallbackPort;
	exchange: OAuthExchangePort;
	crypto?: OAuthCryptoPort;
}

export interface OAuthStartInfo {
	authorizationUrl: string;
	state: string;
}

export interface OAuthDisconnectResult {
	localCredentialCleared: true;
	remoteRevocation: "unsupported";
	reason: "openrouter-oauth-key-self-revocation-not-supported";
}

/** PKCE/S256 OAuth orchestration with all desktop-specific behavior injected. */
export class OpenRouterOAuth {
	private readonly cryptoPort: OAuthCryptoPort;

	constructor(private readonly options: OpenRouterOAuthOptions) {
		this.cryptoPort = options.crypto ?? createWebCryptoPort();
	}

	async connect(signal?: AbortSignal): Promise<OAuthStartInfo> {
		throwIfAborted(signal);
		const callbackSession = await this.options.callback.open();
		try {
			const pkce = await generatePkce(this.cryptoPort);
			const statefulRedirectUri = callbackUrlWithState(
				callbackSession.redirectUri,
				pkce.state,
			);
			const authorizationUrl = buildAuthorizationUrl({
				authorizationEndpoint: this.options.authorizationEndpoint,
				callbackUrl: statefulRedirectUri,
				state: pkce.state,
				codeChallenge: pkce.codeChallenge,
			});
			await this.options.browser.openExternal(authorizationUrl);
			const callback = await callbackSession.waitForCallback(signal);
			if (!constantTimeEqual(callback.state, pkce.state)) {
				throw new OAuthStateMismatchError();
			}
			throwIfAborted(signal);
			const exchange = await this.options.exchange.exchangeAuthorizationCode({
				code: callback.code,
				codeVerifier: pkce.codeVerifier,
				redirectUri: callbackSession.redirectUri,
				signal,
			});
			if (!exchange.apiKey) {
				throw new AIError({
					code: "authentication",
					retryable: false,
					retryAfterMs: null,
					statusCode: null,
				});
			}
			throwIfAborted(signal);
			await this.options.credentialStore.set(exchange.apiKey);
			return { authorizationUrl, state: pkce.state };
		} catch (error: unknown) {
			if (signal?.aborted) throw cancelledError();
			throw error;
		} finally {
			await callbackSession.close();
		}
	}

	/** A reconnect performs the same PKCE flow and atomically replaces the local key. */
	reconnect(signal?: AbortSignal): Promise<OAuthStartInfo> {
		return this.connect(signal);
	}

	/**
	 * OpenRouter does not currently document a way for an OAuth-generated
	 * inference key to revoke itself. Its documented DELETE /api/v1/keys/:hash
	 * endpoint requires a separate Management API key and a key hash:
	 * https://openrouter.ai/docs/api/api-reference/api-keys/delete-keys
	 *
	 * Disconnect therefore clears the memory-only credential and reports remote
	 * revocation as unsupported. It deliberately makes no guessed network call.
	 */
	async disconnect(signal?: AbortSignal): Promise<OAuthDisconnectResult> {
		void signal;
		await this.options.credentialStore.clear();
		return {
			localCredentialCleared: true,
			remoteRevocation: "unsupported",
			reason: "openrouter-oauth-key-self-revocation-not-supported",
		};
	}
}

export class OAuthStateMismatchError extends Error {
	constructor() {
		super("oauth-state-mismatch");
		this.name = "OAuthStateMismatchError";
	}
}

export interface PkceValues {
	state: string;
	codeVerifier: string;
	codeChallenge: string;
}

export async function generatePkce(cryptoPort: OAuthCryptoPort): Promise<PkceValues> {
	const state = base64Url(cryptoPort.randomBytes(32));
	const codeVerifier = base64Url(cryptoPort.randomBytes(64));
	const codeChallenge = base64Url(await cryptoPort.sha256(codeVerifier));
	return { state, codeVerifier, codeChallenge };
}

export function buildAuthorizationUrl(input: {
	authorizationEndpoint: string;
	callbackUrl: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(input.authorizationEndpoint);
	url.searchParams.set("callback_url", callbackUrlWithState(input.callbackUrl, input.state));
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

function callbackUrlWithState(redirectUri: string, state: string): string {
	const callback = new URL(redirectUri);
	callback.searchParams.set("state", state);
	return callback.toString();
}

export function createWebCryptoPort(webCrypto: Crypto = globalThis.crypto): OAuthCryptoPort {
	return {
		randomBytes(length) {
			const bytes = new Uint8Array(length);
			webCrypto.getRandomValues(bytes);
			return bytes;
		},
		async sha256(value) {
			const encoded = new TextEncoder().encode(value);
			return new Uint8Array(await webCrypto.subtle.digest("SHA-256", encoded));
		},
	};
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelledError();
}
