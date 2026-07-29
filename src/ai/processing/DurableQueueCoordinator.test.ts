import { describe, expect, it, vi } from "vitest";
import type { AtomicFilePort } from "../storage/AtomicFilePort";
import { RunRepository } from "../storage/RunRepository";
import { DurableQueueCoordinator } from "./DurableQueueCoordinator";

class MemoryFiles implements AtomicFilePort {
	readonly files = new Map<string, string>();
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async writeAtomic(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}
	async writeNew(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error("already-exists");
		this.files.set(path, content);
	}
	async list(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((path) => path.startsWith(`${prefix}/`));
	}
}

const CREATED = "2026-07-28T00:00:00.000Z";
const NOW = "2026-07-28T00:20:00.000Z";

async function createRun(
	runs: RunRepository,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	await runs.create({
		schemaVersion: 1,
		id: "run-1",
		sessionId: "session-1",
		taskIds: ["task-1"],
		createdAt: CREATED,
		updatedAt: CREATED,
		state: "rate_limited",
		attempt: 1,
		nextEligibleAt: "2026-07-28T00:01:00.000Z",
		actualModel: null,
		error: null,
		...overrides,
	});
}

function completedSummary(runId: string | null = "retry-run") {
	return {
		state: "completed" as const,
		runId,
		sessionId: "retry-session",
		applied: 1,
		skippedLocked: 0,
		failed: [],
		questions: [],
		actualModel: "free/model",
		nextEligibleAt: null,
		feedbackWarnings: 0,
	};
}

describe("DurableQueueCoordinator recovery", () => {
	it("does no network work on construction or before an explicit eligible retry", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, { nextEligibleAt: "2026-07-28T00:30:00.000Z" });
		const process = vi.fn();
		new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});
		expect(process).not.toHaveBeenCalled();
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});
		expect(await coordinator.retryEligible()).toEqual([]);
		expect(process).not.toHaveBeenCalled();
		expect((await runs.get("run-1")).state).toBe("rate_limited");
	});

	it("retries an eligible rate-limited run as a lineage child and supersedes the old record", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs);
		const process = vi.fn(async () => completedSummary());
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		expect(await coordinator.retryEligible()).toEqual([completedSummary()]);
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			retryOfRunId: "run-1",
			priorAttempt: 1,
		});
		expect((await runs.get("run-1")).state).toBe("superseded");
	});

	it("retries an eligible non-quota provider failure without relabelling it as rate-limited", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, {
			state: "retry_waiting",
			error: {
				code: "network",
				statusCode: null,
				retryable: true,
				retryAfterMs: null,
			},
		});
		const process = vi.fn(async () => completedSummary());
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		await expect(coordinator.retryEligible()).resolves.toEqual([completedSummary()]);
		expect(process).toHaveBeenCalledOnce();
		expect((await runs.get("run-1")).state).toBe("superseded");
	});

	it("preserves targeted fields, unlocks, and question context across retry lineage", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, {
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: ["duration"],
				questionContext: "Question: include review?\nAnswer: yes",
			},
		});
		const process = vi.fn(async () => completedSummary());
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		await coordinator.retryEligible();
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			retryOfRunId: "run-1",
			priorAttempt: 1,
			onlyFields: ["duration"],
			unlockFields: ["duration"],
			questionContext: "Question: include review?\nAnswer: yes",
		});
	});

	it("recovers a crash-left processing run only by an explicit command", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, {
			state: "processing",
			attempt: 3,
			nextEligibleAt: null,
		});
		const process = vi.fn(async () => completedSummary("retry-after-crash"));
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		await coordinator.recover();
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			retryOfRunId: "run-1",
			priorAttempt: 3,
		});
		expect((await runs.get("run-1")).state).toBe("superseded");
	});

	it("does not duplicate a recent in-flight processing run", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, {
			state: "processing",
			updatedAt: "2026-07-28T00:19:30.000Z",
			nextEligibleAt: null,
		});
		const process = vi.fn(async () => completedSummary());
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		expect(await coordinator.recover()).toEqual([]);
		expect(process).not.toHaveBeenCalled();
		expect((await runs.get("run-1")).state).toBe("processing");
	});

	it("also recovers the narrow crash window after a run was persisted but before processing began", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, { state: "queued", attempt: 0, nextEligibleAt: null });
		const process = vi.fn(async () => completedSummary("retry-after-queue-crash"));
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		await coordinator.recover();
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			retryOfRunId: "run-1",
			priorAttempt: 0,
		});
		expect((await runs.get("run-1")).state).toBe("superseded");
	});

	it("does not complete a source run when the retry produced no durable child", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs);
		const process = vi.fn(async () => ({
			...completedSummary(null),
			state: "nothing-to-process" as const,
		}));
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		expect(await coordinator.retryEligible()).toEqual([]);
		expect((await runs.get("run-1")).state).toBe("rate_limited");
	});

	it("reconciles a child persisted before its parent was superseded without duplicate processing", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs);
		await runs.create({
			schemaVersion: 1,
			id: "child-1",
			sessionId: "session-2",
			taskIds: ["task-1"],
			createdAt: "2026-07-28T00:01:00.000Z",
			updatedAt: "2026-07-28T00:01:00.000Z",
			state: "processing",
			attempt: 2,
			nextEligibleAt: null,
			actualModel: null,
			error: null,
			retryOfRunId: "run-1",
		});
		const process = vi.fn(async () => completedSummary("grandchild-1"));
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		await coordinator.retryEligible();
		expect(process).toHaveBeenCalledTimes(1);
		expect(process).toHaveBeenCalledWith({
			taskKeys: ["id:task-1"],
			retryOfRunId: "child-1",
			priorAttempt: 2,
		});
		expect((await runs.get("run-1")).state).toBe("superseded");
		expect((await runs.get("child-1")).state).toBe("superseded");
	});

	it("does not duplicate a completed child when a crash preceded parent terminalization", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs);
		await runs.create({
			schemaVersion: 1,
			id: "completed-child",
			sessionId: "session-2",
			taskIds: ["task-1"],
			createdAt: "2026-07-28T00:01:00.000Z",
			updatedAt: "2026-07-28T00:01:30.000Z",
			state: "completed",
			attempt: 2,
			nextEligibleAt: null,
			actualModel: "free/model",
			error: null,
			retryOfRunId: "run-1",
		});
		const process = vi.fn();
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		});

		expect(await coordinator.retryEligible()).toEqual([]);
		expect(process).not.toHaveBeenCalled();
		expect((await runs.get("run-1")).state).toBe("superseded");
	});

	it("fails a stale recovery source with no live task instead of completing it", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs, { state: "processing", nextEligibleAt: null });
		const process = vi.fn();
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => null,
			now: () => new Date(NOW),
		});
		expect(await coordinator.retryEligible()).toEqual([]);
		expect(process).not.toHaveBeenCalled();
		const stale = await runs.get("run-1");
		expect(stale.state).toBe("failed");
		expect(stale.error).toMatchObject({ code: "unknown", retryable: false });
	});

	it("fails closed when concurrent shared-vault recovery claims conflict", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs);
		const process = vi.fn(async () => completedSummary());
		const common = {
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
		};
		const first = new DurableQueueCoordinator({ ...common, clientId: "desktop-a" });
		const second = new DurableQueueCoordinator({ ...common, clientId: "desktop-b" });
		await Promise.all([first.recover(), second.recover()]);
		expect(process).not.toHaveBeenCalled();
	});

	it("permits a new claimant only after an observed lease expires", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await createRun(runs);
		const first = await runs.acquireRecoveryLease(
			"run-1",
			"desktop-a",
			"2026-07-28T00:20:00.000Z",
			60_000,
		);
		expect(first.lease).not.toBeNull();
		expect(
			(
				await runs.acquireRecoveryLease(
					"run-1",
					"desktop-b",
					"2026-07-28T00:20:30.000Z",
					60_000,
				)
			).lease,
		).toBeNull();
		expect(
			(
				await runs.acquireRecoveryLease(
					"run-1",
					"desktop-b",
					"2026-07-28T00:21:01.000Z",
					60_000,
				)
			).lease,
		).not.toBeNull();
	});

	it("a restarted client resumes only its own unexpired lease", async () => {
		const runs = new RunRepository(new MemoryFiles());
		await createRun(runs);
		await runs.acquireRecoveryLease("run-1", "desktop-a", NOW, 60_000);
		const process = vi.fn(async () => completedSummary());
		const restarted = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
			clientId: "desktop-a",
		});
		await restarted.recover();
		expect(process).toHaveBeenCalledTimes(1);
	});

	it("fails closed when synced recovery leases conflict", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await createRun(runs);
		files.files.set(
			".gtd-flow/ai/recovery-leases/run-1/a.json",
			JSON.stringify({
				schemaVersion: 1,
				kind: "recovery-lease",
				id: "a",
				runId: "run-1",
				ownerId: "desktop-a",
				claimedAt: "2026-07-28T00:19:00.000Z",
				expiresAt: "2026-07-28T00:21:00.000Z",
			}),
		);
		files.files.set(
			".gtd-flow/ai/recovery-leases/run-1/b.json",
			JSON.stringify({
				schemaVersion: 1,
				kind: "recovery-lease",
				id: "b",
				runId: "run-1",
				ownerId: "desktop-b",
				claimedAt: "2026-07-28T00:19:01.000Z",
				expiresAt: "2026-07-28T00:21:00.000Z",
			}),
		);
		const process = vi.fn(async () => completedSummary());
		const coordinator = new DurableQueueCoordinator({
			runs,
			processor: { process },
			findTask: () => ({ key: "id:task-1" }) as never,
			now: () => new Date(NOW),
			clientId: "desktop-c",
		});
		await coordinator.recover();
		expect(process).not.toHaveBeenCalled();
	});
});
