import { ESTIMATE_FIELDS, type EstimateField } from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import { activeScopes, type ScopeCatalog } from "../../core/scope/scope";
import type { EstimateFeedbackService } from "../../services/EstimateFeedbackService";
import type { TaskMetadataAiActionsPort } from "../../services/TaskMetadataService";
import type { IntentResult, WritebackService } from "../../services/WritebackService";
import type { InboxProcessor } from "../processing/InboxProcessor";

export interface DesktopTaskMetadataActionsOptions {
	dispatcher: Pick<WritebackService, "ensureTaskId">;
	history: Pick<EstimateFeedbackService, "eventsForTask" | "provenanceForTask">;
	processor: Pick<InboxProcessor, "process">;
	scopes(): ScopeCatalog;
	openSession(sessionId: string): Promise<void>;
	now?: () => Date;
}

/**
 * AI-specific task actions. This class is constructed only by the desktop AI
 * composition root and attached to the mobile-safe TaskMetadataService facade.
 */
export class DesktopTaskMetadataActions implements TaskMetadataAiActionsPort {
	private readonly now: () => Date;

	constructor(private readonly options: DesktopTaskMetadataActionsOptions) {
		this.now = options.now ?? (() => new Date());
	}

	async unlockAndReprocess(task: Task, field?: EstimateField): Promise<IntentResult> {
		const anchored = await this.options.dispatcher.ensureTaskId(task.key);
		if (!anchored.ok) return anchored;
		const provenance = await this.options.history.provenanceForTask(
			anchored.taskId,
			this.now().toISOString(),
		);
		const eligibleFields = ESTIMATE_FIELDS.filter(
			(candidate) =>
				provenance.fields[candidate].locked ||
				provenance.fields[candidate].owner === "user",
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
