import type { LongDurationStyle } from "../core/estimates/format";
import { secureUuid } from "../core/id/secureUuid";
import {
	ESTIMATE_FIELDS,
	type EstimateField,
	type TaskEstimateProvenance,
} from "../core/estimates/provenance";
import type { Task } from "../core/model/Task";
import {
	type EstimateCorrectedEvent,
	type EstimateFeedbackEvent,
	type EstimateSuggestedEvent,
	EstimateFeedbackService,
	feedbackTaskSnapshot,
} from "./EstimateFeedbackService";
import { EstimateMemoryService } from "./EstimateMemoryService";
import { FeedbackStorageAdapter, type FeedbackFilePort } from "./FeedbackStorageAdapter";
import { FieldOwnershipMonitor } from "./FieldOwnershipMonitor";
import type { ScopeCatalogService } from "./ScopeCatalogService";
import { TaskMetadataService, type TaskMetadataAiActionsPort } from "./TaskMetadataService";
import type { WritebackService } from "./WritebackService";

export interface MetadataServicesOptions {
	vault: FeedbackFilePort;
	dispatcher: WritebackService;
	scopes: ScopeCatalogService;
	allTasks(): readonly Task[];
	durationLongStyle(): LongDurationStyle | null;
	now?: () => Date;
	createId?: () => string;
}

export interface MetadataFeedbackSummary {
	events: number;
	invalidRecords: number;
	pendingOutbox: number;
	conflictedOutbox: number;
	invalidOutboxRecords: number;
}

export const AI_FEEDBACK_INSPECTION_LIMIT = 50;

export interface AiFeedbackInspectionField {
	field: EstimateField;
	owner: "ai" | "user";
	locked: boolean;
	lastPredictionEventId: string | null;
	updatedAt: string;
}

export interface AiFeedbackInspectionEvent {
	id: string;
	taskId: string;
	createdAt: string;
	kind: EstimateFeedbackEvent["kind"];
	detail: string;
	provenance: AiFeedbackInspectionField[];
}

export interface AiFeedbackInspection {
	totalEvents: number;
	invalidRecords: number;
	omittedEvents: number;
	events: AiFeedbackInspectionEvent[];
}

/**
 * Narrow boundary accepted by the optional desktop AI composition root.
 * Implementations may be shared across desktop and mobile plugin boot paths.
 */
export interface MetadataServicesBridge {
	readonly history: EstimateFeedbackService;
	readonly memory: EstimateMemoryService;
	readonly ownership: FieldOwnershipMonitor;
	readonly taskMetadata: TaskMetadataService;
	attachAiActions(actions: TaskMetadataAiActionsPort | null): void;
	observeTasks(): void;
	reconcileOwnership(): Promise<void>;
	feedbackSummary(): Promise<MetadataFeedbackSummary>;
	feedbackInspection(requestedLimit?: number): Promise<AiFeedbackInspection>;
	exportFeedback(): Promise<string>;
	clearFeedbackConfirmed(): Promise<number>;
}

/**
 * Mobile-safe composition root for manual task metadata and its synced learning
 * history. It deliberately imports no provider, OAuth, runtime, or AI view code.
 */
export class MetadataServices implements MetadataServicesBridge {
	readonly history: EstimateFeedbackService;
	readonly memory: EstimateMemoryService;
	readonly ownership: FieldOwnershipMonitor;
	readonly taskMetadata: TaskMetadataService;

	private readonly now: () => Date;
	private readonly createId: () => string;
	private reconciliationTail: Promise<void> = Promise.resolve();

	constructor(private readonly options: MetadataServicesOptions) {
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? (() => secureUuid());
		this.history = new EstimateFeedbackService(
			new FeedbackStorageAdapter(options.vault),
			this.now,
		);
		this.memory = new EstimateMemoryService(this.history);
		this.ownership = new FieldOwnershipMonitor(async (edit) => {
			try {
				const event: EstimateCorrectedEvent = {
					schemaVersion: 1,
					id: safeId(this.createId()),
					kind:
						edit.field === "scope"
							? "scope-changed"
							: edit.previousValue === null
								? "estimate-manual"
								: "estimate-corrected",
					taskId: edit.task.taskId!,
					createdAt: this.now().toISOString(),
					runId: null,
					sessionId: null,
					field: edit.field,
					previousValue: edit.previousValue,
					value: edit.value,
					taskSnapshot: feedbackTaskSnapshot(edit.task),
				};
				await this.history.recordMutation(event, [
					{
						field: edit.field,
						previousValue: edit.previousValue,
						intendedValue: edit.value,
					},
				]);
			} catch (error: unknown) {
				// Never log task text or values. Startup reconciliation retries the record.
				console.warn(
					"GTD Flow: metadata ownership feedback write failed",
					errorName(error),
				);
			}
		});
		this.taskMetadata = new TaskMetadataService({
			dispatcher: options.dispatcher,
			history: this.history,
			scopes: () => options.scopes.current(),
			durationLongStyle: options.durationLongStyle,
			expectKnownPatch: (taskId, patch) => this.ownership.expectAiPatch(taskId, patch),
			now: this.now,
			createId: this.createId,
		});
	}

	attachAiActions(actions: TaskMetadataAiActionsPort | null): void {
		this.taskMetadata.attachAiActions(actions);
	}

	observeTasks(): void {
		this.ownership.observe(this.options.allTasks());
	}

	/** Reconcile manual edits made while this plugin instance was not running. */
	reconcileOwnership(): Promise<void> {
		const before = this.reconciliationTail.catch(() => undefined);
		this.reconciliationTail = before.then(() => this.reconcileOwnershipOnce());
		return this.reconciliationTail;
	}

	async feedbackSummary(): Promise<MetadataFeedbackSummary> {
		const [result, outbox] = await Promise.all([
			this.history.readAll(),
			this.history.outboxHealth(),
		]);
		return {
			events: result.events.length,
			invalidRecords: result.invalidPaths.length,
			pendingOutbox: outbox.pending,
			conflictedOutbox: outbox.conflicts,
			invalidOutboxRecords: outbox.invalidRecords,
		};
	}

	/** Privacy-filtered, display-only view of recent learning events. */
	async feedbackInspection(
		requestedLimit: number = AI_FEEDBACK_INSPECTION_LIMIT,
	): Promise<AiFeedbackInspection> {
		const limit = inspectionLimit(requestedLimit);
		const result = await this.history.readAll();
		const recent = result.events.slice(-limit).reverse();
		const taskIds = [...new Set(recent.map((event) => event.taskId))];
		const provenanceByTask: Map<string, TaskEstimateProvenance> =
			await this.history.provenanceForTasks(taskIds, this.now().toISOString(), result);
		return {
			totalEvents: result.events.length,
			invalidRecords: result.invalidPaths.length,
			omittedEvents: Math.max(0, result.events.length - recent.length),
			events: recent.map((event) => ({
				id: safeInspectionIdentifier(event.id),
				taskId: safeInspectionIdentifier(event.taskId),
				createdAt: safeInspectionTimestamp(event.createdAt),
				kind: event.kind,
				detail: feedbackEventDetail(event).slice(0, 500),
				provenance: inspectionProvenance(provenanceByTask.get(event.taskId)),
			})),
		};
	}

	exportFeedback(): Promise<string> {
		return this.history.exportJson();
	}

	clearFeedbackConfirmed(): Promise<number> {
		return this.history.clearConfirmed();
	}

	private async reconcileOwnershipOnce(): Promise<void> {
		const tasks = this.options.allTasks().filter((task) => task.taskId !== null);
		const recovery = await this.history.recoverPending(
			(taskId) => tasks.find((task) => task.taskId === taskId) ?? null,
		);
		if (recovery.conflicts.length > 0 || recovery.invalidPaths.length > 0) {
			console.warn("GTD Flow: metadata feedback recovery needs attention", {
				conflicts: recovery.conflicts.length,
				invalidRecords: recovery.invalidPaths.length,
			});
		}
		const conflictedFields = new Set(
			recovery.conflicts.flatMap((conflict) =>
				conflict.fields.map((field) => `${conflict.taskId}\0${field}`),
			),
		);
		const { events } = await this.history.readAll();
		const byTask = new Map<string, EstimateFeedbackEvent[]>();
		for (const event of events) {
			const bucket = byTask.get(event.taskId);
			if (bucket) bucket.push(event);
			else byTask.set(event.taskId, [event]);
		}
		for (const task of tasks) {
			const taskId = task.taskId!;
			const state = replayOfflineBaselines(byTask.get(taskId) ?? []);
			for (const field of ESTIMATE_FIELDS) {
				if (conflictedFields.has(`${taskId}\0${field}`)) continue;
				const baseline = state[field];
				if (baseline.userOwned || baseline.unlockedWithoutPrediction) continue;
				const value = taskFieldValue(task, field);
				if (!baseline.hasPrediction && value === null) continue;
				if (baseline.hasPrediction && baseline.value === value) continue;
				const previousValue = baseline.hasPrediction ? baseline.value : null;
				const event: EstimateCorrectedEvent = {
					schemaVersion: 1,
					id: safeId(this.createId()),
					kind:
						field === "scope"
							? "scope-changed"
							: baseline.hasPrediction
								? "estimate-corrected"
								: "estimate-manual",
					taskId,
					createdAt: this.now().toISOString(),
					runId: null,
					sessionId: null,
					field,
					previousValue,
					value,
					taskSnapshot: feedbackTaskSnapshot(task),
				};
				await this.history.recordMutation(event, [
					{ field, previousValue, intendedValue: value },
				]);
			}
		}
		this.ownership.observe(tasks);
	}
}

interface OfflineFieldBaseline {
	userOwned: boolean;
	unlockedWithoutPrediction: boolean;
	hasPrediction: boolean;
	value: number | string | null;
}

const INSPECTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const CREDENTIAL_SHAPED =
	/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|credential|client[_-]?secret|secret|oauth|sk-[A-Za-z0-9_-]{4,}|github_pat_|gh[pousr]_|xox[baprs]-|AKIA[0-9A-Z]|AIza[0-9A-Za-z_-]|[pr]k_(?:live|test)_)/iu;

function inspectionLimit(value: number): number {
	if (!Number.isSafeInteger(value)) return AI_FEEDBACK_INSPECTION_LIMIT;
	return Math.max(1, Math.min(AI_FEEDBACK_INSPECTION_LIMIT, value));
}

function safeInspectionIdentifier(value: string): string {
	return INSPECTION_IDENTIFIER.test(value) && !CREDENTIAL_SHAPED.test(value)
		? value
		: "[redacted]";
}

function safeInspectionTimestamp(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "[invalid timestamp]";
}

function safeScopeValue(value: number | string | null): string {
	if (value === null) return "unknown";
	if (typeof value !== "string") return String(value);
	return isActiveInspectionScopeId(value) ? value : "[redacted]";
}

function isActiveInspectionScopeId(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(value) && !CREDENTIAL_SHAPED.test(value);
}

function feedbackValue(
	event: EstimateSuggestedEvent,
	field: EstimateField,
): number | string | null {
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

function displayFeedbackValue(field: EstimateField, value: number | string | null): string {
	if (field === "scope") return safeScopeValue(value);
	if (value === null) return "unknown";
	return field === "duration" ? `${String(value)}m` : String(value);
}

function feedbackEventDetail(event: EstimateFeedbackEvent): string {
	switch (event.kind) {
		case "estimate-suggested":
			return `applied ${event.appliedFields
				.map(
					(field) =>
						`${field}=${displayFeedbackValue(field, feedbackValue(event, field))}`,
				)
				.join(", ")}`;
		case "estimate-field-suggested":
			return `applied ${event.field}=${displayFeedbackValue(event.field, event.value)}`;
		case "estimate-corrected":
		case "estimate-manual":
		case "scope-changed":
			return `${event.field}: ${displayFeedbackValue(
				event.field,
				event.previousValue,
			)} → ${displayFeedbackValue(event.field, event.value)}`;
		case "field-unlocked":
			return `unlocked ${event.fields.join(", ")}`;
		case "field-locked":
			return `locked ${event.fields.join(", ")}`;
		case "question-asked":
			return `question asked for ${event.affectedFields.join(", ")} (content hidden)`;
		case "question-answered":
			return `question answered for ${event.affectedFields.join(", ")} (content hidden)`;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

function inspectionProvenance(
	provenance: TaskEstimateProvenance | undefined,
): AiFeedbackInspectionField[] {
	if (provenance === undefined) return [];
	return ESTIMATE_FIELDS.map((field) => {
		const state = provenance.fields[field];
		return {
			field,
			owner: state.owner,
			locked: state.locked,
			lastPredictionEventId:
				state.lastPredictionEventId === null
					? null
					: safeInspectionIdentifier(state.lastPredictionEventId),
			updatedAt: safeInspectionTimestamp(state.updatedAt),
		};
	});
}

function replayOfflineBaselines(
	events: readonly EstimateFeedbackEvent[],
): Record<EstimateField, OfflineFieldBaseline> {
	const state = Object.fromEntries(
		ESTIMATE_FIELDS.map((field) => [
			field,
			{
				userOwned: false,
				unlockedWithoutPrediction: false,
				hasPrediction: false,
				value: null,
			},
		]),
	) as Record<EstimateField, OfflineFieldBaseline>;
	for (const event of [...events].sort(compareEvents)) {
		if (event.kind === "estimate-suggested") {
			for (const field of event.appliedFields) {
				if (state[field].userOwned) continue;
				state[field] = {
					userOwned: false,
					unlockedWithoutPrediction: false,
					hasPrediction: true,
					value: suggestedFieldValue(event, field),
				};
			}
			continue;
		}
		if (event.kind === "estimate-field-suggested") {
			if (state[event.field].userOwned) continue;
			state[event.field] = {
				userOwned: false,
				unlockedWithoutPrediction: false,
				hasPrediction: true,
				value: event.value,
			};
			continue;
		}
		if (
			event.kind === "estimate-corrected" ||
			event.kind === "estimate-manual" ||
			event.kind === "scope-changed"
		) {
			state[event.field] = {
				...state[event.field],
				userOwned: true,
				unlockedWithoutPrediction: false,
				value: event.value,
			};
			continue;
		}
		if (event.kind === "field-unlocked") {
			for (const field of event.fields) {
				state[field] = {
					...state[field],
					userOwned: false,
					unlockedWithoutPrediction: true,
				};
			}
		}
		if (event.kind === "field-locked") {
			for (const field of event.fields) {
				state[field] = {
					...state[field],
					userOwned: true,
					unlockedWithoutPrediction: false,
				};
			}
		}
	}
	return state;
}

function suggestedFieldValue(
	event: EstimateSuggestedEvent,
	field: EstimateField,
): number | string | null {
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

function taskFieldValue(task: Task, field: EstimateField): number | string | null {
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

function compareEvents(left: EstimateFeedbackEvent, right: EstimateFeedbackEvent): number {
	return (
		Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
	);
}

function safeId(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
	return /^[A-Za-z0-9]/u.test(normalized) ? normalized : `id_${normalized}`;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "UnknownError";
}
