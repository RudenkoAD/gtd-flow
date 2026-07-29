import type { Task } from "../../core/model/Task";
import { recoverableRuns } from "./ProcessingQueue";
import type { InboxProcessor, ProcessInboxSummary } from "./InboxProcessor";
import type { RunRepository } from "../storage/RunRepository";
import { RecordIdSchema, type ProcessingRunV1 } from "../storage/storageSchemas";

export const DEFAULT_PROCESSING_STALE_AFTER_MS = 10 * 60_000;

export interface DurableQueueCoordinatorOptions {
	runs: RunRepository;
	processor: Pick<InboxProcessor, "process">;
	findTask(taskId: string): Task | null;
	now?: () => Date;
	/** Avoid treating an in-flight request as a crash leftover. Defaults to ten minutes. */
	staleAfterMs?: number;
	/** Stable local installation ID. Supply this from local (non-synced) settings. */
	clientId?: string;
	/** A recovery worker may send only while this immutable lease is valid. */
	leaseMs?: number;
}

/**
 * Recovery is command-driven: merely opening Obsidian never starts network
 * work. A recovery always creates a child run; the old record is retained as
 * `superseded` lineage rather than being falsely marked completed.
 */
export class DurableQueueCoordinator {
	private readonly now: () => Date;
	private readonly staleAfterMs: number;
	private readonly clientId: string;
	private readonly leaseMs: number;

	constructor(private readonly options: DurableQueueCoordinatorOptions) {
		this.now = options.now ?? (() => new Date());
		this.staleAfterMs = Math.max(
			60_000,
			options.staleAfterMs ?? DEFAULT_PROCESSING_STALE_AFTER_MS,
		);
		this.clientId = RecordIdSchema.parse(options.clientId ?? `recovery-${crypto.randomUUID()}`);
		if (this.clientId.length > 180) {
			throw new Error("recovery-client-id-too-long");
		}
		this.leaseMs = Math.max(60_000, options.leaseMs ?? this.staleAfterMs);
	}

	/** Explicit command hook for both due rate-limit retries and crashed workers. */
	async recover(): Promise<ProcessInboxSummary[]> {
		const nowDate = this.now();
		const now = nowDate.toISOString();
		const staleBefore = new Date(nowDate.getTime() - this.staleAfterMs).toISOString();
		const allRuns = await this.options.runs.list();
		const waiting = recoverableRuns(allRuns, now, staleBefore);
		const summaries: ProcessInboxSummary[] = [];
		for (const run of waiting) {
			const claimed = await this.options.runs.acquireRecoveryLease(
				run.id,
				this.clientId,
				this.now().toISOString(),
				this.leaseMs,
			);
			if (claimed.lease === null) continue;
			// The snapshot above can be stale. A child may have synced after it was
			// taken, in which case terminalize only the parent and never send again.
			const currentRuns = await this.options.runs.list();
			const current = currentRuns.find((candidate) => candidate.id === run.id);
			if (!current || !isStillRecoverable(current, now, staleBefore)) continue;
			// A crash may happen after the child was persisted but before its parent
			// was terminalized. Never launch a second child in that interval.
			if (currentRuns.some((candidate) => candidate.retryOfRunId === run.id)) {
				await this.supersede(run.id);
				continue;
			}
			// One final read catches a simultaneous local contender before network
			// work. Any observed conflict fails closed in the repository.
			if (
				(
					await this.options.runs.confirmRecoveryLease(
						claimed.lease,
						this.now().toISOString(),
					)
				).lease === null
			)
				continue;
			const keys = current.taskIds
				.map((taskId) => this.options.findTask(taskId)?.key ?? null)
				.filter((key): key is string => key !== null);
			if (keys.length === 0) {
				await this.options.runs.recordProviderResult(
					run.id,
					{
						actualModel: null,
						error: {
							code: "unknown",
							statusCode: null,
							retryable: false,
							retryAfterMs: null,
						},
					},
					this.now().toISOString(),
				);
				await this.options.runs.transition(run.id, "failed", this.now().toISOString());
				continue;
			}
			const requestContext = current.requestContext ?? {
				onlyFields: null,
				unlockFields: [],
				questionContext: null,
			};
			const summary = await this.options.processor.process({
				taskKeys: keys,
				retryOfRunId: current.id,
				priorAttempt: current.attempt,
				...(requestContext.onlyFields === null
					? {}
					: { onlyFields: requestContext.onlyFields }),
				...(requestContext.unlockFields.length
					? { unlockFields: requestContext.unlockFields }
					: {}),
				...(requestContext.questionContext === null
					? {}
					: { questionContext: requestContext.questionContext }),
			});
			// blocked/no-task summaries have no durable child. Keep the old record
			// recoverable (or fail it above) instead of pretending the retry completed.
			if (summary.runId === null) continue;
			await this.supersede(current.id);
			summaries.push(summary);
		}
		return summaries;
	}

	/** Backward-compatible command name used by the current integration layer. */
	async retryEligible(): Promise<ProcessInboxSummary[]> {
		return this.recover();
	}

	private async supersede(id: string): Promise<void> {
		const current = await this.options.runs.get(id);
		if (current.state === "superseded") return;
		if (
			current.state !== "queued" &&
			current.state !== "rate_limited" &&
			current.state !== "retry_waiting" &&
			current.state !== "processing"
		)
			return;
		await this.options.runs.transition(id, "superseded", this.now().toISOString());
	}
}

function isStillRecoverable(run: ProcessingRunV1, now: string, staleBefore: string): boolean {
	return recoverableRuns([run], now, staleBefore).length === 1;
}
