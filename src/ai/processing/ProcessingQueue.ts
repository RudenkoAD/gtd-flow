import { z } from "zod";

export const ProcessingRunStateSchema = z.enum([
	"queued",
	"processing",
	"values_applied",
	"rate_limited",
	"retry_waiting",
	"failed",
	"cancelled",
	"awaiting_answers",
	"completed",
	"superseded",
]);
export type ProcessingRunState = z.infer<typeof ProcessingRunStateSchema>;

export interface ProcessingRunStateSnapshot {
	id: string;
	state: ProcessingRunState;
	createdAt: string;
	updatedAt: string;
	nextEligibleAt: string | null;
	attempt: number;
}

export type TransitionedRun<T extends ProcessingRunStateSnapshot> = Omit<
	T,
	"state" | "updatedAt" | "nextEligibleAt" | "attempt"
> &
	ProcessingRunStateSnapshot;

const transitions: Readonly<Record<ProcessingRunState, readonly ProcessingRunState[]>> = {
	queued: ["processing", "failed", "superseded"],
	processing: [
		"values_applied",
		"rate_limited",
		"retry_waiting",
		"failed",
		"cancelled",
		"superseded",
	],
	values_applied: ["awaiting_answers", "completed"],
	rate_limited: ["queued", "failed", "superseded"],
	retry_waiting: ["queued", "failed", "superseded"],
	failed: ["queued"],
	cancelled: [],
	awaiting_answers: ["processing", "completed"],
	completed: [],
	/** A retry child owns the remaining work; this record is retained as lineage. */
	superseded: [],
};

export function canTransition(from: ProcessingRunState, to: ProcessingRunState): boolean {
	return transitions[from].includes(to);
}

export class InvalidRunTransitionError extends Error {
	constructor(
		readonly from: ProcessingRunState,
		readonly to: ProcessingRunState,
	) {
		super(`Invalid processing run transition: ${from} -> ${to}`);
		this.name = "InvalidRunTransitionError";
	}
}

export function transitionRun<T extends ProcessingRunStateSnapshot>(
	run: T,
	to: ProcessingRunState,
	updatedAt: string,
	options: { nextEligibleAt?: string | null } = {},
): TransitionedRun<T> {
	if (!canTransition(run.state, to)) throw new InvalidRunTransitionError(run.state, to);
	if (isWaitingRunState(to) && !options.nextEligibleAt) {
		throw new Error("Waiting runs require nextEligibleAt");
	}
	const nextEligibleAt = isWaitingRunState(to) ? (options.nextEligibleAt ?? null) : null;
	return {
		...run,
		state: to,
		updatedAt,
		nextEligibleAt,
		attempt: to === "processing" ? run.attempt + 1 : run.attempt,
	};
}

/** Exactly one worker chooses the oldest queued item. */
export function nextQueuedRun<T extends ProcessingRunStateSnapshot>(runs: readonly T[]): T | null {
	return (
		runs
			.filter((run) => run.state === "queued")
			.slice()
			.sort((left, right) => {
				const byCreated = instant(left.createdAt) - instant(right.createdAt);
				return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
			})[0] ?? null
	);
}

/** Returns durable waiting runs that can be explicitly re-queued while the app is open. */
export function eligibleRateLimitedRuns<T extends ProcessingRunStateSnapshot>(
	runs: readonly T[],
	now: string,
): T[] {
	return runs.filter(
		(run) =>
			isWaitingRunState(run.state) &&
			run.nextEligibleAt !== null &&
			instant(run.nextEligibleAt) <= instant(now),
	);
}

/** Explicit recovery candidates. `queued`/`processing` may be crash leftovers;
 * rate-limited work is eligible only after its durable deadline. */
export function recoverableRuns<T extends ProcessingRunStateSnapshot>(
	runs: readonly T[],
	now: string,
	staleBefore: string = now,
): T[] {
	return runs
		.filter(
			(run) =>
				((run.state === "queued" || run.state === "processing") &&
					instant(run.updatedAt) <= instant(staleBefore)) ||
				(isWaitingRunState(run.state) &&
					run.nextEligibleAt !== null &&
					instant(run.nextEligibleAt) <= instant(now)),
		)
		.slice()
		.sort(
			(left, right) =>
				instant(left.createdAt) - instant(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
}

export function isWaitingRunState(state: ProcessingRunState): boolean {
	return state === "rate_limited" || state === "retry_waiting";
}

function instant(value: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error("invalid-processing-run-timestamp");
	return parsed;
}

/** Exponential backoff with bounded jitter, for callers that have no Retry-After. */
export function retryDelayMs(
	attempt: number,
	random: () => number,
	baseMs = 1_000,
	maxMs = 15 * 60_000,
): number {
	const cappedAttempt = Math.max(0, Math.min(attempt, 20));
	const exponential = Math.min(maxMs, baseMs * 2 ** cappedAttempt);
	const jitter = 0.5 + Math.max(0, Math.min(1, random()));
	return Math.min(maxMs, Math.round(exponential * jitter));
}
