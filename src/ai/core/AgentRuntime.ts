import { asAIError } from "./errors";
import type { AgentEvent } from "./events";
import type { AgentMessage } from "./messages";
import type {
	AIProviderPort,
	ProviderJsonCompletion,
	ProviderJsonRequest,
	ProviderRequest,
} from "../providers/AIProviderPort";

export interface RuntimeRequest extends ProviderRequest {}

/**
 * Provider-neutral coordinator. It deliberately contains no vault, credential,
 * or tool execution access; integration supplies a validated provider and tool
 * layer at this boundary.
 */
export class AgentRuntime {
	constructor(private readonly provider: AIProviderPort) {}

	async complete(request: RuntimeRequest, signal?: AbortSignal): Promise<AgentMessage> {
		try {
			const completion = await this.provider.complete(request, { signal });
			return completion.message;
		} catch (error: unknown) {
			throw asAIError(error);
		}
	}

	async completeJson<T>(
		request: ProviderJsonRequest<T>,
		signal?: AbortSignal,
	): Promise<ProviderJsonCompletion<T>> {
		try {
			return await this.provider.completeJson(request, { signal });
		} catch (error: unknown) {
			throw asAIError(error);
		}
	}

	async *stream(request: RuntimeRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
		try {
			for await (const event of this.provider.stream(request, { signal })) {
				switch (event.type) {
					case "response-started":
						yield event;
						break;
					case "text-delta":
						yield event;
						break;
					case "tool-call":
						yield event;
						break;
					case "response-completed":
						yield {
							type: "response-completed",
							...event.completion,
						};
						break;
				}
			}
		} catch (error: unknown) {
			yield { type: "response-failed", error: asAIError(error) };
		}
	}
}
