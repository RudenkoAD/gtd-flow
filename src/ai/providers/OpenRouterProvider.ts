import { AIError, asAIError, cancelledError, classifyHttpError } from "../core/errors";
import type { AgentMessage, AgentToolCall, AgentToolDefinition } from "../core/messages";
import type {
	AIProviderPort,
	ProviderCompletion,
	ProviderJsonCompletion,
	ProviderJsonRequest,
	ProviderPrivacyPolicy,
	ProviderRequest,
	ProviderRequestOptions,
	ProviderStreamEvent,
} from "./AIProviderPort";
import type { Infer } from "../../schema/zod";
import { OpenRouterCompletionSchema, OpenRouterStreamChunkSchema } from "./openRouterSchemas";
import { parseServerSentEvents } from "./sseParser";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenRouterProviderOptions {
	/** A local-only credential lookup. The key is never logged or persisted here. */
	getApiKey: () => Promise<string | null> | string | null;
	fetch?: FetchLike;
	baseUrl?: string;
	now?: () => Date;
	createMessageId?: () => string;
	/**
	 * Explicit user policy or a resolver read for every request. A resolver lets
	 * settings changes take effect without rebuilding the provider. `require-zdr`
	 * may leave no compatible free endpoint; the adapter never retries by
	 * silently relaxing it.
	 */
	privacyPolicy: ProviderPrivacyPolicy | (() => ProviderPrivacyPolicy);
}

const FREE_ROUTE = "openrouter/free";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * OpenRouter adapter. All requests use the free route and a single supplied
 * credential. There is intentionally no retry or paid-model fallback here.
 */
export class OpenRouterProvider implements AIProviderPort {
	private readonly fetchFn: FetchLike;
	private readonly baseUrl: string;
	private readonly now: () => Date;
	private readonly createMessageId: () => string;

	constructor(private readonly options: OpenRouterProviderOptions) {
		this.fetchFn = options.fetch ?? fetch;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.now = options.now ?? (() => new Date());
		this.createMessageId = options.createMessageId ?? (() => crypto.randomUUID());
	}

	async complete(
		request: ProviderRequest,
		options?: ProviderRequestOptions,
	): Promise<ProviderCompletion> {
		const response = await this.post(
			this.requestBody(request, false, this.resolvePrivacyPolicy(options?.privacyPolicy)),
			options?.signal,
		);
		const payload = await this.parseJson(response, options?.signal);
		throwProviderPayloadError(payload, response.headers);
		const parsed = OpenRouterCompletionSchema.safeParse(payload);
		if (!parsed.success) throw invalidResponseError();
		return this.toCompletion(parsed.data);
	}

	async completeJson<T>(
		request: ProviderJsonRequest<T>,
		options?: ProviderRequestOptions,
	): Promise<ProviderJsonCompletion<T>> {
		const body = {
			...this.requestBody(request, false, this.resolvePrivacyPolicy(options?.privacyPolicy)),
			response_format: {
				type: "json_schema",
				json_schema: {
					name: request.responseSchema.name,
					strict: true,
					schema: request.responseSchema.schema,
				},
			},
		};
		const response = await this.post(body, options?.signal);
		const payload = await this.parseJson(response, options?.signal);
		throwProviderPayloadError(payload, response.headers);
		const parsed = OpenRouterCompletionSchema.safeParse(payload);
		if (!parsed.success) throw invalidResponseError();
		const completion = this.toCompletion(parsed.data);
		let jsonValue: unknown;
		try {
			jsonValue = JSON.parse(completion.message.content);
		} catch {
			throw invalidResponseError();
		}
		try {
			return { ...completion, json: request.responseSchema.parse(jsonValue) };
		} catch {
			throw invalidResponseError();
		}
	}

	async *stream(
		request: ProviderRequest,
		options?: ProviderRequestOptions,
	): AsyncGenerator<ProviderStreamEvent> {
		try {
			yield* this.streamInternal(request, options);
		} catch (error: unknown) {
			throw asAIError(error);
		}
	}

	private async *streamInternal(
		request: ProviderRequest,
		options?: ProviderRequestOptions,
	): AsyncGenerator<ProviderStreamEvent> {
		throwIfAborted(options?.signal);
		const response = await this.post(
			this.requestBody(request, true, this.resolvePrivacyPolicy(options?.privacyPolicy)),
			options?.signal,
		);
		if (!response.body) throw invalidResponseError();

		let responseId: string | null = null;
		let actualModel: string | null = null;
		let started = false;
		let text = "";
		const toolParts = new Map<number, { id?: string; name?: string; arguments: string }>();
		for await (const event of parseServerSentEvents(readableStreamChunks(response.body))) {
			throwIfAborted(options?.signal);
			if (event.event === "error") {
				throw providerErrorFromEventData(event.data, response.headers);
			}
			if (event.data === "[DONE]") break;
			let json: unknown;
			try {
				json = JSON.parse(event.data);
			} catch {
				throw invalidResponseError();
			}
			throwProviderPayloadError(json, response.headers);
			const chunk = OpenRouterStreamChunkSchema.safeParse(json);
			if (!chunk.success) throw invalidResponseError();
			if (chunk.data.id) responseId = chunk.data.id;
			if (chunk.data.model) actualModel = chunk.data.model;
			if (!started && responseId && actualModel) {
				yield {
					type: "response-started",
					provider: "openrouter",
					responseId,
					actualModel,
				};
				started = true;
			}
			for (const choice of chunk.data.choices ?? []) {
				const content = choice.delta.content;
				if (content) {
					text += content;
					yield { type: "text-delta", text: content };
				}
				for (const [fallbackIndex, part] of (choice.delta.tool_calls ?? []).entries()) {
					const index = part.index ?? fallbackIndex;
					const existing = toolParts.get(index) ?? { arguments: "" };
					existing.id ??= part.id;
					existing.name ??= part.function?.name;
					existing.arguments += part.function?.arguments ?? "";
					toolParts.set(index, existing);
				}
			}
		}
		if (!responseId || !actualModel) throw invalidResponseError();
		const toolCalls = assembleToolCalls(toolParts);
		for (const call of toolCalls) yield { type: "tool-call", call };
		const completion: ProviderCompletion = {
			provider: "openrouter",
			responseId,
			actualModel,
			message: this.assistantMessage(text, actualModel, toolCalls),
			toolCalls,
		};
		yield { type: "response-completed", completion };
	}

	private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		throwIfAborted(signal);
		const apiKey = await this.options.getApiKey();
		throwIfAborted(signal);
		if (!apiKey) {
			throw new AIError({
				code: "authentication",
				retryable: false,
				retryAfterMs: null,
				statusCode: null,
			});
		}
		try {
			const response = await this.fetchFn(this.baseUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) throw classifyHttpError(response.status, response.headers);
			return response;
		} catch (error: unknown) {
			throw asAIError(error);
		}
	}

	private requestBody(
		request: ProviderRequest,
		stream: boolean,
		privacyPolicy: ProviderPrivacyPolicy,
	): Record<string, unknown> {
		return {
			model: FREE_ROUTE,
			stream,
			provider:
				privacyPolicy === "require-zdr"
					? { require_parameters: true, data_collection: "deny", zdr: true }
					: { require_parameters: true },
			messages: request.messages.map(toOpenRouterMessage),
			...(request.tools && request.tools.length > 0
				? { tools: toOpenRouterTools(request.tools) }
				: {}),
		};
	}

	private resolvePrivacyPolicy(requestPolicy?: ProviderPrivacyPolicy): ProviderPrivacyPolicy {
		if (requestPolicy !== undefined) {
			if (requestPolicy === "account-policy" || requestPolicy === "require-zdr") {
				return requestPolicy;
			}
			throw invalidPrivacyPolicyError();
		}
		let configured: unknown;
		try {
			configured =
				typeof this.options.privacyPolicy === "function"
					? this.options.privacyPolicy()
					: this.options.privacyPolicy;
		} catch {
			throw invalidPrivacyPolicyError();
		}
		if (configured !== "account-policy" && configured !== "require-zdr") {
			throw invalidPrivacyPolicyError();
		}
		return configured;
	}

	private async parseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			if (signal?.aborted) throw cancelledError();
			throw invalidResponseError();
		}
	}

	private toCompletion(payload: Infer<typeof OpenRouterCompletionSchema>): ProviderCompletion {
		const choice = payload.choices[0];
		if (!choice) throw invalidResponseError();
		const content = choice.message.content ?? "";
		const toolCalls =
			choice.message.tool_calls?.map((call) => {
				let args: unknown;
				try {
					args = JSON.parse(call.function.arguments);
				} catch {
					throw invalidResponseError();
				}
				return { id: call.id, name: call.function.name, arguments: args };
			}) ?? [];
		return {
			provider: "openrouter",
			responseId: payload.id,
			actualModel: payload.model,
			message: this.assistantMessage(content, payload.model, toolCalls),
			toolCalls,
		};
	}

	private assistantMessage(
		content: string,
		model: string,
		toolCalls: AgentToolCall[] = [],
	): AgentMessage {
		return {
			id: this.createMessageId(),
			role: "assistant",
			content,
			createdAt: this.now().toISOString(),
			provider: "openrouter",
			model,
			...(toolCalls.length > 0 ? { toolCalls } : {}),
		};
	}
}

function toOpenRouterMessage(message: AgentMessage): Record<string, unknown> {
	if (message.role === "tool") {
		if (!message.toolCallId) throw invalidResponseError();
		return {
			role: "tool",
			content: message.content,
			tool_call_id: message.toolCallId,
		};
	}
	return {
		role: message.role,
		content: message.content,
		...(message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0
			? {
					tool_calls: message.toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.arguments) },
					})),
				}
			: {}),
	};
}

function toOpenRouterTools(tools: AgentToolDefinition[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

function assembleToolCalls(
	parts: Map<number, { id?: string; name?: string; arguments: string }>,
): AgentToolCall[] {
	return [...parts.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, part]) => {
			if (!part.id || !part.name) throw invalidResponseError();
			try {
				return { id: part.id, name: part.name, arguments: JSON.parse(part.arguments) };
			} catch {
				throw invalidResponseError();
			}
		});
}

async function* readableStreamChunks(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) return;
			yield result.value;
		}
	} finally {
		reader.releaseLock();
	}
}

function invalidResponseError(): AIError {
	return new AIError({
		code: "invalid-response",
		retryable: false,
		retryAfterMs: null,
		statusCode: null,
	});
}

function invalidPrivacyPolicyError(): AIError {
	return new AIError({
		code: "unknown",
		retryable: false,
		retryAfterMs: null,
		statusCode: null,
	});
}

/**
 * OpenRouter can return an in-band error after HTTP headers have already been
 * committed. Read only the stable numeric/type fields needed for retry policy;
 * provider messages are neither copied into the error nor logged.
 */
function throwProviderPayloadError(value: unknown, headers: Pick<Headers, "get">): void {
	const error = providerPayloadError(value, headers);
	if (error !== null) throw error;
}

function providerPayloadError(value: unknown, headers: Pick<Headers, "get">): AIError | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const envelope = value as Record<string, unknown>;
	const rawError = envelope["error"];
	if (typeof rawError !== "object" || rawError === null || Array.isArray(rawError)) {
		return null;
	}
	const error = rawError as Record<string, unknown>;
	const metadata =
		typeof error["metadata"] === "object" &&
		error["metadata"] !== null &&
		!Array.isArray(error["metadata"])
			? (error["metadata"] as Record<string, unknown>)
			: null;
	const errorType =
		typeof metadata?.["error_type"] === "string"
			? metadata["error_type"]
			: typeof error["error_type"] === "string"
				? error["error_type"]
				: typeof envelope["error_type"] === "string"
					? envelope["error_type"]
					: null;
	const statusCode =
		typeof error["code"] === "number" &&
		Number.isSafeInteger(error["code"]) &&
		error["code"] >= 100 &&
		error["code"] <= 599
			? error["code"]
			: null;

	if (errorType === "rate_limit_exceeded" || statusCode === 429) {
		return classifyHttpError(429, headers);
	}
	if (errorType === "authentication") {
		return classifyHttpError(statusCode === 403 ? 403 : 401, headers);
	}
	if (
		errorType === "provider_overloaded" ||
		errorType === "provider_unavailable" ||
		errorType === "timeout" ||
		errorType === "server"
	) {
		return classifyHttpError(
			statusCode !== null && statusCode >= 500 ? statusCode : 503,
			headers,
		);
	}
	if (statusCode !== null) return classifyHttpError(statusCode, headers);
	return invalidResponseError();
}

function providerErrorFromEventData(data: string, headers: Pick<Headers, "get">): AIError {
	try {
		return providerPayloadError(JSON.parse(data), headers) ?? invalidResponseError();
	} catch {
		return invalidResponseError();
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelledError();
}
