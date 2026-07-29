import { z } from "zod";
import { isDurationMinutes } from "../../core/model/Task";

/** Canonical duration: five-minute sub-day values or whole-day values. */
export const DurationMinutesSchema = z
	.number()
	.int()
	.refine(Number.isSafeInteger, "Duration must be a safe integer")
	.refine(
		isDurationMinutes,
		"Duration must use five-minute increments below 24h and whole days from 24h upward",
	);
export const NullableDurationMinutesSchema = DurationMinutesSchema.nullable();
export type DurationMinutes = z.infer<typeof DurationMinutesSchema>;

export const IntensityDimensionSchema = z.union([
	z.literal(0),
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
	z.literal(5),
]);
export type IntensityDimension = z.infer<typeof IntensityDimensionSchema>;

export const TaskIntensitySchema = z
	.object({
		cognitive: IntensityDimensionSchema,
		emotional: IntensityDimensionSchema,
		physical: IntensityDimensionSchema,
	})
	.strict();
export type TaskIntensity = z.infer<typeof TaskIntensitySchema>;

export const ProcessingFieldSchema = z.enum([
	"duration",
	"cognitive",
	"emotional",
	"physical",
	"scope",
]);
export type ProcessingField = z.infer<typeof ProcessingFieldSchema>;

export const ConfidenceSchema = z
	.object({
		duration: z.number().finite().min(0).max(1),
		cognitive: z.number().finite().min(0).max(1),
		emotional: z.number().finite().min(0).max(1),
		physical: z.number().finite().min(0).max(1),
		scope: z.number().finite().min(0).max(1),
	})
	.strict();
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ProcessingQuestionSchema = z
	.object({
		id: z.string().min(1).max(200),
		text: z.string().trim().min(1).max(4000),
		affectedFields: z.array(ProcessingFieldSchema).min(1).max(5),
	})
	.strict();
export type ProcessingQuestion = z.infer<typeof ProcessingQuestionSchema>;

/**
 * Builds a closed result schema from the current catalog. Archived or absent
 * IDs are rejected before any task write can occur.
 */
export function createInboxProcessingResultSchema(activeScopeIds: ReadonlySet<string>) {
	const scopeId = z
		.string()
		.min(1)
		.max(200)
		.refine(
			(value) => activeScopeIds.has(value),
			"Scope ID is not active in the current catalog",
		);
	const task = z
		.object({
			taskId: z.string().min(1).max(200),
			durationMinutes: NullableDurationMinutesSchema,
			intensity: TaskIntensitySchema,
			scopeId,
			confidence: ConfidenceSchema,
			questions: z.array(ProcessingQuestionSchema).max(20),
		})
		.strict();
	return z.object({ tasks: z.array(task).max(100) }).strict();
}

export type InboxProcessingResult = z.infer<ReturnType<typeof createInboxProcessingResultSchema>>;
