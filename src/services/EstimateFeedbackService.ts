import {
	ESTIMATE_FIELDS,
	emptyTaskProvenance,
	lockUserEditedFields,
	parseTaskEstimateProvenance,
	unlockFields,
	type EstimateField,
	type EstimateValues,
	type TaskEstimateProvenance,
} from "../core/estimates/provenance";
import { isDurationMinutes, type Task, type TaskIntensity } from "../core/model/Task";
import { isScopeId } from "../core/scope/scope";
import { hasCredentialShapedKey } from "../ai/storage/AtomicFilePort";

export const FEEDBACK_FOLDER = ".gtd-flow/ai/feedback";
export const FEEDBACK_OUTBOX_FOLDER = ".gtd-flow/ai/feedback-outbox";

const MAX_SNAPSHOT_TEXT_LENGTH = 2_000;
const MAX_SNAPSHOT_TAGS = 20;
const MAX_SNAPSHOT_TAG_LENGTH = 128;
const MAX_SNAPSHOT_CONTEXT_LENGTH = 500;
const MAX_EVENT_TEXT_LENGTH = 2_000;
const FEEDBACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

interface FeedbackBase {
	schemaVersion: 1;
	id: string;
	taskId: string;
	createdAt: string;
	runId: string | null;
	sessionId: string | null;
}

/** Bounded task context retained only for deterministic local retrieval. */
export interface EstimateTaskSnapshot {
	text: string;
	tags: string[];
	container: string;
	heading: string | null;
	recurrence: string | null;
}

export interface EstimateSuggestedEvent extends FeedbackBase {
	kind: "estimate-suggested";
	taskSnapshot: EstimateTaskSnapshot;
	values: EstimateValues;
	confidence: Record<EstimateField, number>;
	appliedFields: EstimateField[];
	actualModel: string;
	provider: "openrouter";
	promptVersion: string;
	schemaVersionId: string;
	retrievedExampleIds: string[];
}

/**
 * A chat tool may change only one metadata field, even while the remaining task
 * metadata is still unknown. Keeping that suggestion field-local avoids
 * inventing placeholder estimates solely to satisfy the batch prediction shape.
 */
export interface EstimateFieldSuggestedEvent extends FeedbackBase {
	kind: "estimate-field-suggested";
	field: EstimateField;
	value: number | string | null;
	taskSnapshot: EstimateTaskSnapshot;
	confidence: number;
	actualModel: string;
	provider: "openrouter";
	promptVersion: string;
	schemaVersionId: string;
	retrievedExampleIds: string[];
}

export interface EstimateCorrectedEvent extends FeedbackBase {
	kind: "estimate-corrected" | "estimate-manual" | "scope-changed";
	field: EstimateField;
	previousValue: number | string | null;
	value: number | string | null;
	/** Present on new manual/edit events so they can train without an AI suggestion. */
	taskSnapshot?: EstimateTaskSnapshot;
}

export interface FieldUnlockedEvent extends FeedbackBase {
	kind: "field-unlocked";
	fields: EstimateField[];
}

/** Carries no label or task content; it preserves a user lock after history clear. */
export interface FieldLockedEvent extends FeedbackBase {
	kind: "field-locked";
	fields: EstimateField[];
}

export interface QuestionEvent extends FeedbackBase {
	kind: "question-asked" | "question-answered";
	questionId: string;
	affectedFields: EstimateField[];
	/** Present only for user-visible synced history, never emitted to console logs. */
	text: string;
}

export type EstimateFeedbackEvent =
	| EstimateSuggestedEvent
	| EstimateFieldSuggestedEvent
	| EstimateCorrectedEvent
	| FieldUnlockedEvent
	| FieldLockedEvent
	| QuestionEvent;

export type EstimateMutationEvent =
	EstimateSuggestedEvent | EstimateFieldSuggestedEvent | EstimateCorrectedEvent;
export type EstimateFieldValue = number | string | null;

export interface FeedbackFieldMutation {
	field: EstimateField;
	previousValue: EstimateFieldValue;
	intendedValue: EstimateFieldValue;
}

export type FeedbackOutboxConflictReason =
	"ambiguous-task-state" | "canonical-event-conflict" | "task-missing";

export interface FeedbackOutboxRecord {
	schemaVersion: 1;
	id: string;
	state: "prepared" | "conflict";
	preparedAt: string;
	updatedAt: string;
	conflictReason: FeedbackOutboxConflictReason | null;
	event: EstimateMutationEvent;
	mutations: FeedbackFieldMutation[];
}

export interface FeedbackRecoveryConflict {
	id: string;
	taskId: string;
	fields: EstimateField[];
	reason: FeedbackOutboxConflictReason;
}

export interface FeedbackRecoveryResult {
	committed: number;
	cancelled: number;
	conflicts: FeedbackRecoveryConflict[];
	invalidPaths: string[];
}

export interface FeedbackStorage {
	list(path: string): Promise<string[]>;
	read(path: string): Promise<string | null>;
	/** Atomically replaces a mutable journal/outbox record. */
	writeAtomic(path: string, content: string): Promise<void>;
	/** Must reject rather than overwrite an existing immutable event. */
	writeNew(path: string, content: string): Promise<void>;
	delete(path: string): Promise<void>;
}

export interface FeedbackReadResult {
	events: EstimateFeedbackEvent[];
	invalidPaths: string[];
}

/** Parsed outbox records are safe to show in a user-requested diagnostic export. */
export interface FeedbackOutboxReadResult {
	records: FeedbackOutboxRecord[];
	invalidPaths: string[];
}

export interface FeedbackOutboxHealth {
	pending: number;
	conflicts: number;
	invalidRecords: number;
}

/**
 * Immutable event storage makes feedback sync-friendly: each correction has a
 * separate file, so two devices never append to the same shared log.
 */
export class EstimateFeedbackService {
	constructor(
		private readonly storage: FeedbackStorage,
		private readonly now: () => Date = () => new Date(),
	) {}

	async append(event: EstimateFeedbackEvent): Promise<string> {
		const parsed = parseFeedbackEvent(event);
		if (parsed === null) throw new Error("invalid-feedback-event");
		const path = feedbackPath(parsed.id);
		await this.storage.writeNew(path, `${JSON.stringify(parsed, null, 2)}\n`);
		return path;
	}

	/**
	 * Durably records the intended feedback before its Markdown mutation.
	 * Prepared records are mutable only to preserve an explicit conflict state;
	 * the canonical feedback event remains immutable.
	 */
	async prepareMutation(
		event: EstimateMutationEvent,
		mutations: readonly FeedbackFieldMutation[],
	): Promise<string> {
		const record = parseFeedbackOutboxRecord({
			schemaVersion: 1,
			id: event.id,
			state: "prepared",
			preparedAt: event.createdAt,
			updatedAt: event.createdAt,
			conflictReason: null,
			event,
			mutations,
		});
		if (record === null) throw new Error("invalid-feedback-outbox-record");
		const path = feedbackOutboxPath(record.id);
		if ((await this.storage.read(path)) !== null) {
			throw new Error("feedback-outbox-conflict");
		}
		try {
			await this.storage.writeNew(path, serializeRecord(record));
		} catch (error: unknown) {
			if ((await this.storage.read(path)) !== null) {
				throw new Error("feedback-outbox-conflict");
			}
			throw error;
		}
		return path;
	}

	/**
	 * Publishes the prepared event to immutable history and removes the outbox
	 * record. Repeating this after a crash is safe when the canonical event is
	 * byte-equivalent.
	 */
	async commitPrepared(id: string): Promise<string> {
		const path = feedbackOutboxPath(id);
		const rawRecord = await this.storage.read(path);
		if (rawRecord === null) {
			const existing = await this.storage.read(feedbackPath(id));
			if (existing !== null) {
				try {
					const parsed = parseFeedbackEvent(JSON.parse(existing));
					if (parsed?.id === id) return feedbackPath(id);
				} catch {
					// Fall through to the explicit conflict below.
				}
				throw new Error("feedback-event-conflict");
			}
			throw new Error("feedback-outbox-not-found");
		}
		let record: FeedbackOutboxRecord | null;
		try {
			record = parseFeedbackOutboxRecord(JSON.parse(rawRecord));
		} catch {
			record = null;
		}
		if (record === null) throw new Error("invalid-feedback-outbox-record");
		if (record.state === "conflict") throw new Error("feedback-outbox-conflict");
		try {
			await this.appendIdempotent(record.event);
		} catch (error: unknown) {
			if (error instanceof FeedbackCanonicalConflictError) {
				await this.markConflict(record, "canonical-event-conflict");
			}
			throw error;
		}
		await this.storage.delete(path);
		return feedbackPath(id);
	}

	/** Cancels a prepared mutation that is known not to have changed Markdown. */
	async cancelPrepared(id: string): Promise<void> {
		await this.storage.delete(feedbackOutboxPath(id));
	}

	/** Convenience for post-write observations such as raw Markdown edits. */
	async recordMutation(
		event: EstimateMutationEvent,
		mutations: readonly FeedbackFieldMutation[],
	): Promise<string> {
		await this.prepareMutation(event, mutations);
		return this.commitPrepared(event.id);
	}

	/**
	 * Recovers interrupted prepare → Markdown → canonical-event operations.
	 * A conflict is retained in the outbox and must never be guessed through.
	 */
	async recoverPending(
		findTask: (taskId: string) => Task | null | Promise<Task | null>,
	): Promise<FeedbackRecoveryResult> {
		const result: FeedbackRecoveryResult = {
			committed: 0,
			cancelled: 0,
			conflicts: [],
			invalidPaths: [],
		};
		const outbox = await this.readOutbox();
		for (const record of outbox.records) {
			if (record.state === "conflict") {
				result.conflicts.push(asRecoveryConflict(record));
				continue;
			}

			const canonical = await this.canonicalStatus(record.event);
			if (canonical === "matching") {
				await this.storage.delete(feedbackOutboxPath(record.id));
				result.committed++;
				continue;
			}
			if (canonical === "conflict") {
				const conflict = await this.markConflict(record, "canonical-event-conflict");
				result.conflicts.push(asRecoveryConflict(conflict));
				continue;
			}

			const task = await findTask(record.event.taskId);
			if (task === null) {
				const conflict = await this.markConflict(record, "task-missing");
				result.conflicts.push(asRecoveryConflict(conflict));
				continue;
			}
			if (task.taskId !== record.event.taskId) {
				const conflict = await this.markConflict(record, "ambiguous-task-state");
				result.conflicts.push(asRecoveryConflict(conflict));
				continue;
			}
			switch (classifyTaskState(task, record.mutations)) {
				case "intended":
					await this.commitPrepared(record.id);
					result.committed++;
					break;
				case "previous":
					await this.cancelPrepared(record.id);
					result.cancelled++;
					break;
				case "ambiguous": {
					const conflict = await this.markConflict(record, "ambiguous-task-state");
					result.conflicts.push(asRecoveryConflict(conflict));
					break;
				}
			}
		}
		result.invalidPaths.push(...outbox.invalidPaths);
		return result;
	}

	async readAll(): Promise<FeedbackReadResult> {
		const paths = (await this.storage.list(FEEDBACK_FOLDER))
			.filter((path) => path.endsWith(".json"))
			.sort();
		const events: EstimateFeedbackEvent[] = [];
		const invalidPaths: string[] = [];
		for (const path of paths) {
			const raw = await this.storage.read(path);
			if (raw === null) {
				invalidPaths.push(path);
				continue;
			}
			try {
				const event = parseFeedbackEvent(JSON.parse(raw));
				if (event === null || path !== feedbackPath(event.id)) invalidPaths.push(path);
				else events.push(event);
			} catch {
				invalidPaths.push(path);
			}
		}
		events.sort(
			(left, right) =>
				Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
		return { events, invalidPaths };
	}

	async eventsForTask(taskId: string): Promise<EstimateFeedbackEvent[]> {
		const { events } = await this.readAll();
		return events.filter((event) => event.taskId === taskId);
	}

	async provenanceForTask(taskId: string, now: string): Promise<TaskEstimateProvenance> {
		let provenance = emptyTaskProvenance(taskId, now);
		const [events, outbox] = await Promise.all([this.eventsForTask(taskId), this.readOutbox()]);
		for (const event of events) {
			switch (event.kind) {
				case "estimate-suggested":
					for (const field of event.appliedFields) {
						const state = provenance.fields[field];
						if (state.owner === "ai" && !state.locked) {
							provenance.fields[field] = {
								owner: "ai",
								locked: false,
								lastPredictionEventId: event.id,
								updatedAt: event.createdAt,
							};
						}
					}
					break;
				case "estimate-field-suggested": {
					const state = provenance.fields[event.field];
					if (state.owner === "ai" && !state.locked) {
						provenance.fields[event.field] = {
							owner: "ai",
							locked: false,
							lastPredictionEventId: event.id,
							updatedAt: event.createdAt,
						};
					}
					break;
				}
				case "estimate-corrected":
				case "estimate-manual":
				case "scope-changed":
					provenance = lockUserEditedFields({
						provenance,
						taskId,
						fields: [event.field],
						now: event.createdAt,
					});
					break;
				case "field-locked":
					provenance = lockUserEditedFields({
						provenance,
						taskId,
						fields: event.fields,
						now: event.createdAt,
					});
					break;
				case "field-unlocked":
					provenance = unlockFields({
						provenance,
						fields: event.fields,
						now: event.createdAt,
					});
					break;
				case "question-asked":
				case "question-answered":
					break;
				default: {
					const exhaustive: never = event;
					return exhaustive;
				}
			}
		}
		// A retained conflict has no trustworthy label, but it is durable evidence
		// that this field was touched outside a completed AI write. Keep it user
		// owned until the record is explicitly resolved or cleared.
		for (const record of outbox.records) {
			if (record.state !== "conflict" || record.event.taskId !== taskId) continue;
			provenance = lockUserEditedFields({
				provenance,
				taskId,
				fields: record.mutations.map((mutation) => mutation.field),
				now: record.updatedAt,
			});
		}
		return provenance;
	}

	async outboxHealth(): Promise<FeedbackOutboxHealth> {
		const outbox = await this.readOutbox();
		return {
			pending: outbox.records.filter((record) => record.state === "prepared").length,
			conflicts: outbox.records.filter((record) => record.state === "conflict").length,
			invalidRecords: outbox.invalidPaths.length,
		};
	}

	async exportJson(): Promise<string> {
		const [result, outbox] = await Promise.all([this.readAll(), this.readOutbox()]);
		return `${JSON.stringify(
			{
				schemaVersion: 2,
				events: result.events,
				invalidPaths: result.invalidPaths,
				outbox: {
					prepared: outbox.records.filter((record) => record.state === "prepared"),
					conflicts: outbox.records.filter((record) => record.state === "conflict"),
					invalidPaths: outbox.invalidPaths,
				},
			},
			null,
			2,
		)}\n`;
	}

	/**
	 * Caller owns the destructive confirmation. This removes every label-bearing
	 * event and every recoverable outbox record, without touching Markdown task
	 * values. User locks and unresolved conflict locks are retained as label-free
	 * markers so clearing training history cannot make either field writable by AI.
	 */
	async clearConfirmed(): Promise<number> {
		const [{ events }, outbox] = await Promise.all([this.readAll(), this.readOutbox()]);
		const retainedLocks = retainedUserLocks(events);
		for (const record of outbox.records) {
			if (record.state !== "conflict") continue;
			const fields = retainedLocks.get(record.event.taskId) ?? new Set<EstimateField>();
			for (const mutation of record.mutations) fields.add(mutation.field);
			retainedLocks.set(record.event.taskId, fields);
		}
		const retainedPaths = new Set<string>();
		const now = this.now().toISOString();
		for (const [taskId, fields] of retainedLocks) {
			const event: FieldLockedEvent = {
				schemaVersion: 1,
				id: `clear-lock-${crypto.randomUUID()}`,
				kind: "field-locked",
				taskId,
				createdAt: now,
				runId: null,
				sessionId: null,
				fields: [...fields],
			};
			const path = await this.append(event);
			retainedPaths.add(path);
		}

		const outboxPaths = (await this.storage.list(FEEDBACK_OUTBOX_FOLDER)).filter((path) =>
			path.endsWith(".json"),
		);
		// Delete recovery material first: a crash during cleanup can leave labels,
		// but it cannot later republish a label the user asked to clear.
		for (const path of outboxPaths) await this.storage.delete(path);
		const paths = (await this.storage.list(FEEDBACK_FOLDER)).filter(
			(path) => path.endsWith(".json") && !retainedPaths.has(path),
		);
		for (const path of paths) await this.storage.delete(path);
		return paths.length;
	}

	private async appendIdempotent(event: EstimateMutationEvent): Promise<void> {
		const path = feedbackPath(event.id);
		const expected = serializeRecord(event);
		const existing = await this.storage.read(path);
		if (existing !== null) {
			if (recordsEqual(existing, event)) return;
			throw new FeedbackCanonicalConflictError();
		}
		try {
			await this.storage.writeNew(path, expected);
		} catch (error: unknown) {
			const raced = await this.storage.read(path);
			if (raced !== null && recordsEqual(raced, event)) return;
			if (raced !== null) throw new FeedbackCanonicalConflictError();
			throw error;
		}
	}

	private async canonicalStatus(
		event: EstimateMutationEvent,
	): Promise<"missing" | "matching" | "conflict"> {
		const existing = await this.storage.read(feedbackPath(event.id));
		if (existing === null) return "missing";
		return recordsEqual(existing, event) ? "matching" : "conflict";
	}

	async readOutbox(): Promise<FeedbackOutboxReadResult> {
		const paths = (await this.storage.list(FEEDBACK_OUTBOX_FOLDER))
			.filter(
				(path) => path.startsWith(`${FEEDBACK_OUTBOX_FOLDER}/`) && path.endsWith(".json"),
			)
			.sort();
		const records: FeedbackOutboxRecord[] = [];
		const invalidPaths: string[] = [];
		for (const path of paths) {
			const record = await this.readOutboxRecord(path);
			if (record === null || path !== feedbackOutboxPath(record.id)) invalidPaths.push(path);
			else records.push(record);
		}
		return { records, invalidPaths };
	}

	private async readOutboxRecord(path: string): Promise<FeedbackOutboxRecord | null> {
		const raw = await this.storage.read(path);
		if (raw === null) return null;
		try {
			return parseFeedbackOutboxRecord(JSON.parse(raw));
		} catch {
			return null;
		}
	}

	private async markConflict(
		record: FeedbackOutboxRecord,
		reason: FeedbackOutboxConflictReason,
	): Promise<FeedbackOutboxRecord> {
		const conflict = parseFeedbackOutboxRecord({
			...record,
			state: "conflict",
			updatedAt: this.now().toISOString(),
			conflictReason: reason,
		});
		if (conflict === null) throw new Error("invalid-feedback-outbox-conflict");
		await this.storage.writeAtomic(feedbackOutboxPath(conflict.id), serializeRecord(conflict));
		return conflict;
	}
}

class FeedbackCanonicalConflictError extends Error {
	constructor() {
		super("feedback-event-conflict");
		this.name = "FeedbackCanonicalConflictError";
	}
}

function feedbackPath(id: string): string {
	validateFeedbackId(id);
	return `${FEEDBACK_FOLDER}/${id}.json`;
}

function feedbackOutboxPath(id: string): string {
	validateFeedbackId(id);
	return `${FEEDBACK_OUTBOX_FOLDER}/${id}.json`;
}

function validateFeedbackId(id: string): void {
	if (!FEEDBACK_ID_RE.test(id)) {
		throw new Error("invalid-feedback-id");
	}
}

function serializeRecord(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function recordsEqual(raw: string, expected: EstimateFeedbackEvent): boolean {
	try {
		const parsed = parseFeedbackEvent(JSON.parse(raw));
		return parsed !== null && JSON.stringify(parsed) === JSON.stringify(expected);
	} catch {
		return false;
	}
}

function parseFeedbackOutboxRecord(value: unknown): FeedbackOutboxRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const item = value as Record<string, unknown>;
	if (
		hasCredentialShapedKey(item) ||
		!hasOnlyKeys(item, [
			"schemaVersion",
			"id",
			"state",
			"preparedAt",
			"updatedAt",
			"conflictReason",
			"event",
			"mutations",
		])
	) {
		return null;
	}
	const event = parseFeedbackEvent(item["event"]);
	if (
		item["schemaVersion"] !== 1 ||
		!isRecordId(item["id"]) ||
		(item["state"] !== "prepared" && item["state"] !== "conflict") ||
		!isIsoTimestamp(item["preparedAt"]) ||
		!isIsoTimestamp(item["updatedAt"]) ||
		Date.parse(item["updatedAt"]) < Date.parse(item["preparedAt"]) ||
		event === null ||
		!isMutationEvent(event) ||
		item["id"] !== event.id ||
		item["preparedAt"] !== event.createdAt ||
		!Array.isArray(item["mutations"])
	) {
		return null;
	}
	try {
		feedbackOutboxPath(item["id"]);
	} catch {
		return null;
	}
	const conflictReason = item["conflictReason"];
	if (
		(item["state"] === "prepared" && conflictReason !== null) ||
		(item["state"] === "conflict" && !isConflictReason(conflictReason))
	) {
		return null;
	}

	const mutations: FeedbackFieldMutation[] = [];
	const seen = new Set<EstimateField>();
	for (const raw of item["mutations"]) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
		const mutation = raw as Record<string, unknown>;
		if (
			!hasOnlyKeys(mutation, ["field", "previousValue", "intendedValue"]) ||
			!isEstimateField(mutation["field"]) ||
			!isFieldValue(mutation["field"], mutation["previousValue"]) ||
			!isFieldValue(mutation["field"], mutation["intendedValue"]) ||
			seen.has(mutation["field"])
		) {
			return null;
		}
		seen.add(mutation["field"]);
		mutations.push({
			field: mutation["field"],
			previousValue: mutation["previousValue"],
			intendedValue: mutation["intendedValue"],
		});
	}
	const eventFields = event.kind === "estimate-suggested" ? event.appliedFields : [event.field];
	if (
		mutations.length === 0 ||
		mutations.length !== eventFields.length ||
		eventFields.some((field) => !seen.has(field))
	) {
		return null;
	}
	for (const mutation of mutations) {
		if (mutation.intendedValue !== mutationEventValue(event, mutation.field)) {
			return null;
		}
		if (
			event.kind !== "estimate-suggested" &&
			event.kind !== "estimate-field-suggested" &&
			mutation.previousValue !== event.previousValue
		) {
			return null;
		}
	}
	return {
		schemaVersion: 1,
		id: item["id"],
		state: item["state"],
		preparedAt: item["preparedAt"],
		updatedAt: item["updatedAt"],
		conflictReason:
			item["state"] === "conflict" ? (conflictReason as FeedbackOutboxConflictReason) : null,
		event,
		mutations,
	};
}

function isMutationEvent(event: EstimateFeedbackEvent): event is EstimateMutationEvent {
	return (
		event.kind === "estimate-suggested" ||
		event.kind === "estimate-field-suggested" ||
		event.kind === "estimate-corrected" ||
		event.kind === "estimate-manual" ||
		event.kind === "scope-changed"
	);
}

function isConflictReason(value: unknown): value is FeedbackOutboxConflictReason {
	return (
		value === "ambiguous-task-state" ||
		value === "canonical-event-conflict" ||
		value === "task-missing"
	);
}

function mutationEventValue(
	event: EstimateMutationEvent,
	field: EstimateField,
): EstimateFieldValue {
	if (event.kind !== "estimate-suggested") return event.value;
	switch (field) {
		case "duration":
			return event.values.durationMinutes;
		case "cognitive":
			return event.values.cognitiveIntensity;
		case "emotional":
			return event.values.emotionalIntensity;
		case "physical":
			return event.values.physicalIntensity;
		case "scope":
			return event.values.scopeId;
	}
}

function classifyTaskState(
	task: Task,
	mutations: readonly FeedbackFieldMutation[],
): "intended" | "previous" | "ambiguous" {
	const meaningful = mutations.filter(
		(mutation) => mutation.previousValue !== mutation.intendedValue,
	);
	if (meaningful.length === 0) return "ambiguous";
	const intended = meaningful.every(
		(mutation) => taskFieldValue(task, mutation.field) === mutation.intendedValue,
	);
	const previous = meaningful.every(
		(mutation) => taskFieldValue(task, mutation.field) === mutation.previousValue,
	);
	if (intended && !previous) return "intended";
	if (previous && !intended) return "previous";
	return "ambiguous";
}

function taskFieldValue(task: Task, field: EstimateField): EstimateFieldValue {
	switch (field) {
		case "duration":
			return task.durationMinutes;
		case "cognitive":
			return task.cognitiveIntensity;
		case "emotional":
			return task.emotionalIntensity;
		case "physical":
			return task.physicalIntensity;
		case "scope":
			return task.scopeId;
	}
}

function asRecoveryConflict(record: FeedbackOutboxRecord): FeedbackRecoveryConflict {
	if (record.conflictReason === null) throw new Error("feedback-conflict-reason-required");
	return {
		id: record.id,
		taskId: record.event.taskId,
		fields: record.mutations.map((mutation) => mutation.field),
		reason: record.conflictReason,
	};
}

export function parseFeedbackEvent(value: unknown): EstimateFeedbackEvent | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const item = value as Record<string, unknown>;
	if (hasCredentialShapedKey(item)) return null;
	if (
		item["schemaVersion"] !== 1 ||
		!isRecordId(item["id"]) ||
		!isRecordId(item["taskId"]) ||
		!isIsoTimestamp(item["createdAt"]) ||
		(item["runId"] !== null && !isRecordId(item["runId"])) ||
		(item["sessionId"] !== null && !isRecordId(item["sessionId"]))
	) {
		return null;
	}
	const base = {
		schemaVersion: 1 as const,
		id: item["id"],
		taskId: item["taskId"],
		createdAt: item["createdAt"],
		runId: item["runId"],
		sessionId: item["sessionId"],
	};
	try {
		feedbackPath(base.id);
	} catch {
		return null;
	}

	switch (item["kind"]) {
		case "estimate-suggested":
			return parseSuggested(base, item);
		case "estimate-field-suggested":
			return parseFieldSuggested(base, item);
		case "estimate-corrected":
		case "estimate-manual":
		case "scope-changed": {
			if (
				!isEstimateField(item["field"]) ||
				!isFieldValue(item["field"], item["previousValue"]) ||
				!isFieldValue(item["field"], item["value"]) ||
				(item["kind"] === "scope-changed" && item["field"] !== "scope") ||
				(item["taskSnapshot"] !== undefined && !isTaskSnapshot(item["taskSnapshot"]))
			) {
				return null;
			}
			return {
				...base,
				kind: item["kind"],
				field: item["field"],
				previousValue: item["previousValue"],
				value: item["value"],
				...(item["taskSnapshot"] === undefined
					? {}
					: { taskSnapshot: item["taskSnapshot"] as EstimateTaskSnapshot }),
			};
		}
		case "field-unlocked": {
			const fields = parseFieldArray(item["fields"], true);
			return fields === null ? null : { ...base, kind: "field-unlocked", fields };
		}
		case "field-locked": {
			const fields = parseFieldArray(item["fields"], true);
			return fields === null ? null : { ...base, kind: "field-locked", fields };
		}
		case "question-asked":
		case "question-answered": {
			const affectedFields = parseFieldArray(item["affectedFields"], true);
			if (
				affectedFields === null ||
				!isRecordId(item["questionId"]) ||
				typeof item["text"] !== "string" ||
				item["text"].length === 0 ||
				item["text"].length > MAX_EVENT_TEXT_LENGTH
			) {
				return null;
			}
			return {
				...base,
				kind: item["kind"],
				questionId: item["questionId"],
				affectedFields,
				text: item["text"],
			};
		}
		default:
			return null;
	}
}

function parseSuggested(
	base: FeedbackBase,
	item: Record<string, unknown>,
): EstimateSuggestedEvent | null {
	const appliedFields = parseFieldArray(item["appliedFields"]);
	const retrievedExampleIds = parseIdArray(item["retrievedExampleIds"], 50);
	if (
		appliedFields === null ||
		retrievedExampleIds === null ||
		item["provider"] !== "openrouter" ||
		!isBoundedNonEmptyString(item["actualModel"], 300) ||
		!isBoundedNonEmptyString(item["promptVersion"], 100) ||
		!isBoundedNonEmptyString(item["schemaVersionId"], 100) ||
		!isEstimateValues(item["values"]) ||
		!isConfidence(item["confidence"]) ||
		!isTaskSnapshot(item["taskSnapshot"])
	) {
		return null;
	}
	return {
		...base,
		kind: "estimate-suggested",
		taskSnapshot: item["taskSnapshot"],
		values: item["values"],
		confidence: item["confidence"],
		appliedFields,
		actualModel: item["actualModel"],
		provider: "openrouter",
		promptVersion: item["promptVersion"],
		schemaVersionId: item["schemaVersionId"],
		retrievedExampleIds,
	};
}

function parseFieldSuggested(
	base: FeedbackBase,
	item: Record<string, unknown>,
): EstimateFieldSuggestedEvent | null {
	const retrievedExampleIds = parseIdArray(item["retrievedExampleIds"], 50);
	if (
		!isEstimateField(item["field"]) ||
		!isFieldValue(item["field"], item["value"]) ||
		typeof item["confidence"] !== "number" ||
		!Number.isFinite(item["confidence"]) ||
		item["confidence"] < 0 ||
		item["confidence"] > 1 ||
		item["provider"] !== "openrouter" ||
		!isBoundedNonEmptyString(item["actualModel"], 300) ||
		!isBoundedNonEmptyString(item["promptVersion"], 100) ||
		!isBoundedNonEmptyString(item["schemaVersionId"], 100) ||
		retrievedExampleIds === null ||
		!isTaskSnapshot(item["taskSnapshot"])
	) {
		return null;
	}
	return {
		...base,
		kind: "estimate-field-suggested",
		field: item["field"],
		value: item["value"],
		taskSnapshot: item["taskSnapshot"],
		confidence: item["confidence"],
		actualModel: item["actualModel"],
		provider: "openrouter",
		promptVersion: item["promptVersion"],
		schemaVersionId: item["schemaVersionId"],
		retrievedExampleIds,
	};
}

function isEstimateField(value: unknown): value is EstimateField {
	return typeof value === "string" && (ESTIMATE_FIELDS as readonly string[]).includes(value);
}

function parseFieldArray(value: unknown, requireNonEmpty = false): EstimateField[] | null {
	if (!Array.isArray(value) || !value.every(isEstimateField)) return null;
	const fields = [...new Set(value)];
	return requireNonEmpty && fields.length === 0 ? null : fields;
}

function parseIdArray(value: unknown, maximum: number): string[] | null {
	if (!Array.isArray(value) || value.length > maximum || !value.every(isRecordId)) {
		return null;
	}
	return [...value];
}

function isFieldValue(field: EstimateField, value: unknown): value is number | string | null {
	if (value === null) return true;
	switch (field) {
		case "duration":
			return isDurationMinutes(value);
		case "cognitive":
		case "emotional":
		case "physical":
			return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5;
		case "scope":
			return isScopeId(value);
	}
}

function isEstimateValues(value: unknown): value is EstimateValues {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (
		!hasOnlyKeys(item, [
			"durationMinutes",
			"cognitiveIntensity",
			"emotionalIntensity",
			"physicalIntensity",
			"scopeId",
		])
	) {
		return false;
	}
	const intensity: TaskIntensity = {
		cognitive: item["cognitiveIntensity"] as TaskIntensity["cognitive"],
		emotional: item["emotionalIntensity"] as TaskIntensity["emotional"],
		physical: item["physicalIntensity"] as TaskIntensity["physical"],
	};
	return (
		(item["durationMinutes"] === null || isDurationMinutes(item["durationMinutes"])) &&
		Number.isInteger(intensity.cognitive) &&
		intensity.cognitive >= 0 &&
		intensity.cognitive <= 5 &&
		Number.isInteger(intensity.emotional) &&
		intensity.emotional >= 0 &&
		intensity.emotional <= 5 &&
		Number.isInteger(intensity.physical) &&
		intensity.physical >= 0 &&
		intensity.physical <= 5 &&
		isScopeId(item["scopeId"])
	);
}

function isConfidence(value: unknown): value is Record<EstimateField, number> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (!hasOnlyKeys(item, ESTIMATE_FIELDS)) return false;
	return ESTIMATE_FIELDS.every(
		(field) =>
			typeof item[field] === "number" &&
			Number.isFinite(item[field]) &&
			item[field] >= 0 &&
			item[field] <= 1,
	);
}

function isTaskSnapshot(value: unknown): value is EstimateTaskSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	return (
		hasOnlyKeys(item, ["text", "tags", "container", "heading", "recurrence"]) &&
		typeof item["text"] === "string" &&
		item["text"].length <= MAX_SNAPSHOT_TEXT_LENGTH &&
		isBoundedStringArray(item["tags"], MAX_SNAPSHOT_TAGS, MAX_SNAPSHOT_TAG_LENGTH) &&
		typeof item["container"] === "string" &&
		item["container"].length <= MAX_SNAPSHOT_CONTEXT_LENGTH &&
		(item["heading"] === null ||
			(typeof item["heading"] === "string" &&
				item["heading"].length <= MAX_SNAPSHOT_CONTEXT_LENGTH)) &&
		(item["recurrence"] === null ||
			(typeof item["recurrence"] === "string" &&
				item["recurrence"].length <= MAX_SNAPSHOT_CONTEXT_LENGTH))
	);
}

function isRecordId(value: unknown): value is string {
	return typeof value === "string" && FEEDBACK_ID_RE.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function hasOnlyKeys(
	value: Readonly<Record<string, unknown>>,
	allowed: readonly string[],
): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isBoundedStringArray(value: unknown, maxItems: number, maxLength: number): boolean {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every((item) => typeof item === "string" && item.length <= maxLength)
	);
}

export function feedbackTaskSnapshot(
	task: Pick<Task, "description" | "tags" | "container" | "heading" | "recurrence">,
): EstimateTaskSnapshot {
	const description = typeof task.description === "string" ? task.description : "";
	const tags = Array.isArray(task.tags) ? task.tags : [];
	const container = typeof task.container === "string" ? task.container : "";
	const heading = typeof task.heading === "string" ? task.heading : null;
	const recurrence = typeof task.recurrence === "string" ? task.recurrence : null;
	return {
		text: description.slice(0, MAX_SNAPSHOT_TEXT_LENGTH),
		tags: tags.slice(0, MAX_SNAPSHOT_TAGS).map((tag) => tag.slice(0, MAX_SNAPSHOT_TAG_LENGTH)),
		container: container.slice(0, MAX_SNAPSHOT_CONTEXT_LENGTH),
		heading: heading?.slice(0, MAX_SNAPSHOT_CONTEXT_LENGTH) ?? null,
		recurrence: recurrence?.slice(0, MAX_SNAPSHOT_CONTEXT_LENGTH) ?? null,
	};
}

function retainedUserLocks(
	events: readonly EstimateFeedbackEvent[],
): Map<string, Set<EstimateField>> {
	const locks = new Map<string, Set<EstimateField>>();
	for (const event of events) {
		if (
			event.kind === "estimate-corrected" ||
			event.kind === "estimate-manual" ||
			event.kind === "scope-changed" ||
			event.kind === "field-locked"
		) {
			const fields = event.kind === "field-locked" ? event.fields : [event.field];
			const taskLocks = locks.get(event.taskId) ?? new Set<EstimateField>();
			for (const field of fields) taskLocks.add(field);
			locks.set(event.taskId, taskLocks);
			continue;
		}
		if (event.kind === "field-unlocked") {
			const taskLocks = locks.get(event.taskId);
			if (taskLocks === undefined) continue;
			for (const field of event.fields) taskLocks.delete(field);
			if (taskLocks.size === 0) locks.delete(event.taskId);
		}
	}
	return locks;
}

/** Kept exported for migration tooling that validates reconstructed snapshots. */
export function isStoredTaskProvenance(value: unknown): value is TaskEstimateProvenance {
	return parseTaskEstimateProvenance(value) !== null;
}
