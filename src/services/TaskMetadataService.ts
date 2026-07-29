import {
	ESTIMATE_FIELDS,
	type EstimateField,
	type EstimatePatch,
	type TaskEstimateProvenance,
} from "../core/estimates/provenance";
import type { Task } from "../core/model/Task";
import type { LongDurationStyle } from "../core/estimates/format";
import { activeScopes, type ScopeCatalog } from "../core/scope/scope";
import type { InboxProcessor } from "../ai/processing/InboxProcessor";
import type {
	EstimateCorrectedEvent,
	EstimateFeedbackService,
	FeedbackFieldMutation,
} from "./EstimateFeedbackService";
import { feedbackTaskSnapshot } from "./EstimateFeedbackService";
import type { IntentResult, WritebackService } from "./WritebackService";

export interface TaskMetadataServiceOptions {
	dispatcher: WritebackService;
	history: EstimateFeedbackService;
	processor: Pick<InboxProcessor, "process">;
	scopes(): ScopeCatalog;
	durationLongStyle?(): LongDurationStyle | null;
	openSession(sessionId: string): Promise<void>;
	expectKnownPatch?(
		taskId: string,
		patch: Partial<Record<EstimateField, number | string | null>>,
	): void | (() => void);
	now?: () => Date;
	createId?: () => string;
}

export class TaskMetadataService {
	private readonly now: () => Date;
	private readonly createId: () => string;

	constructor(private readonly options: TaskMetadataServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? (() => crypto.randomUUID());
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
		return this.options.history.provenanceForTask(taskId, this.now().toISOString());
	}

	async applyManualPatch(task: Task, patch: EstimatePatch): Promise<IntentResult> {
		const anchored = await this.options.dispatcher.ensureTaskId(task.key);
		if (!anchored.ok) return anchored;
		const fields = changedPatchFields(patch);
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
				taskId: anchored.taskId,
				createdAt: this.now().toISOString(),
				runId: null,
				sessionId: null,
				field,
				previousValue,
				value,
				taskSnapshot: feedbackTaskSnapshot(task),
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
				: this.options.expectKnownPatch?.(anchored.taskId, expectedPatch);
		const result = await this.options.dispatcher.dispatch({
			type: "patch-task-metadata",
			key: task.key,
			...patch,
		});
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

	async unlockAndReprocess(task: Task, field?: EstimateField): Promise<IntentResult> {
		const anchored = await this.options.dispatcher.ensureTaskId(task.key);
		if (!anchored.ok) return anchored;
		const provenance = await this.options.history.provenanceForTask(
			anchored.taskId,
			this.now().toISOString(),
		);
		const eligibleFields = ESTIMATE_FIELDS.filter(
			(field) => provenance.fields[field].locked || provenance.fields[field].owner === "user",
		);
		if (eligibleFields.length === 0) {
			return { ok: false, reason: "no-locked-ai-fields" };
		}
		const selectedField =
			field ?? (eligibleFields.length === 1 ? eligibleFields[0] : undefined);
		if (selectedField === undefined) {
			return { ok: false, reason: "ai-field-selection-required" };
		}
		if (!eligibleFields.includes(selectedField)) {
			return { ok: false, reason: "ai-field-not-locked" };
		}
		if (activeScopes(this.options.scopes()).length === 0) {
			return { ok: false, reason: "ai-reprocessing-blocked-no-scopes" };
		}
		const summary = await this.options.processor.process({
			taskKeys: [task.key],
			onlyFields: [selectedField],
			unlockFields: [selectedField],
		});
		switch (summary.state) {
			case "nothing-to-process":
				return { ok: false, reason: "ai-reprocessing-nothing-to-process" };
			case "blocked-no-scopes":
				return { ok: false, reason: "ai-reprocessing-blocked-no-scopes" };
			case "failed":
				return {
					ok: false,
					reason: summary.failed[0]?.reason ?? "ai-reprocessing-failed",
				};
			case "cancelled":
				return { ok: false, reason: "ai-reprocessing-cancelled" };
			default:
				return summary.runId === null
					? { ok: false, reason: "ai-reprocessing-did-not-start" }
					: { ok: true };
		}
	}

	unlockFieldAndReprocess(task: Task, field: EstimateField): Promise<IntentResult> {
		return this.unlockAndReprocess(task, field);
	}

	async openRelatedAiRun(task: Task): Promise<IntentResult> {
		if (task.taskId === null) return { ok: false, reason: "task-has-no-ai-run" };
		const events = await this.options.history.eventsForTask(task.taskId);
		const latest = [...events]
			.reverse()
			.find((event) => event.kind === "estimate-suggested" && event.sessionId !== null);
		if (!latest?.sessionId) return { ok: false, reason: "task-has-no-ai-run" };
		await this.options.openSession(latest.sessionId);
		return { ok: true };
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
