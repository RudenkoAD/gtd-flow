import {
	ESTIMATE_FIELDS,
	type EstimateField,
	type EstimatePatch,
	type TaskEstimateProvenance,
} from "../core/estimates/provenance";
import type { Intent } from "../core/intents/Intent";
import { resolveLineTransform } from "../core/intents/resolveIntent";
import type { LongDurationStyle } from "../core/estimates/format";
import { secureUuid } from "../core/id/secureUuid";
import type { Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { isActiveScopeId, type ScopeCatalog } from "../core/scope/scope";
import type {
	EstimateCorrectedEvent,
	EstimateFeedbackService,
	FeedbackFieldMutation,
	EstimateTaskSnapshot,
} from "./EstimateFeedbackService";
import { feedbackTaskSnapshot } from "./EstimateFeedbackService";
import type { IntentResult, WritebackService } from "./WritebackService";

/** Desktop-only actions that can be attached without making this service load AI code. */
export interface TaskMetadataAiActionsPort {
	unlockAndReprocess(task: Task, field?: EstimateField): Promise<IntentResult>;
	unlockFieldAndReprocess(task: Task, field: EstimateField): Promise<IntentResult>;
	openRelatedAiRun(task: Task): Promise<IntentResult>;
}

export interface TaskMetadataServiceOptions {
	dispatcher: WritebackService;
	history: EstimateFeedbackService;
	scopes(): ScopeCatalog;
	durationLongStyle?(): LongDurationStyle | null;
	aiActions?: TaskMetadataAiActionsPort | null;
	expectKnownPatch?(
		taskId: string,
		patch: Partial<Record<EstimateField, number | string | null>>,
	): void | (() => void);
	now?: () => Date;
	createId?: () => string;
}

interface ProvenanceWaiter {
	resolve(value: TaskEstimateProvenance | null): void;
	reject(reason: unknown): void;
}

interface ActiveProvenanceBatch {
	taskIds: ReadonlySet<string>;
	result: Promise<Map<string, TaskEstimateProvenance>>;
}

export class TaskMetadataService {
	private readonly now: () => Date;
	private readonly createId: () => string;
	private aiActions: TaskMetadataAiActionsPort | null;
	private provenanceBatch = new Map<string, ProvenanceWaiter[]>();
	private provenanceBatchScheduled = false;
	private activeProvenanceBatch: ActiveProvenanceBatch | null = null;
	openRelatedAiRun?: (task: Task) => Promise<IntentResult>;

	constructor(private readonly options: TaskMetadataServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? (() => secureUuid());
		this.aiActions = options.aiActions ?? null;
		this.updateOptionalAiActions();
	}

	/** Attach or remove the optional desktop AI capability. */
	attachAiActions(actions: TaskMetadataAiActionsPort | null): void {
		this.aiActions = actions;
		this.updateOptionalAiActions();
	}

	scopes(): ScopeCatalog {
		const catalog = this.options.scopes();
		return {
			schemaVersion: 1,
			scopes: catalog.scopes.map((scope) => ({ ...scope })),
		};
	}

	scopeName(scopeId: string): string | null {
		return this.options.scopes().scopes.find((scope) => scope.id === scopeId)?.name ?? null;
	}

	durationLongStyle(): LongDurationStyle | null {
		return this.options.durationLongStyle?.() ?? null;
	}

	provenanceForTask(taskId: string): Promise<TaskEstimateProvenance | null> {
		const active = this.activeProvenanceBatch;
		if (active !== null && active.taskIds.has(taskId)) {
			return active.result.then((provenances) => provenances.get(taskId) ?? null);
		}
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject } satisfies ProvenanceWaiter;
			const existing = this.provenanceBatch.get(taskId);
			if (existing === undefined) this.provenanceBatch.set(taskId, [waiter]);
			else existing.push(waiter);
			this.scheduleProvenanceBatch();
		});
	}

	private scheduleProvenanceBatch(): void {
		if (
			this.activeProvenanceBatch !== null ||
			this.provenanceBatchScheduled ||
			this.provenanceBatch.size === 0
		)
			return;
		this.provenanceBatchScheduled = true;
		void Promise.resolve().then(() => this.flushProvenanceBatch());
	}

	private async flushProvenanceBatch(): Promise<void> {
		this.provenanceBatchScheduled = false;
		if (this.activeProvenanceBatch !== null || this.provenanceBatch.size === 0) return;
		const batch = this.provenanceBatch;
		this.provenanceBatch = new Map();
		const taskIds = [...batch.keys()];
		let result: Promise<Map<string, TaskEstimateProvenance>>;
		try {
			result = Promise.resolve(
				this.options.history.provenanceForTasks(taskIds, this.now().toISOString()),
			);
		} catch (error: unknown) {
			result = Promise.reject(error);
		}
		this.activeProvenanceBatch = { taskIds: new Set(taskIds), result };
		try {
			const provenances = await result;
			for (const [taskId, waiters] of batch) {
				for (const waiter of waiters) waiter.resolve(provenances.get(taskId) ?? null);
			}
		} catch (error: unknown) {
			for (const waiters of batch.values()) {
				for (const waiter of waiters) waiter.reject(error);
			}
		} finally {
			if (this.activeProvenanceBatch?.result === result) this.activeProvenanceBatch = null;
			this.scheduleProvenanceBatch();
		}
	}

	async applyManualPatch(task: Task, patch: EstimatePatch): Promise<IntentResult> {
		return this.applyManualUpdate(task, [], patch);
	}

	async applyManualUpdate(
		task: Task,
		ordinaryIntents: readonly (Intent & { key: string })[],
		patch: EstimatePatch,
	): Promise<IntentResult> {
		const fields = changedPatchFields(patch);
		if (ordinaryIntents.length === 0 && fields.length === 0) return { ok: true };
		if (
			patch.scopeId !== undefined &&
			patch.scopeId !== null &&
			patch.scopeId !== task.scopeId &&
			!isActiveScopeId(this.options.scopes(), patch.scopeId)
		) {
			return { ok: false, reason: "scope-not-active" };
		}
		const snapshot =
			fields.length === 0
				? undefined
				: feedbackSnapshotAfterOrdinaryIntents(task, ordinaryIntents);
		if (snapshot === null) return { ok: false, reason: "transform-failed" };

		const anchored =
			fields.length === 0 ? null : await this.options.dispatcher.ensureTaskId(task.key);
		if (anchored !== null && !anchored.ok) return anchored;
		const prepared: EstimateCorrectedEvent[] = [];
		for (const field of fields) {
			const previousValue = taskFieldValue(task, field);
			const value = patchFieldValue(patch, field);
			const event: EstimateCorrectedEvent = {
				schemaVersion: 1,
				id: safeId(this.createId()),
				kind:
					field === "scope"
						? "scope-changed"
						: previousValue === null
							? "estimate-manual"
							: "estimate-corrected",
				taskId: anchored!.taskId,
				createdAt: this.now().toISOString(),
				runId: null,
				sessionId: null,
				field,
				previousValue,
				value,
				taskSnapshot: snapshot,
			};
			const mutation: FeedbackFieldMutation = {
				field,
				previousValue,
				intendedValue: value,
			};
			try {
				await this.options.history.prepareMutation(event, [mutation]);
				prepared.push(event);
			} catch {
				await this.cancelPrepared(prepared);
				return { ok: false, reason: "feedback-prepare-failed" };
			}
		}

		const expectedPatch = Object.fromEntries(
			fields.map((field) => [field, patchFieldValue(patch, field)]),
		) as Partial<Record<EstimateField, number | string | null>>;
		const cancelExpected =
			fields.length === 0
				? undefined
				: this.options.expectKnownPatch?.(anchored!.taskId, expectedPatch);
		const intents: Array<Intent & { key: string }> = [...ordinaryIntents];
		if (fields.length > 0) {
			intents.push({ type: "patch-task-metadata", key: task.key, ...patch });
		}
		let batch = await this.options.dispatcher.dispatchMany(intents);
		if (
			!batch.ok &&
			batch.reason === "task-not-found" &&
			task.taskId === null &&
			anchored !== null &&
			anchored.ok
		) {
			const stableKey = `id:${anchored.taskId}`;
			batch = await this.options.dispatcher.dispatchMany(
				intents.map((intent) => ({ ...intent, key: stableKey })),
			);
		}
		const result: IntentResult = batch.ok ? { ok: true } : { ok: false, reason: batch.reason };
		if (!result.ok) {
			if (typeof cancelExpected === "function") cancelExpected();
			await this.cancelPrepared(prepared);
			return result;
		}

		let feedbackFailed = false;
		for (const event of prepared) {
			try {
				await this.options.history.commitPrepared(event.id);
			} catch {
				feedbackFailed = true;
			}
		}
		return feedbackFailed
			? { ok: false, reason: "metadata-saved-but-feedback-write-failed" }
			: { ok: true };
	}

	private async cancelPrepared(events: readonly EstimateCorrectedEvent[]): Promise<void> {
		for (const event of events) {
			try {
				await this.options.history.cancelPrepared(event.id);
			} catch {
				// Recovery sees unchanged Markdown and cancels the durable record.
			}
		}
	}

	unlockAndReprocess(task: Task, field?: EstimateField): Promise<IntentResult> {
		return (
			this.aiActions?.unlockAndReprocess(task, field) ??
			Promise.resolve({ ok: false, reason: "desktop-ai-unavailable" })
		);
	}

	unlockFieldAndReprocess(task: Task, field: EstimateField): Promise<IntentResult> {
		return (
			this.aiActions?.unlockFieldAndReprocess(task, field) ??
			Promise.resolve({ ok: false, reason: "desktop-ai-unavailable" })
		);
	}

	private updateOptionalAiActions(): void {
		const actions = this.aiActions;
		this.openRelatedAiRun =
			actions === null ? undefined : (task) => actions.openRelatedAiRun(task);
	}
}

function feedbackSnapshotAfterOrdinaryIntents(
	task: Task,
	ordinaryIntents: readonly (Intent & { key: string })[],
): EstimateTaskSnapshot | null {
	const textIntents = ordinaryIntents.filter((intent) => intent.type === "set-text");
	if (textIntents.length === 0) return feedbackTaskSnapshot(task);
	try {
		let rawLine = task.rawLine;
		for (const intent of textIntents) {
			const next = resolveLineTransform(intent, rawLine);
			if (next === null) return null;
			rawLine = next;
		}
		const parsed = parseTaskLine(rawLine, {
			filePath: task.filePath,
			lineStart: task.lineStart,
			parentLine: task.parentLine,
			heading: task.heading,
			container: task.container,
			projectActive: task.projectActive,
		});
		return parsed === null ? null : feedbackTaskSnapshot(parsed);
	} catch {
		return null;
	}
}

function changedPatchFields(patch: EstimatePatch): EstimateField[] {
	return ESTIMATE_FIELDS.filter((field) => {
		switch (field) {
			case "duration":
				return patch.durationMinutes !== undefined;
			case "cognitive":
				return patch.cognitiveIntensity !== undefined;
			case "emotional":
				return patch.emotionalIntensity !== undefined;
			case "physical":
				return patch.physicalIntensity !== undefined;
			case "scope":
				return patch.scopeId !== undefined;
		}
	});
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

function patchFieldValue(patch: EstimatePatch, field: EstimateField): number | string | null {
	switch (field) {
		case "duration":
			return patch.durationMinutes ?? null;
		case "cognitive":
			return patch.cognitiveIntensity ?? null;
		case "emotional":
			return patch.emotionalIntensity ?? null;
		case "physical":
			return patch.physicalIntensity ?? null;
		case "scope":
			return patch.scopeId ?? null;
	}
}

function safeId(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
	return /^[A-Za-z0-9]/u.test(normalized) ? normalized : `id_${normalized}`;
}
