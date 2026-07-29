/** Safe error taxonomy. Human-readable provider bodies are deliberately omitted. */
export type AIErrorCode =
	| "authentication"
	| "cancelled"
	| "configuration"
	| "invalid-response"
	| "network"
	| "provider-unavailable"
	| "rate-limited"
	| "unknown";

export interface AIErrorDetails {
	code: AIErrorCode;
	retryable: boolean;
	retryAfterMs: number | null;
	statusCode: number | null;
}

export class AIError extends Error implements AIErrorDetails {
	readonly code: AIErrorCode;
	readonly retryable: boolean;
	readonly retryAfterMs: number | null;
	readonly statusCode: number | null;

	constructor(details: AIErrorDetails) {
		super(details.code);
		this.name = "AIError";
		this.code = details.code;
		this.retryable = details.retryable;
		this.retryAfterMs = details.retryAfterMs;
		this.statusCode = details.statusCode;
	}
}

export function cancelledError(): AIError {
	return new AIError({
		code: "cancelled",
		retryable: false,
		retryAfterMs: null,
		statusCode: null,
	});
}

/**
 * Parses Retry-After without retaining response content. Date values are
 * interpreted relative to the supplied clock to keep tests deterministic.
 */
export function retryAfterMs(value: string | null, nowMs = Date.now()): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		const delay = Math.ceil(seconds * 1000);
		// Avoid propagating an attacker/provider-controlled Infinity or a delay
		// that cannot be represented by Date, which would later break queue/UI
		// timestamp construction.
		if (Number.isSafeInteger(delay) && Number.isFinite(new Date(nowMs + delay).getTime())) {
			return delay;
		}
		return null;
	}
	const dateMs = Date.parse(value);
	if (Number.isNaN(dateMs)) return null;
	return Math.max(0, dateMs - nowMs);
}

/** Classifies only status and headers; callers must not pass response text. */
export function classifyHttpError(
	statusCode: number,
	headers: Pick<Headers, "get">,
	nowMs = Date.now(),
): AIError {
	const retryAfter = retryAfterMs(headers.get("retry-after"), nowMs);
	if (statusCode === 401 || statusCode === 403) {
		return new AIError({
			code: "authentication",
			retryable: false,
			retryAfterMs: null,
			statusCode,
		});
	}
	if (statusCode === 429) {
		return new AIError({
			code: "rate-limited",
			retryable: true,
			retryAfterMs: retryAfter,
			statusCode,
		});
	}
	if (statusCode === 503) {
		return new AIError({
			code: "provider-unavailable",
			retryable: true,
			retryAfterMs: retryAfter,
			statusCode,
		});
	}
	if (statusCode >= 500) {
		return new AIError({
			code: "provider-unavailable",
			retryable: true,
			retryAfterMs: retryAfter,
			statusCode,
		});
	}
	return new AIError({
		code: "unknown",
		retryable: false,
		retryAfterMs: null,
		statusCode,
	});
}

export function asAIError(error: unknown): AIError {
	if (error instanceof AIError) return error;
	if (isAbortError(error)) return cancelledError();
	return new AIError({
		code: "network",
		retryable: true,
		retryAfterMs: null,
		statusCode: null,
	});
}

function isAbortError(error: unknown): boolean {
	return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}
