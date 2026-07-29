import { describe, expect, it } from "vitest";
import type { AtomicFilePort } from "./AtomicFilePort";
import { FeedbackRepository } from "./FeedbackRepository";
import { activeLeases, RunRepository } from "./RunRepository";
import { ScopeCatalogRepository } from "./ScopeCatalogRepository";
import { SessionRepository } from "./SessionRepository";

class MemoryFiles implements AtomicFilePort {
	readonly data = new Map<string, string>();
	readonly atomicWrites: string[] = [];
	readonly newWrites: string[] = [];
	throwAfterAtomicOnceFor: string | null = null;

	async read(path: string): Promise<string | null> {
		return this.data.get(path) ?? null;
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		this.data.set(path, content);
		this.atomicWrites.push(path);
		if (this.throwAfterAtomicOnceFor === path) {
			this.throwAfterAtomicOnceFor = null;
			throw new Error("atomic-write-ack-lost");
		}
	}

	async writeNew(path: string, content: string): Promise<void> {
		if (this.data.has(path)) throw new Error("already-exists");
		this.data.set(path, content);
		this.newWrites.push(path);
	}

	async list(pathPrefix: string): Promise<string[]> {
		return [...this.data.keys()].filter((path) => path.startsWith(`${pathPrefix}/`));
	}
}

const timestamp = "2026-07-28T12:00:00.000Z";

describe("synced AI repositories", () => {
	it("stores sessions as a deduplicated JSONL record stream", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		await sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: "session-1",
			sessionKind: "chat",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const message = {
			id: "message-1",
			role: "user" as const,
			content: "kept in session",
			createdAt: timestamp,
		};
		await sessions.appendMessage("session-1", message, timestamp);
		await sessions.appendMessage("session-1", message, timestamp);
		const loaded = await sessions.load("session-1");
		expect(loaded.messages).toHaveLength(1);
		expect(loaded.messages[0]?.message.content).toBe("kept in session");
	});

	it("merges independently synced message shards and reads legacy JSONL sessions", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		await sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: "session-2",
			sessionKind: "chat",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await Promise.all([
			sessions.appendMessage(
				"session-2",
				{
					id: "message-b",
					role: "assistant",
					content: "later",
					createdAt: "2026-07-28T12:02:00.000Z",
					provider: "openrouter",
					model: "free/actual-model",
				},
				"2026-07-28T12:02:00.000Z",
			),
			sessions.appendMessage(
				"session-2",
				{
					id: "message-a",
					role: "user",
					content: "earlier",
					createdAt: "2026-07-28T12:01:00.000Z",
				},
				"2026-07-28T12:01:00.000Z",
			),
		]);
		expect(
			(await sessions.load("session-2")).messages.map((record) => record.message.id),
		).toEqual(["message-a", "message-b"]);

		files.data.set(
			".gtd-flow/ai/sessions/legacy.jsonl",
			`${JSON.stringify({ kind: "session", schemaVersion: 1, id: "legacy", sessionKind: "chat", createdAt: timestamp, updatedAt: timestamp })}\n${JSON.stringify({ kind: "message", schemaVersion: 1, sessionId: "legacy", sequence: 0, message: { id: "legacy-message", role: "user", content: "old", createdAt: timestamp } })}\n`,
		);
		expect((await sessions.load("legacy")).messages[0]?.message.content).toBe("old");
	});

	it("assembles offset message timestamps by instant", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		await sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: "offset-session",
			sessionKind: "chat",
			createdAt: "2026-07-28T00:00:00.000Z",
			updatedAt: "2026-07-28T00:00:00.000Z",
		});
		await sessions.appendMessage(
			"offset-session",
			{
				id: "later",
				role: "assistant",
				content: "later by instant",
				createdAt: "2026-07-28T01:30:00.000Z",
				provider: "openrouter",
				model: "free/actual-model",
			},
			"2026-07-28T01:30:00.000Z",
		);
		await sessions.appendMessage(
			"offset-session",
			{
				id: "lexically-later",
				role: "user",
				content: "earlier by instant",
				createdAt: "2026-07-28T03:00:00.000+02:00",
			},
			"2026-07-28T03:00:00.000+02:00",
		);
		expect(
			(await sessions.load("offset-session")).messages.map((record) => record.message.id),
		).toEqual(["lexically-later", "later"]);
	});

	it("persists run transitions and immutable feedback below .gtd-flow", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await runs.create({
			schemaVersion: 1,
			id: "run-1",
			sessionId: "session-1",
			taskIds: ["task-1"],
			createdAt: timestamp,
			updatedAt: timestamp,
			state: "queued",
			attempt: 0,
			nextEligibleAt: null,
			actualModel: null,
			error: null,
		});
		const processing = await runs.claimNext("2026-07-28T12:01:00.000Z");
		expect(processing).toMatchObject({ state: "processing", attempt: 1 });

		const feedback = new FeedbackRepository(files);
		const event = {
			schemaVersion: 1 as const,
			id: "event-1",
			kind: "estimate-manual" as const,
			taskId: "task-1",
			occurredAt: timestamp,
			runId: "run-1",
			sessionId: "session-1",
			field: "duration" as const,
			prediction: null,
		};
		await feedback.create(event);
		await expect(feedback.create(event)).rejects.toMatchObject({ code: "conflict" });
		expect(files.newWrites).toContain(".gtd-flow/ai/feedback/event-1.json");
		expect(files.atomicWrites).not.toContain(".gtd-flow/ai/feedback/event-1.json");
		expect([...files.data.keys()]).toEqual(
			expect.arrayContaining([
				".gtd-flow/ai/runs/run-1.json",
				".gtd-flow/ai/feedback/event-1.json",
			]),
		);
	});

	it("fails closed on conflicting or misplaced immutable session messages", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		await sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: "session-conflict",
			sessionKind: "chat",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const message = {
			id: "message-1",
			role: "user" as const,
			content: "first",
			createdAt: timestamp,
		};
		await sessions.appendMessage("session-conflict", message, timestamp);
		const stored = JSON.parse(
			files.data.get(".gtd-flow/ai/sessions/session-conflict/messages/message-1.json")!,
		) as Record<string, unknown>;
		files.data.set(
			".gtd-flow/ai/sessions/session-conflict/messages/forged-name.json",
			JSON.stringify(stored),
		);
		await expect(sessions.load("session-conflict")).rejects.toMatchObject({
			code: "invalid-record",
		});

		files.data.delete(".gtd-flow/ai/sessions/session-conflict/messages/forged-name.json");
		files.data.set(
			".gtd-flow/ai/sessions/session-conflict.jsonl",
			[
				JSON.stringify({
					kind: "session",
					schemaVersion: 1,
					id: "session-conflict",
					sessionKind: "chat",
					createdAt: timestamp,
					updatedAt: timestamp,
				}),
				JSON.stringify({
					...stored,
					recordedAt: undefined,
					message: { ...message, content: "conflicting synced content" },
				}),
			].join("\n"),
		);
		await expect(sessions.load("session-conflict")).rejects.toMatchObject({
			code: "invalid-record",
		});
	});

	it("rejects structured credential material before writing a session shard", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		await sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: "session-secrets",
			sessionKind: "chat",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await expect(
			sessions.appendMessage(
				"session-secrets",
				{
					id: "assistant-1",
					role: "assistant",
					content: "tool proposal",
					createdAt: timestamp,
					provider: "openrouter",
					model: "free/actual-model",
					toolCalls: [
						{
							id: "call-1",
							name: "some-tool",
							arguments: { refreshToken: "must-not-sync" },
						},
					],
				},
				timestamp,
			),
		).rejects.toThrow();
		expect(
			files.data.has(".gtd-flow/ai/sessions/session-secrets/messages/assistant-1.json"),
		).toBe(false);
	});

	it("requires actual provider and model provenance on new assistant shards", async () => {
		const files = new MemoryFiles();
		const sessions = new SessionRepository(files);
		await sessions.create({
			kind: "session",
			schemaVersion: 1,
			id: "session-provenance",
			sessionKind: "chat",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await expect(
			sessions.appendMessage(
				"session-provenance",
				{
					id: "assistant-without-model",
					role: "assistant",
					content: "response",
					createdAt: timestamp,
				},
				timestamp,
			),
		).rejects.toMatchObject({ code: "invalid-record" });
		expect(
			files.data.has(
				".gtd-flow/ai/sessions/session-provenance/messages/assistant-without-model.json",
			),
		).toBe(false);
	});

	it("fails recovery closed on malformed lease siblings and validates lease ownership inputs", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await runs.create({
			schemaVersion: 1,
			id: "lease-run",
			sessionId: "session-1",
			taskIds: ["task-1"],
			createdAt: timestamp,
			updatedAt: timestamp,
			state: "processing",
			attempt: 1,
			nextEligibleAt: null,
			actualModel: null,
			error: null,
		});
		files.data.set(".gtd-flow/ai/recovery-leases/lease-run/unexpected.txt", "not a lease");
		await expect(
			runs.acquireRecoveryLease("lease-run", "desktop-a", timestamp, 60_000),
		).resolves.toEqual({ lease: null, safe: false });
		files.data.delete(".gtd-flow/ai/recovery-leases/lease-run/unexpected.txt");
		await expect(
			runs.acquireRecoveryLease("lease-run", "desktop-a", timestamp, 0),
		).rejects.toThrow("invalid-recovery-lease-duration");
		await expect(
			runs.acquireRecoveryLease("missing-run", "desktop-a", timestamp, 60_000),
		).rejects.toMatchObject({ code: "not-found" });
	});

	it("compares offset lease timestamps chronologically rather than lexically", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await runs.create({
			schemaVersion: 1,
			id: "offset-run",
			sessionId: "session-1",
			taskIds: ["task-1"],
			createdAt: "2026-07-27T23:00:00.000Z",
			updatedAt: "2026-07-27T23:00:00.000Z",
			state: "processing",
			attempt: 1,
			nextEligibleAt: null,
			actualModel: null,
			error: null,
		});
		files.data.set(
			".gtd-flow/ai/recovery-leases/offset-run/old-lease.json",
			JSON.stringify({
				schemaVersion: 1,
				kind: "recovery-lease",
				id: "old-lease",
				runId: "offset-run",
				ownerId: "desktop-a",
				claimedAt: "2026-07-27T23:00:00.000Z",
				expiresAt: "2026-07-28T02:00:00.000+02:00",
			}),
		);
		const claimed = await runs.acquireRecoveryLease(
			"offset-run",
			"desktop-b",
			"2026-07-28T00:30:00.000Z",
			60_000,
		);
		expect(claimed.safe).toBe(true);
		expect(claimed.lease?.ownerId).toBe("desktop-b");
	});

	it("orders active recovery claims by instant across timestamp offsets", () => {
		const leases = activeLeases(
			[
				{
					schemaVersion: 1,
					kind: "recovery-lease",
					id: "lexically-first",
					runId: "offset-run",
					ownerId: "desktop-a",
					claimedAt: "2026-07-28T00:30:00.000Z",
					expiresAt: "2026-07-28T01:30:00.000Z",
				},
				{
					schemaVersion: 1,
					kind: "recovery-lease",
					id: "chronologically-first",
					runId: "offset-run",
					ownerId: "desktop-b",
					claimedAt: "2026-07-28T02:00:00.000+02:00",
					expiresAt: "2026-07-28T03:00:00.000+02:00",
				},
			],
			"2026-07-27T23:59:00.000Z",
		);
		expect(leases.map((lease) => lease.id)).toEqual([
			"chronologically-first",
			"lexically-first",
		]);
	});

	it("rejects ambiguous scope catalogs and duplicate run task IDs", async () => {
		const files = new MemoryFiles();
		const scopes = new ScopeCatalogRepository(files);
		await expect(
			scopes.save({
				schemaVersion: 1,
				scopes: [
					{ id: "work", name: "Work", order: 0, archived: false },
					{ id: "life", name: "work", order: 1, archived: false },
				],
			}),
		).rejects.toThrow();
		await expect(
			new RunRepository(files).create({
				schemaVersion: 1,
				id: "duplicate-tasks",
				sessionId: "session-1",
				taskIds: ["task-1", "task-1"],
				createdAt: timestamp,
				updatedAt: timestamp,
				state: "queued",
				attempt: 0,
				nextEligibleAt: null,
				actualModel: null,
				error: null,
			}),
		).rejects.toThrow();
		await expect(
			new RunRepository(files).create({
				schemaVersion: 1,
				id: "completed-without-model",
				sessionId: "session-1",
				taskIds: ["task-1"],
				createdAt: timestamp,
				updatedAt: timestamp,
				state: "completed",
				attempt: 1,
				nextEligibleAt: null,
				actualModel: null,
				error: null,
			}),
		).rejects.toThrow();
	});

	it("loads pre-lineage v1 run records with a null retry parent", async () => {
		const files = new MemoryFiles();
		files.data.set(
			".gtd-flow/ai/runs/old-run.json",
			JSON.stringify({
				schemaVersion: 1,
				id: "old-run",
				sessionId: "session-1",
				taskIds: ["task-1"],
				createdAt: timestamp,
				updatedAt: timestamp,
				state: "rate_limited",
				attempt: 1,
				nextEligibleAt: "2026-07-28T12:05:00.000Z",
				actualModel: null,
				error: null,
			}),
		);
		const run = await new RunRepository(files).get("old-run");
		expect(run.retryOfRunId).toBeNull();
		expect(run.requestContext).toEqual({
			onlyFields: null,
			unlockFields: [],
			questionContext: null,
		});
	});

	it("accepts an exact run transition committed before acknowledgement loss", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await runs.create({
			schemaVersion: 1,
			id: "ack-run",
			sessionId: "session-1",
			taskIds: ["task-1"],
			createdAt: timestamp,
			updatedAt: timestamp,
			state: "queued",
			attempt: 0,
			nextEligibleAt: null,
			actualModel: null,
			error: null,
		});
		files.throwAfterAtomicOnceFor = ".gtd-flow/ai/runs/ack-run.json";
		await expect(
			runs.transition("ack-run", "processing", "2026-07-28T12:01:00.000Z"),
		).resolves.toMatchObject({ state: "processing", attempt: 1 });
		expect((await runs.get("ack-run")).state).toBe("processing");
	});

	it("rejects a run record stored under a forged immutable ID path", async () => {
		const files = new MemoryFiles();
		const runs = new RunRepository(files);
		await runs.create({
			schemaVersion: 1,
			id: "canonical-run",
			sessionId: "session-1",
			taskIds: ["task-1"],
			createdAt: timestamp,
			updatedAt: timestamp,
			state: "queued",
			attempt: 0,
			nextEligibleAt: null,
			actualModel: null,
			error: null,
		});
		const content = files.data.get(".gtd-flow/ai/runs/canonical-run.json")!;
		files.data.delete(".gtd-flow/ai/runs/canonical-run.json");
		files.data.set(".gtd-flow/ai/runs/forged-run.json", content);
		await expect(runs.list()).rejects.toMatchObject({ code: "invalid-record" });
	});

	it("keeps scopes synced and excludes archived IDs from processing", async () => {
		const scopes = new ScopeCatalogRepository(new MemoryFiles());
		await scopes.save({
			schemaVersion: 1,
			scopes: [
				{ id: "work", name: "Work", order: 0, archived: false },
				{ id: "old", name: "Old", order: 1, archived: true },
			],
		});
		expect(await scopes.activeScopeIds()).toEqual(new Set(["work"]));
		expect(await scopes.hasActiveScopes()).toBe(true);
	});
});
