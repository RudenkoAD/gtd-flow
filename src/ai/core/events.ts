import type { AIErrorDetails } from "./errors";
import type { AgentMessage, AgentToolCall } from "./messages";

/** Events emitted by AgentRuntime; suitable for UI, persistence and tests. */
export type AgentEvent =
	| {
			type: "response-started";
			provider: string;
			responseId: string;
			actualModel: string;
	  }
	| { type: "text-delta"; text: string }
	| { type: "tool-call"; call: AgentToolCall }
	| {
			type: "response-completed";
			provider: string;
			responseId: string;
			actualModel: string;
			message: AgentMessage;
	  }
	| { type: "response-failed"; error: AIErrorDetails };
