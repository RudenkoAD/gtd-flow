/** Provider-neutral chat message contracts. */
import { type Infer, z } from "../../schema/zod";

export const AgentMessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type AgentMessageRole = Infer<typeof AgentMessageRoleSchema>;

const MAX_TOOL_ARGUMENT_CHARS = 60_000;

/**
 * Message IDs are local correlation IDs. They intentionally never contain task
 * titles, prompt text, credentials, or provider request identifiers.
 */
export const AgentMessageSchema = z
	.object({
		id: z.string().min(1).max(200),
		role: AgentMessageRoleSchema,
		content: z.string(),
		createdAt: z.string().datetime({ offset: true }),
		provider: z.string().min(1).max(100).optional(),
		model: z.string().min(1).max(300).optional(),
		/** Present on assistant messages that proposed validated application tools. */
		toolCalls: z
			.array(
				z
					.object({
						id: z.string().min(1).max(200),
						name: z.string().min(1).max(100),
						arguments: z.unknown(),
					})
					.strict(),
			)
			.max(20)
			.optional(),
		/** Present on a tool result and matched to one assistant tool call. */
		toolCallId: z.string().min(1).max(200).optional(),
	})
	.strict()
	.superRefine((message, context) => {
		if (message.role === "tool" && message.toolCallId === undefined) {
			context.addIssue({
				code: "custom",
				path: ["toolCallId"],
				message: "Tool messages must identify their tool call",
			});
		}
		if (message.toolCallId !== undefined && message.role !== "tool") {
			context.addIssue({
				code: "custom",
				path: ["toolCallId"],
				message: "Only tool messages may have toolCallId",
			});
		}
		if (message.toolCalls !== undefined && message.role !== "assistant") {
			context.addIssue({
				code: "custom",
				path: ["toolCalls"],
				message: "Only assistant messages may have toolCalls",
			});
		}
		if (message.toolCalls !== undefined) {
			const ids = new Set<string>();
			let argumentChars = 0;
			let argumentsAreJson = true;
			for (const [index, call] of message.toolCalls.entries()) {
				if (ids.has(call.id)) {
					context.addIssue({
						code: "custom",
						path: ["toolCalls", index, "id"],
						message: "Tool call IDs must be unique within one response",
					});
				}
				ids.add(call.id);
				try {
					const serialized = JSON.stringify(call.arguments);
					if (serialized === undefined) argumentsAreJson = false;
					else argumentChars += serialized.length;
				} catch {
					argumentsAreJson = false;
				}
			}
			if (!argumentsAreJson || argumentChars > MAX_TOOL_ARGUMENT_CHARS) {
				context.addIssue({
					code: "custom",
					path: ["toolCalls"],
					message: "Tool call arguments must be bounded JSON",
				});
			}
		}
	});
export type AgentMessage = Infer<typeof AgentMessageSchema>;

/** A narrow tool contract for future validated application-tool adapters. */
export interface AgentToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface AgentToolCall {
	id: string;
	name: string;
	arguments: unknown;
}
