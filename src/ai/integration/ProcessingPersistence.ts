import type { InboxProcessingPersistence } from "../processing/InboxProcessor";
import type { RunRepository } from "../storage/RunRepository";
import type { SessionRepository } from "../storage/SessionRepository";

export class RepositoryProcessingPersistence implements InboxProcessingPersistence {
	constructor(
		private readonly sessions: SessionRepository,
		private readonly runs: RunRepository,
	) {}

	async createSession(input: {
		id: string;
		kind: "inbox-processing";
		createdAt: string;
	}): Promise<void> {
		await this.sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: input.id,
			sessionKind: input.kind,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
		});
	}

	appendMessage(
		sessionId: string,
		message: Parameters<SessionRepository["appendMessage"]>[1],
		updatedAt: string,
	): Promise<void> {
		return this.sessions.appendMessage(sessionId, message, updatedAt);
	}

	async createRun(input: {
		id: string;
		sessionId: string;
		taskIds: string[];
		createdAt: string;
		attempt?: number;
		retryOfRunId?: string | null;
		initialWaiting?: {
			state: "rate_limited" | "retry_waiting";
			nextEligibleAt: string;
		};
		requestContext?: {
			onlyFields: Array<"duration" | "cognitive" | "emotional" | "physical" | "scope"> | null;
			unlockFields: Array<"duration" | "cognitive" | "emotional" | "physical" | "scope">;
			questionContext: string | null;
		};
	}): Promise<void> {
		await this.runs.create({
			schemaVersion: 1,
			id: input.id,
			sessionId: input.sessionId,
			taskIds: input.taskIds,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
			state: input.initialWaiting?.state ?? "queued",
			attempt: input.attempt ?? 0,
			nextEligibleAt: input.initialWaiting?.nextEligibleAt ?? null,
			actualModel: null,
			error: null,
			retryOfRunId: input.retryOfRunId ?? null,
			requestContext: input.requestContext,
		});
	}

	async transitionRun(
		id: string,
		to: Parameters<RunRepository["transition"]>[1],
		updatedAt: string,
		options?: { nextEligibleAt?: string | null },
	): Promise<void> {
		await this.runs.transition(id, to, updatedAt, options);
	}

	async recordProviderResult(
		id: string,
		result: Parameters<RunRepository["recordProviderResult"]>[1],
		updatedAt: string,
	): Promise<void> {
		await this.runs.recordProviderResult(id, result, updatedAt);
	}
}
