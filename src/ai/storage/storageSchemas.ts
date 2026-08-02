import { type Infer, type Input, z } from "../../schema/zod";
import { isScopeId } from "../../core/scope/scope";
import { AgentMessageSchema } from "../core/messages";
import { isWaitingRunState, ProcessingRunStateSchema } from "../processing/ProcessingQueue";
import {
	ConfidenceSchema,
	NullableDurationMinutesSchema,
	ProcessingFieldSchema,
	TaskIntensitySchema,
} from "../processing/processingSchemas";
import { hasCredentialShapedKey } from "./AtomicFilePort";

export const RecordIdSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ScopeDefinitionSchema = z
	.object({
		id: z.string().refine(isScopeId, "Invalid scope ID"),
		name: z.string().trim().min(1).max(80),
		order: z.number().int().min(0),
		archived: z.boolean(),
	})
	.strict();

export const ScopeCatalogV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		scopes: z.array(ScopeDefinitionSchema).max(100),
	})
	.strict()
	.superRefine((catalog, context) => {
		const ids = new Set<string>();
		const names = new Set<string>();
		const orders = new Set<number>();
		for (const [index, scope] of catalog.scopes.entries()) {
			if (ids.has(scope.id)) {
				context.addIssue({
					code: "custom",
					path: ["scopes", index, "id"],
					message: "Scope IDs must be unique",
				});
			}
			ids.add(scope.id);
			const name = scope.name.toLowerCase();
			if (names.has(name)) {
				context.addIssue({
					code: "custom",
					path: ["scopes", index, "name"],
					message: "Scope names must be unique",
				});
			}
			names.add(name);
			if (orders.has(scope.order)) {
				context.addIssue({
					code: "custom",
					path: ["scopes", index, "order"],
					message: "Scope orders must be unique",
				});
			}
			orders.add(scope.order);
		}
	});
export type ScopeCatalogV1 = Infer<typeof ScopeCatalogV1Schema>;

export const ProcessingErrorRecordSchema = z
	.object({
		code: z.enum([
			"authentication",
			"cancelled",
			"configuration",
			"invalid-response",
			"network",
			"provider-unavailable",
			"rate-limited",
			"unknown",
		]),
		statusCode: z.number().int().positive().nullable(),
		retryable: z.boolean(),
		retryAfterMs: z.number().int().nonnegative().nullable(),
	})
	.strict();

export const ProcessingRequestContextV1Schema = z
	.object({
		/**
		 * Null means the ordinary full estimate set. Arrays preserve constrained
		 * question/reprocess runs across durable retry children.
		 */
		onlyFields: z.array(ProcessingFieldSchema).max(5).nullable(),
		unlockFields: z.array(ProcessingFieldSchema).max(5),
		/** Exact bounded text already sent in the synced processing session. */
		questionContext: z.string().max(2_000).nullable(),
	})
	.strict()
	.superRefine((request, context) => {
		for (const key of ["onlyFields", "unlockFields"] as const) {
			const fields = request[key];
			if (fields !== null && new Set(fields).size !== fields.length) {
				context.addIssue({
					code: "custom",
					path: [key],
					message: "Processing fields must be unique",
				});
			}
		}
	});
export type ProcessingRequestContextV1 = Infer<typeof ProcessingRequestContextV1Schema>;

export const ProcessingRunV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		id: RecordIdSchema,
		sessionId: RecordIdSchema,
		taskIds: z.array(RecordIdSchema).min(1).max(100),
		createdAt: IsoTimestampSchema,
		updatedAt: IsoTimestampSchema,
		state: ProcessingRunStateSchema,
		attempt: z.number().int().nonnegative(),
		nextEligibleAt: IsoTimestampSchema.nullable(),
		actualModel: z.string().min(1).max(300).nullable(),
		error: ProcessingErrorRecordSchema.nullable(),
		/** Set only on a durable child created by explicit recovery. */
		retryOfRunId: RecordIdSchema.nullable().optional().default(null),
		requestContext: ProcessingRequestContextV1Schema.optional().default({
			onlyFields: null,
			unlockFields: [],
			questionContext: null,
		}),
	})
	.strict()
	.superRefine((run, context) => {
		if (new Set(run.taskIds).size !== run.taskIds.length) {
			context.addIssue({
				code: "custom",
				path: ["taskIds"],
				message: "Run task IDs must be unique",
			});
		}
		if (run.retryOfRunId === run.id) {
			context.addIssue({
				code: "custom",
				path: ["retryOfRunId"],
				message: "A run cannot retry itself",
			});
		}
		if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) {
			context.addIssue({
				code: "custom",
				path: ["updatedAt"],
				message: "Run update cannot precede creation",
			});
		}
		if (isWaitingRunState(run.state) && run.nextEligibleAt === null) {
			context.addIssue({
				code: "custom",
				path: ["nextEligibleAt"],
				message: "Waiting runs require a next eligible time",
			});
		}
		if (!isWaitingRunState(run.state) && run.nextEligibleAt !== null) {
			context.addIssue({
				code: "custom",
				path: ["nextEligibleAt"],
				message: "Only waiting runs may have a next eligible time",
			});
		}
		if (
			(run.state === "values_applied" ||
				run.state === "awaiting_answers" ||
				run.state === "completed") &&
			run.actualModel === null
		) {
			context.addIssue({
				code: "custom",
				path: ["actualModel"],
				message: "Successful provider runs require the actual returned model",
			});
		}
		if (hasCredentialShapedKey(run)) {
			context.addIssue({
				code: "custom",
				message: "Synced run records cannot contain credential fields",
			});
		}
	});
/** Input remains backward-compatible with v1 records that predate retry lineage. */
export type ProcessingRunV1 = Input<typeof ProcessingRunV1Schema>;

/** Immutable, per-attempt recovery lease. Old/expired leases are retained for audit. */
export const RecoveryLeaseV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("recovery-lease"),
		id: RecordIdSchema,
		runId: RecordIdSchema,
		ownerId: RecordIdSchema,
		claimedAt: IsoTimestampSchema,
		expiresAt: IsoTimestampSchema,
	})
	.strict()
	.superRefine((lease, context) => {
		if (Date.parse(lease.expiresAt) <= Date.parse(lease.claimedAt)) {
			context.addIssue({
				code: "custom",
				path: ["expiresAt"],
				message: "Recovery lease expiry must follow its claim",
			});
		}
	});
export type RecoveryLeaseV1 = Infer<typeof RecoveryLeaseV1Schema>;

export const SessionHeaderV1Schema = z
	.object({
		kind: z.literal("session"),
		schemaVersion: z.literal(1),
		id: RecordIdSchema,
		sessionKind: z.enum(["chat", "inbox-processing"]),
		createdAt: IsoTimestampSchema,
		updatedAt: IsoTimestampSchema,
	})
	.strict()
	.superRefine((header, context) => {
		if (Date.parse(header.updatedAt) < Date.parse(header.createdAt)) {
			context.addIssue({
				code: "custom",
				path: ["updatedAt"],
				message: "Session update cannot precede creation",
			});
		}
	});
export type SessionHeaderV1 = Infer<typeof SessionHeaderV1Schema>;

export const SessionMessageV1Schema = z
	.object({
		kind: z.literal("message"),
		schemaVersion: z.literal(1),
		sessionId: RecordIdSchema,
		sequence: z.number().int().nonnegative(),
		/** Present on new sharded records; absent in legacy JSONL files. */
		recordedAt: IsoTimestampSchema.optional(),
		message: AgentMessageSchema,
	})
	.strict()
	.superRefine((record, context) => {
		if (!RecordIdSchema.safeParse(record.message.id).success) {
			context.addIssue({
				code: "custom",
				path: ["message", "id"],
				message: "Invalid immutable message ID",
			});
		}
		if (
			record.recordedAt !== undefined &&
			Date.parse(record.recordedAt) < Date.parse(record.message.createdAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["recordedAt"],
				message: "Message recording cannot precede creation",
			});
		}
		if (hasCredentialShapedKey(record.message.toolCalls)) {
			context.addIssue({
				code: "custom",
				path: ["message", "toolCalls"],
				message: "Synced messages cannot contain credential fields",
			});
		}
	});
export type SessionMessageV1 = Infer<typeof SessionMessageV1Schema>;

export const SessionRecordV1Schema = z.discriminatedUnion("kind", [
	SessionHeaderV1Schema,
	SessionMessageV1Schema,
]);
export type SessionRecordV1 = Infer<typeof SessionRecordV1Schema>;

export const FeedbackKindSchema = z.enum([
	"estimate-suggested",
	"estimate-corrected",
	"estimate-manual",
	"field-unlocked",
	"question-asked",
	"question-answered",
	"scope-changed",
]);

export const FeedbackPredictionSchema = z
	.object({
		durationMinutes: NullableDurationMinutesSchema,
		intensity: TaskIntensitySchema,
		scopeId: z.string().min(1).max(64),
		confidence: ConfidenceSchema,
		actualModel: z.string().min(1).max(300),
		promptVersion: z.string().min(1).max(100),
		schemaVersion: z.string().min(1).max(100),
		retrievedExampleIds: z.array(RecordIdSchema).max(50),
	})
	.strict();

export const FeedbackEventV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		id: RecordIdSchema,
		kind: FeedbackKindSchema,
		taskId: RecordIdSchema,
		occurredAt: IsoTimestampSchema,
		runId: RecordIdSchema.nullable(),
		sessionId: RecordIdSchema.nullable(),
		field: ProcessingFieldSchema.nullable(),
		prediction: FeedbackPredictionSchema.nullable(),
	})
	.strict();
export type FeedbackEventV1 = Infer<typeof FeedbackEventV1Schema>;
