import { z } from "../../schema/zod";

const OpenRouterToolCallSchema = z
	.object({
		id: z.string().min(1),
		function: z.object({ name: z.string().min(1), arguments: z.string() }).strict(),
	})
	.passthrough();

const OpenRouterMessageSchema = z
	.object({
		role: z.string(),
		content: z.string().nullable().optional(),
		tool_calls: z.array(OpenRouterToolCallSchema).optional(),
	})
	.passthrough();

export const OpenRouterCompletionSchema = z
	.object({
		id: z.string().min(1),
		model: z.string().min(1),
		choices: z.array(z.object({ message: OpenRouterMessageSchema }).passthrough()).min(1),
	})
	.passthrough();

export const OpenRouterStreamChunkSchema = z
	.object({
		id: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		choices: z
			.array(
				z
					.object({
						delta: z
							.object({
								content: z.string().nullable().optional(),
								tool_calls: z
									.array(
										z
											.object({
												index: z.number().int().nonnegative().optional(),
												id: z.string().optional(),
												function: z
													.object({
														name: z.string().optional(),
														arguments: z.string().optional(),
													})
													.passthrough()
													.optional(),
											})
											.passthrough(),
									)
									.optional(),
							})
							.passthrough(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();
