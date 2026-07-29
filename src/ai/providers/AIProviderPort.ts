import type { AgentMessage, AgentToolCall, AgentToolDefinition } from "../core/messages";

/** JSON Schema is kept provider-neutral and supplied by a validated caller. */
export type JsonSchema = Record<string, unknown>;

export interface ProviderRequest {
	messages: AgentMessage[];
	tools?: AgentToolDefinition[];
}

export interface ProviderJsonRequest<T> extends ProviderRequest {
	responseSchema: {
		name: string;
		schema: JsonSchema;
		parse: (value: unknown) => T;
	};
}

export interface ProviderCompletion {
	provider: string;
	responseId: string;
	/** The model OpenRouter actually selected, never the requested route. */
	actualModel: string;
	message: AgentMessage;
	toolCalls: AgentToolCall[];
}

export interface ProviderJsonCompletion<T> extends ProviderCompletion {
	json: T;
}

/**
 * `account-policy` delegates provider data handling to the user's OpenRouter
 * account settings. `require-zdr` adds fail-closed per-request restrictions.
 */
export type ProviderPrivacyPolicy = "account-policy" | "require-zdr";

export interface ProviderRequestOptions {
	signal?: AbortSignal;
	/**
	 * Optional per-call override. Providers must not silently relax an explicit
	 * `require-zdr` selection when no compatible endpoint is available.
	 */
	privacyPolicy?: ProviderPrivacyPolicy;
}

export type ProviderStreamEvent =
	| {
			type: "response-started";
			provider: string;
			responseId: string;
			actualModel: string;
	  }
	| { type: "text-delta"; text: string }
	| { type: "tool-call"; call: AgentToolCall }
	| { type: "response-completed"; completion: ProviderCompletion };

export interface AIProviderPort {
	complete(
		request: ProviderRequest,
		options?: ProviderRequestOptions,
	): Promise<ProviderCompletion>;
	completeJson<T>(
		request: ProviderJsonRequest<T>,
		options?: ProviderRequestOptions,
	): Promise<ProviderJsonCompletion<T>>;
	stream(
		request: ProviderRequest,
		options?: ProviderRequestOptions,
	): AsyncIterable<ProviderStreamEvent>;
}
