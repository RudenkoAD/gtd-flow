import type { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "../core/messages";
import { permissionForRisk, type ToolRisk } from "./permissionPolicy";

const MAX_TOOL_RESULT_CHARS = 30_000;

export interface ReversibleToolResult {
	value: unknown;
	undo?: () => Promise<void>;
}

/**
 * Trusted runtime metadata attached by the controller, never supplied by the
 * model. Write tools use it to attribute durable feedback to the chat that
 * proposed the mutation.
 */
export interface ToolExecutionContext {
	sessionId: string;
	actualModel: string;
	signal?: AbortSignal;
}

export interface RegisteredTool<TSchema extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	schema: TSchema;
	risk: ToolRisk;
	preview?: (input: z.output<TSchema>) => string;
	execute: (
		input: z.output<TSchema>,
		context?: ToolExecutionContext,
	) => Promise<ReversibleToolResult>;
}

export type ToolExecutionResult =
	| {
			status: "completed";
			callId: string;
			toolName: string;
			result: unknown;
			undoId: string | null;
	  }
	| {
			status: "approval-required";
			callId: string;
			toolName: string;
			approvalId: string;
			preview: string;
	  }
	| {
			status: "rejected";
			callId: string;
			toolName: string;
			reason: "unknown-tool" | "invalid-arguments" | "approval-rejected";
	  };

interface PendingApproval {
	call: AgentToolCall;
	tool: RegisteredTool;
	parsed: unknown;
	context?: ToolExecutionContext;
}

/**
 * The model proposes calls; this registry validates and executes them through
 * narrow application ports. It never exposes a filesystem or shell primitive.
 */
export class ToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>();
	private readonly pending = new Map<string, PendingApproval>();
	private readonly undos = new Map<string, () => Promise<void>>();

	constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

	register<TSchema extends z.ZodType>(tool: RegisteredTool<TSchema>): void {
		if (!/^[a-z][a-z0-9_]{1,63}$/u.test(tool.name)) throw new Error("invalid-tool-name");
		if (
			tool.risk !== "read" &&
			tool.risk !== "reversible-write" &&
			tool.risk !== "destructive-or-bulk"
		) {
			throw new Error("invalid-tool-risk");
		}
		if (this.tools.has(tool.name)) throw new Error("duplicate-tool-name");
		this.tools.set(tool.name, tool as RegisteredTool);
	}

	definitions(): AgentToolDefinition[] {
		return [...this.tools.values()].map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
	}

	async handle(
		call: AgentToolCall,
		context?: ToolExecutionContext,
	): Promise<ToolExecutionResult> {
		const tool = this.tools.get(call.name);
		if (!tool) {
			return {
				status: "rejected",
				callId: call.id,
				toolName: call.name,
				reason: "unknown-tool",
			};
		}
		const parsed = tool.schema.safeParse(call.arguments);
		if (!parsed.success) {
			return {
				status: "rejected",
				callId: call.id,
				toolName: call.name,
				reason: "invalid-arguments",
			};
		}
		if (permissionForRisk(tool.risk) === "require-approval") {
			const approvalId = safeOpaqueId(this.createId());
			this.pending.set(approvalId, { call, tool, parsed: parsed.data, context });
			return {
				status: "approval-required",
				callId: call.id,
				toolName: call.name,
				approvalId,
				preview: boundedText(tool.preview?.(parsed.data) ?? `Run ${tool.name}`),
			};
		}
		return this.execute(call, tool, parsed.data, context);
	}

	async approve(approvalId: string): Promise<ToolExecutionResult> {
		const pending = this.pending.get(approvalId);
		if (!pending) throw new Error("approval-not-found");
		this.pending.delete(approvalId);
		return this.execute(pending.call, pending.tool, pending.parsed, pending.context);
	}

	reject(approvalId: string): ToolExecutionResult {
		const pending = this.pending.get(approvalId);
		if (!pending) throw new Error("approval-not-found");
		this.pending.delete(approvalId);
		return {
			status: "rejected",
			callId: pending.call.id,
			toolName: pending.call.name,
			reason: "approval-rejected",
		};
	}

	async undo(undoId: string): Promise<void> {
		const undo = this.undos.get(undoId);
		if (!undo) throw new Error("undo-not-found");
		// Remove before awaiting so a double-click cannot run the same inverse
		// concurrently. A failed inverse remains retryable; only a successful undo
		// consumes its one-shot handle.
		this.undos.delete(undoId);
		try {
			await undo();
		} catch (error: unknown) {
			if (!this.undos.has(undoId)) this.undos.set(undoId, undo);
			throw error;
		}
	}

	pendingApprovalCount(): number {
		return this.pending.size;
	}

	private async execute(
		call: AgentToolCall,
		tool: RegisteredTool,
		parsed: unknown,
		context?: ToolExecutionContext,
	): Promise<ToolExecutionResult> {
		throwIfAborted(context?.signal);
		const result =
			context === undefined
				? await tool.execute(parsed)
				: await tool.execute(parsed, context);
		let undoId: string | null = null;
		if (tool.risk === "reversible-write") {
			if (typeof result.undo !== "function") {
				throw new Error("reversible-tool-missing-undo");
			}
			undoId = safeOpaqueId(this.createId());
			this.undos.set(undoId, result.undo);
		}
		return {
			status: "completed",
			callId: call.id,
			toolName: tool.name,
			result: boundToolResult(result.value),
			undoId,
		};
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("tool-execution-aborted");
	error.name = "AbortError";
	throw error;
}

function boundToolResult(value: unknown): unknown {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return { truncated: true, reason: "unserializable-result" };
	}
	if (serialized === undefined) {
		return { truncated: true, reason: "unserializable-result" };
	}
	if (serialized.length <= MAX_TOOL_RESULT_CHARS) return value;
	return {
		truncated: true,
		preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS),
	};
}

function boundedText(value: string): string {
	return value.slice(0, 2_000);
}

function safeOpaqueId(value: string): string {
	const id = value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
	return /^[A-Za-z0-9]/u.test(id) ? id : `id_${id}`;
}
