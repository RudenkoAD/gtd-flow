import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../core/messages";
import { OpenRouterProvider } from "./OpenRouterProvider";

const message: AgentMessage = {
	id: "message-1",
	role: "user",
	content: "hello",
	createdAt: "2026-07-28T12:00:00.000Z",
};

function completionResponse(content: string) {
	return new Response(
		JSON.stringify({
			id: "response-1",
			model: "free/actual-model",
			choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

/** Соединение принято и молчит — рвётся только по сигналу, как настоящий fetch. */
function hangUntilAbort(signal?: AbortSignal | null): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		signal?.addEventListener("abort", () => reject(abortError()), { once: true });
	});
}

/** SSE-поток отдаёт один валидный чанк и замирает, не закрываясь. */
function stallingStream(signal?: AbortSignal | null): Response {
	const encoder = new TextEncoder();
	const chunk = JSON.stringify({
		id: "response-1",
		model: "free/actual-model",
		choices: [{ delta: { content: "hi" } }],
	});
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
			signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenRouterProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses only openrouter/free and validates strict non-streaming JSON locally", async () => {
		let body: Record<string, unknown> | null = null;
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completionResponse('{"ok":true}');
			},
			createMessageId: () => "assistant-1",
			now: () => new Date("2026-07-28T12:00:01.000Z"),
		});

		const result = await provider.completeJson({
			messages: [message],
			responseSchema: {
				name: "result",
				schema: { type: "object", additionalProperties: false },
				parse(value) {
					if (
						typeof value !== "object" ||
						value === null ||
						(value as { ok?: unknown }).ok !== true
					) {
						throw new Error("invalid");
					}
					return { ok: true as const };
				},
			},
		});

		expect(body).toMatchObject({
			model: "openrouter/free",
			stream: false,
			response_format: { type: "json_schema", json_schema: { name: "result", strict: true } },
			provider: { require_parameters: true },
		});
		expect(result.json).toEqual({ ok: true });
		expect(result.actualModel).toBe("free/actual-model");
		expect(result.message.model).toBe("free/actual-model");
	});

	it.each<[number, string, string, boolean, number]>([
		[429, "2", "rate-limited", true, 2_000],
		[503, "1", "provider-unavailable", true, 1_000],
	])("classifies %s with Retry-After", async (status, retryAfter, code, retryable, delay) => {
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async () =>
				new Response(null, { status, headers: { "retry-after": retryAfter } }),
		});
		await expect(provider.complete({ messages: [message] })).rejects.toMatchObject({
			code,
			retryable,
			retryAfterMs: delay,
			statusCode: status,
		});
	});

	it("classifies an HTTP-200 rate-limit envelope without retaining provider text", async () => {
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 429,
							message: "private provider detail",
							metadata: { error_type: "rate_limit_exceeded" },
						},
					}),
					{ status: 200, headers: { "retry-after": "3" } },
				),
		});
		let failure: unknown;
		try {
			await provider.completeJson({
				messages: [message],
				responseSchema: {
					name: "result",
					schema: { type: "object" },
					parse: (value) => value,
				},
			});
		} catch (error: unknown) {
			failure = error;
		}
		expect(failure).toMatchObject({
			code: "rate-limited",
			retryable: true,
			retryAfterMs: 3_000,
			statusCode: 429,
			message: "rate-limited",
		});
	});

	it("frames SSE deltas, captures the actual model, and supports a done marker", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"id":"response-2","model":"free/selected","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
					),
				);
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"id":"response-2","model":"free/selected","choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
					),
				);
				controller.close();
			},
		});
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async () => new Response(stream, { status: 200 }),
			createMessageId: () => "assistant-2",
			now: () => new Date("2026-07-28T12:00:02.000Z"),
		});
		const events = [];
		for await (const event of provider.stream({ messages: [message] })) events.push(event);
		expect(events).toMatchObject([
			{
				type: "response-started",
				responseId: "response-2",
				actualModel: "free/selected",
			},
			{ type: "text-delta", text: "Hel" },
			{ type: "text-delta", text: "lo" },
			{
				type: "response-completed",
				completion: { actualModel: "free/selected", message: { content: "Hello" } },
			},
		]);
	});

	it("classifies an in-band SSE quota error as rate-limited", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"error":{"code":429,"message":"private detail","metadata":{"error_type":"rate_limit_exceeded"}}}\n\n',
					),
				);
				controller.close();
			},
		});
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async () => new Response(stream, { status: 200 }),
		});
		let failure: unknown;
		try {
			for await (const _event of provider.stream({ messages: [message] })) {
				// No successful event is expected before this terminal envelope.
			}
		} catch (error: unknown) {
			failure = error;
		}
		expect(failure).toMatchObject({
			code: "rate-limited",
			retryable: true,
			statusCode: 429,
			message: "rate-limited",
		});
	});

	it("enforces ZDR when selected and never constructs a relaxed fallback", async () => {
		let body: Record<string, unknown> | null = null;
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completionResponse("ok");
			},
		});
		await provider.complete({ messages: [message] }, { privacyPolicy: "require-zdr" });
		expect(body).toMatchObject({
			model: "openrouter/free",
			provider: { require_parameters: true, data_collection: "deny", zdr: true },
		});
	});

	it("resolves the selected privacy policy for every request", async () => {
		let selected: "account-policy" | "require-zdr" = "account-policy";
		const bodies: Record<string, unknown>[] = [];
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: () => selected,
			fetch: async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return completionResponse("ok");
			},
		});

		await provider.complete({ messages: [message] });
		selected = "require-zdr";
		await provider.complete({ messages: [message] });

		expect(bodies.map((body) => body["provider"])).toEqual([
			{ require_parameters: true },
			{ require_parameters: true, data_collection: "deny", zdr: true },
		]);
	});

	it("fails closed when a dynamic privacy resolver returns an invalid value", async () => {
		let fetched = false;
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: (() => "invalid-policy") as unknown as () => "account-policy",
			fetch: async () => {
				fetched = true;
				return completionResponse("ok");
			},
		});

		await expect(provider.complete({ messages: [message] })).rejects.toMatchObject({
			code: "unknown",
			retryable: false,
		});
		expect(fetched).toBe(false);
	});

	it("fails closed for an invalid per-request privacy override", async () => {
		let fetched = false;
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			fetch: async () => {
				fetched = true;
				return completionResponse("ok");
			},
		});

		await expect(
			provider.complete(
				{ messages: [message] },
				{ privacyPolicy: "invalid-policy" as unknown as "account-policy" },
			),
		).rejects.toMatchObject({ code: "unknown", retryable: false });
		expect(fetched).toBe(false);
	});

	it("does not read credentials or start a request after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let credentialReads = 0;
		let fetched = false;
		const provider = new OpenRouterProvider({
			getApiKey: () => {
				credentialReads++;
				return "local-secret";
			},
			privacyPolicy: "account-policy",
			fetch: async () => {
				fetched = true;
				return completionResponse("ok");
			},
		});

		await expect(
			provider.complete({ messages: [message] }, { signal: controller.signal }),
		).rejects.toMatchObject({
			code: "cancelled",
			retryable: false,
		});
		expect(credentialReads).toBe(0);
		expect(fetched).toBe(false);
	});
	// §fetch-brand-check: глобальный fetch в Chromium делает brand-check на this,
	// поэтому дефолт обязан звать его от globalThis, а не как метод провайдера.
	it("calls the default global fetch with a global receiver", async () => {
		function brandCheckedFetch(this: unknown): Promise<Response> {
			if (this !== globalThis) {
				throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
			}
			return Promise.resolve(completionResponse("ok"));
		}
		vi.stubGlobal("fetch", brandCheckedFetch);

		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
		});

		const result = await provider.complete({ messages: [message] });
		expect(result.message.content).toBe("ok");
	});

	// §таймауты: зависшее соединение обязано оборваться само и вернуться как
	// retryable provider-unavailable, иначе run навсегда остаётся в processing.
	it("aborts a hung request by the request budget and reports it as retryable", async () => {
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			requestTimeoutMs: 10,
			fetch: (_url, init) => hangUntilAbort(init?.signal),
		});

		await expect(provider.complete({ messages: [message] })).rejects.toMatchObject({
			code: "provider-unavailable",
			retryable: true,
		});
	});

	it("aborts a stream that stalls between chunks", async () => {
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			requestTimeoutMs: 5_000,
			streamIdleTimeoutMs: 10,
			fetch: (_url, init) => Promise.resolve(stallingStream(init?.signal)),
		});

		const seen: string[] = [];
		await expect(
			(async () => {
				for await (const event of provider.stream({ messages: [message] })) {
					seen.push(event.type);
				}
			})(),
		).rejects.toMatchObject({ code: "provider-unavailable", retryable: true });
		expect(seen).toContain("response-started");
	});

	it("still reports a user cancellation as cancelled, not as a timeout", async () => {
		const controller = new AbortController();
		const provider = new OpenRouterProvider({
			getApiKey: () => "local-secret",
			privacyPolicy: "account-policy",
			requestTimeoutMs: 5_000,
			fetch: (_url, init) => {
				setTimeout(() => controller.abort(), 0);
				return hangUntilAbort(init?.signal);
			},
		});

		await expect(
			provider.complete({ messages: [message] }, { signal: controller.signal }),
		).rejects.toMatchObject({ code: "cancelled", retryable: false });
	});
});
