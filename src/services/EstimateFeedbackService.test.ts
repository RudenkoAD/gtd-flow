import { describe, expect, it } from "vitest";
import type { Task } from "../core/model/Task";
import {
	EstimateFeedbackService,
	FEEDBACK_FOLDER,
	FEEDBACK_OUTBOX_FOLDER,
	parseFeedbackEvent,
	type EstimateCorrectedEvent,
	type EstimateFieldSuggestedEvent,
} from "./EstimateFeedbackService";

class MemoryFeedbackStorage {
	readonly files = new Map<string, string>();
	readonly atomicWrites: string[] = [];
	readonly newWrites: string[] = [];
	failNextNew = false;

	async list(path: string): Promise<string[]> {
		return [...this.files.keys()].filter((file) => file.startsWith(`${path}/`));
	}

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		this.atomicWrites.push(path);
	}

	async writeNew(path: string, content: string): Promise<void> {
		if (this.failNextNew) {
			this.failNextNew = false;
			throw new Error("disk-unavailable");
		}
		if (this.files.has(path)) throw new Error("already-exists");
		this.files.set(path, content);
		this.newWrites.push(path);
	}

	async delete(path: string): Promise<void> {
		this.files.delete(path);
	}
}

function correction(
	id: string,
	kind: "estimate-corrected" | "estimate-manual" | "scope-changed",
	field: "duration" | "scope",
	createdAt: string,
): EstimateCorrectedEvent {
	return {
		schemaVersion: 1,
		id,
		kind,
		taskId: "task-1",
		createdAt,
		runId: null,
		sessionId: null,
		field,
		previousValue: null,
		value: field === "scope" ? "work" : 30,
	};
}

function task(durationMinutes: number | null, scopeId = "work"): Task {
	return {
		taskId: "task-1",
		durationMinutes,
		cognitiveIntensity: 2,
		emotionalIntensity: 1,
		physicalIntensity: 0,
		scopeId,
	} as Task;
}

function fieldSuggestion(
	id = "chat-duration",
	value: number | string | null = 45,
): EstimateFieldSuggestedEvent {
	return {
		schemaVersion: 1,
		id,
		kind: "estimate-field-suggested",
		taskId: "task-1",
		createdAt: "2026-07-28T00:00:00.000Z",
		runId: null,
		sessionId: "chat-1",
		field: "duration",
		value,
		taskSnapshot: {
			text: "Reconcile invoices",
			tags: ["finance"],
			container: "inbox",
			heading: null,
			recurrence: null,
		},
		confidence: 0,
		actualModel: "free/model",
		provider: "openrouter",
		promptVersion: "chat-tools-v1",
		schemaVersionId: "chat-tool-metadata-v1",
		retrievedExampleIds: [],
	};
}

describe("EstimateFeedbackService", () => {
	it("writes immutable per-event files and never overwrites", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction(
			"correction-1",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		await expect(service.append(event)).resolves.toBe(`${FEEDBACK_FOLDER}/correction-1.json`);
		await expect(service.append(event)).rejects.toThrow("already-exists");
	});

	it("reads deterministically and isolates malformed synced files", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		await service.append(
			correction("later", "estimate-manual", "duration", "2026-07-29T00:00:00.000Z"),
		);
		await service.append(
			correction("earlier", "scope-changed", "scope", "2026-07-28T00:00:00.000Z"),
		);
		storage.files.set(`${FEEDBACK_FOLDER}/bad.json`, "{");
		const result = await service.readAll();
		expect(result.events.map((event) => event.id)).toEqual(["earlier", "later"]);
		expect(result.invalidPaths).toEqual([`${FEEDBACK_FOLDER}/bad.json`]);
	});

	it("reconstructs independent locks and explicit unlocks", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		await service.append(
			correction(
				"duration-manual",
				"estimate-manual",
				"duration",
				"2026-07-28T00:00:00.000Z",
			),
		);
		await service.append({
			schemaVersion: 1,
			id: "unlock-duration",
			kind: "field-unlocked",
			taskId: "task-1",
			createdAt: "2026-07-28T00:01:00.000Z",
			runId: null,
			sessionId: null,
			fields: ["duration"],
		});
		await service.append(
			correction("scope-manual", "scope-changed", "scope", "2026-07-28T00:02:00.000Z"),
		);
		const provenance = await service.provenanceForTask("task-1", "2026-07-28T00:03:00.000Z");
		expect(provenance.fields.duration).toMatchObject({ owner: "ai", locked: false });
		expect(provenance.fields.scope).toMatchObject({ owner: "user", locked: true });
	});

	it("prepares before publishing an immutable correction and then finalizes", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction(
			"prepared-correction",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		event.previousValue = 30;
		event.value = 45;
		await service.prepareMutation(event, [
			{ field: "duration", previousValue: 30, intendedValue: 45 },
		]);
		expect(storage.newWrites).toContain(`${FEEDBACK_OUTBOX_FOLDER}/${event.id}.json`);
		expect(storage.atomicWrites).not.toContain(`${FEEDBACK_OUTBOX_FOLDER}/${event.id}.json`);
		expect(storage.files.has(`${FEEDBACK_FOLDER}/${event.id}.json`)).toBe(false);
		expect(storage.files.has(`${FEEDBACK_OUTBOX_FOLDER}/${event.id}.json`)).toBe(true);

		await service.commitPrepared(event.id);
		expect(storage.files.has(`${FEEDBACK_FOLDER}/${event.id}.json`)).toBe(true);
		expect(storage.files.has(`${FEEDBACK_OUTBOX_FOLDER}/${event.id}.json`)).toBe(false);
	});

	it("persists a field-local chat suggestion without inventing the other estimates", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = fieldSuggestion();

		expect(parseFeedbackEvent(event)).toEqual(event);
		await service.prepareMutation(event, [
			{ field: "duration", previousValue: null, intendedValue: 45 },
		]);
		await service.commitPrepared(event.id);

		const provenance = await service.provenanceForTask("task-1", "2026-07-28T00:01:00.000Z");
		expect(provenance.fields.duration).toMatchObject({
			owner: "ai",
			locked: false,
			lastPredictionEventId: event.id,
		});
		expect((await service.readAll()).events).toEqual([event]);
	});

	it("recovers matching writes, cancels clearly unwritten ones, and retains conflicts", async () => {
		const storage = new MemoryFeedbackStorage();
		let now = new Date("2026-07-28T00:05:00.000Z");
		const service = new EstimateFeedbackService(storage, () => now);
		const applied = correction(
			"applied",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		applied.previousValue = 30;
		applied.value = 45;
		const unwritten = correction(
			"unwritten",
			"scope-changed",
			"scope",
			"2026-07-28T00:01:00.000Z",
		);
		unwritten.previousValue = "work";
		unwritten.value = "life";
		const conflicted = correction(
			"conflicted",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:02:00.000Z",
		);
		conflicted.previousValue = 30;
		conflicted.value = 60;
		await service.prepareMutation(applied, [
			{ field: "duration", previousValue: 30, intendedValue: 45 },
		]);
		await service.prepareMutation(unwritten, [
			{ field: "scope", previousValue: "work", intendedValue: "life" },
		]);
		await service.prepareMutation(conflicted, [
			{ field: "duration", previousValue: 30, intendedValue: 60 },
		]);

		const tasks = new Map<string, Task>([["task-1", task(45, "work")]]);
		const recovered = await service.recoverPending((taskId) => tasks.get(taskId) ?? null);
		expect(recovered).toMatchObject({
			committed: 1,
			cancelled: 1,
			conflicts: [
				{
					id: "conflicted",
					taskId: "task-1",
					fields: ["duration"],
					reason: "ambiguous-task-state",
				},
			],
			invalidPaths: [],
		});
		expect(storage.files.has(`${FEEDBACK_FOLDER}/applied.json`)).toBe(true);
		expect(storage.files.has(`${FEEDBACK_OUTBOX_FOLDER}/unwritten.json`)).toBe(false);
		expect(
			JSON.parse(storage.files.get(`${FEEDBACK_OUTBOX_FOLDER}/conflicted.json`)!),
		).toMatchObject({
			state: "conflict",
			updatedAt: "2026-07-28T00:05:00.000Z",
			conflictReason: "ambiguous-task-state",
		});

		now = new Date("2026-07-28T00:06:00.000Z");
		tasks.set("task-1", task(60, "life"));
		const repeated = await service.recoverPending((taskId) => tasks.get(taskId) ?? null);
		expect(repeated.conflicts).toEqual(recovered.conflicts);
		expect(storage.files.has(`${FEEDBACK_FOLDER}/conflicted.json`)).toBe(false);
	});

	it("finalizes idempotently when canonical feedback was written before a crash", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction(
			"already-published",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		event.previousValue = 30;
		event.value = 45;
		await service.prepareMutation(event, [
			{ field: "duration", previousValue: 30, intendedValue: 45 },
		]);
		await service.append(event);

		await expect(service.recoverPending(() => task(30))).resolves.toMatchObject({
			committed: 1,
			cancelled: 0,
			conflicts: [],
		});
		expect(storage.files.has(`${FEEDBACK_OUTBOX_FOLDER}/already-published.json`)).toBe(false);
	});

	it("keeps a prepared record retryable when canonical storage is temporarily unavailable", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction(
			"retryable-canonical",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		event.previousValue = 30;
		event.value = 45;
		await service.prepareMutation(event, [
			{ field: "duration", previousValue: 30, intendedValue: 45 },
		]);
		storage.failNextNew = true;
		await expect(service.commitPrepared(event.id)).rejects.toThrow("disk-unavailable");
		expect(
			JSON.parse(storage.files.get(`${FEEDBACK_OUTBOX_FOLDER}/${event.id}.json`)!),
		).toMatchObject({ state: "prepared", conflictReason: null });

		await expect(service.recoverPending(() => task(45))).resolves.toMatchObject({
			committed: 1,
			conflicts: [],
		});
		expect(storage.files.has(`${FEEDBACK_FOLDER}/${event.id}.json`)).toBe(true);
	});

	it("preserves a no-op-only recovery as ambiguous because it has no write evidence", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction(
			"ambiguous-no-op",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		event.previousValue = 30;
		event.value = 30;
		await service.prepareMutation(event, [
			{ field: "duration", previousValue: 30, intendedValue: 30 },
		]);
		await expect(service.recoverPending(() => task(30))).resolves.toMatchObject({
			committed: 0,
			cancelled: 0,
			conflicts: [
				{
					id: "ambiguous-no-op",
					reason: "ambiguous-task-state",
				},
			],
		});
	});

	it("locks conflicted outbox fields without publishing their ambiguous label", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const conflict = correction(
			"ambiguous-conflict",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		conflict.previousValue = 30;
		conflict.value = 45;
		await service.prepareMutation(conflict, [
			{ field: "duration", previousValue: 30, intendedValue: 45 },
		]);
		await service.recoverPending(() => task(60));

		expect(await service.readAll()).toMatchObject({ events: [] });
		const provenance = await service.provenanceForTask("task-1", "2026-07-28T00:02:00.000Z");
		expect(provenance.fields.duration).toMatchObject({ owner: "user", locked: true });
	});

	it("reports and exports outbox health, while clear retains conflict safety locks", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const conflict = correction(
			"export-conflict",
			"estimate-corrected",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		conflict.previousValue = 30;
		conflict.value = 45;
		await service.prepareMutation(conflict, [
			{ field: "duration", previousValue: 30, intendedValue: 45 },
		]);
		await service.recoverPending(() => task(60));
		const pending = correction(
			"export-pending",
			"estimate-manual",
			"duration",
			"2026-07-28T00:01:00.000Z",
		);
		await service.prepareMutation(pending, [
			{ field: "duration", previousValue: null, intendedValue: 30 },
		]);
		const conflictedPath = `${FEEDBACK_OUTBOX_FOLDER}/export-conflict.json`;
		storage.files.set(
			`${FEEDBACK_OUTBOX_FOLDER}/credential-shaped.json`,
			JSON.stringify({
				...JSON.parse(storage.files.get(conflictedPath)!),
				apiKey: "never-export",
			}),
		);
		storage.files.set(`${FEEDBACK_OUTBOX_FOLDER}/invalid.json`, "not-json");

		await expect(service.outboxHealth()).resolves.toEqual({
			pending: 1,
			conflicts: 1,
			invalidRecords: 2,
		});
		const exported = JSON.parse(await service.exportJson());
		expect(exported).toMatchObject({
			schemaVersion: 2,
			outbox: {
				prepared: [expect.objectContaining({ id: "export-pending" })],
				conflicts: [
					expect.objectContaining({
						id: "export-conflict",
						conflictReason: "ambiguous-task-state",
					}),
				],
				invalidPaths: [
					`${FEEDBACK_OUTBOX_FOLDER}/credential-shaped.json`,
					`${FEEDBACK_OUTBOX_FOLDER}/invalid.json`,
				],
			},
		});
		expect(JSON.stringify(exported)).not.toContain("never-export");

		await service.clearConfirmed();
		await expect(service.outboxHealth()).resolves.toEqual({
			pending: 0,
			conflicts: 0,
			invalidRecords: 0,
		});
		const { events } = await service.readAll();
		expect(events).toEqual([
			expect.objectContaining({
				kind: "field-locked",
				taskId: "task-1",
				fields: ["duration"],
			}),
		]);
		expect(events[0]).not.toHaveProperty("value");
	});

	it("exports inspectable history and clears labels plus pending recovery material", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction("one", "estimate-manual", "duration", "2026-07-28T00:00:00.000Z");
		await service.append(event);
		const pending = correction(
			"pending",
			"estimate-manual",
			"duration",
			"2026-07-28T00:01:00.000Z",
		);
		await service.prepareMutation(pending, [
			{ field: "duration", previousValue: null, intendedValue: 30 },
		]);
		storage.files.set(`${FEEDBACK_FOLDER}/keep.txt`, "not an event");
		expect(JSON.parse(await service.exportJson()).events).toHaveLength(1);
		await expect(service.clearConfirmed()).resolves.toBe(1);
		expect(storage.files.has(`${FEEDBACK_FOLDER}/keep.txt`)).toBe(true);
		expect(storage.files.has(`${FEEDBACK_FOLDER}/one.json`)).toBe(false);
		expect(storage.files.has(`${FEEDBACK_OUTBOX_FOLDER}/pending.json`)).toBe(false);
		await expect(service.recoverPending(() => task(30))).resolves.toMatchObject({
			committed: 0,
			conflicts: [],
		});
		const provenance = await service.provenanceForTask("task-1", "2026-07-28T00:02:00.000Z");
		expect(provenance.fields.duration).toMatchObject({ owner: "user", locked: true });
	});

	it("isolates a valid event stored under a forged immutable filename", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		const event = correction(
			"canonical-id",
			"estimate-manual",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		await service.append(event);
		const content = storage.files.get(`${FEEDBACK_FOLDER}/canonical-id.json`)!;
		storage.files.delete(`${FEEDBACK_FOLDER}/canonical-id.json`);
		storage.files.set(`${FEEDBACK_FOLDER}/forged-name.json`, content);

		await expect(service.readAll()).resolves.toEqual({
			events: [],
			invalidPaths: [`${FEEDBACK_FOLDER}/forged-name.json`],
		});
	});

	it("orders offset timestamps chronologically", async () => {
		const storage = new MemoryFeedbackStorage();
		const service = new EstimateFeedbackService(storage);
		await service.append(
			correction(
				"chronologically-later",
				"estimate-manual",
				"duration",
				"2026-07-28T01:30:00.000Z",
			),
		);
		await service.append(
			correction(
				"lexically-later",
				"estimate-manual",
				"duration",
				"2026-07-28T03:00:00.000+02:00",
			),
		);
		expect((await service.readAll()).events.map((event) => event.id)).toEqual([
			"lexically-later",
			"chronologically-later",
		]);
	});
});

describe("feedback schema", () => {
	it("rejects credential-shaped and structurally invalid events", () => {
		expect(parseFeedbackEvent({ schemaVersion: 1, kind: "estimate-manual" })).toBeNull();
		expect(
			parseFeedbackEvent({
				...correction("bad/id", "estimate-manual", "duration", "2026-07-28T00:00:00.000Z"),
				apiKey: "must-not-be-stored",
			}),
		).toBeNull();
	});

	it("enforces canonical IDs, timestamps, field domains, and credential exclusion", () => {
		const base = correction(
			"strict-event",
			"estimate-manual",
			"duration",
			"2026-07-28T00:00:00.000Z",
		);
		expect(parseFeedbackEvent({ ...base, createdAt: "not-a-date" })).toBeNull();
		expect(parseFeedbackEvent({ ...base, taskId: "../task" })).toBeNull();
		expect(parseFeedbackEvent({ ...base, value: 37 * 60 })).toBeNull();
		expect(parseFeedbackEvent({ ...base, value: 48 * 60 })).toMatchObject({
			value: 48 * 60,
		});
		expect(
			parseFeedbackEvent({
				...base,
				taskSnapshot: {
					text: "Task",
					tags: [],
					container: "inbox",
					heading: null,
					recurrence: null,
					privateKey: "must-not-sync",
				},
			}),
		).toBeNull();
	});
});
