import { describe, expect, it } from "vitest";
import { recoverableRuns } from "../processing/ProcessingQueue";
import type { AtomicFilePort } from "../storage/AtomicFilePort";
import { RunRepository } from "../storage/RunRepository";
import { SessionRepository } from "../storage/SessionRepository";
import { RepositoryProcessingPersistence } from "./ProcessingPersistence";

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

describe("RepositoryProcessingPersistence", () => {
	it("adapts processor lifecycle to durable session and run repositories", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		const runs = new RunRepository(files);
		const persistence = new RepositoryProcessingPersistence(sessions, runs);
		await persistence.createSession({
			id: "session-1",
			kind: "inbox-processing",
			createdAt: "2026-07-28T00:00:00.000Z",
		});
		await persistence.createRun({
			id: "run-1",
			sessionId: "session-1",
			taskIds: ["task-1"],
			createdAt: "2026-07-28T00:00:00.000Z",
			attempt: 2,
			retryOfRunId: "old-run",
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: ["duration"],
				questionContext: "Question: include review?\nAnswer: yes",
			},
		});
		await persistence.transitionRun("run-1", "processing", "2026-07-28T00:01:00.000Z");
		expect(await runs.get("run-1")).toMatchObject({
			state: "processing",
			attempt: 3,
			retryOfRunId: "old-run",
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: ["duration"],
				questionContext: "Question: include review?\nAnswer: yes",
			},
		});
		expect((await sessions.load("session-1")).header.sessionKind).toBe("inbox-processing");
	});

	it("creates an unsent tail batch directly in a durable waiting state", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		const runs = new RunRepository(files);
		const persistence = new RepositoryProcessingPersistence(sessions, runs);
		await persistence.createSession({
			id: "session-tail",
			kind: "inbox-processing",
			createdAt: "2026-07-28T00:00:00.000Z",
		});

		await persistence.createRun({
			id: "run-tail",
			sessionId: "session-tail",
			taskIds: ["task-26"],
			createdAt: "2026-07-28T00:00:00.000Z",
			attempt: 0,
			initialWaiting: {
				state: "rate_limited",
				nextEligibleAt: "2026-07-28T00:02:00.000Z",
			},
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: [],
				questionContext: null,
			},
		});

		const waiting = await runs.get("run-tail");
		expect(waiting).toMatchObject({
			state: "rate_limited",
			attempt: 0,
			nextEligibleAt: "2026-07-28T00:02:00.000Z",
			taskIds: ["task-26"],
			requestContext: {
				onlyFields: ["duration"],
				unlockFields: [],
				questionContext: null,
			},
		});
		expect(
			recoverableRuns([waiting], "2026-07-28T00:02:00.000Z", "2026-07-27T23:52:00.000Z"),
		).toEqual([waiting]);
	});
});
