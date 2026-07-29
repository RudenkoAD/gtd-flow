import {
	transitionRun,
	type ProcessingRunState,
	type ProcessingRunStateSnapshot,
} from "../processing/ProcessingQueue";
import type { AtomicFilePort } from "./AtomicFilePort";
import { GTD_FLOW_FOLDER, SyncedStorageError, readJsonFile, serializeJson } from "./AtomicFilePort";
import {
	IsoTimestampSchema,
	ProcessingRunV1Schema,
	RecordIdSchema,
	RecoveryLeaseV1Schema,
	type ProcessingRunV1,
	type RecoveryLeaseV1,
} from "./storageSchemas";

const RUNS_FOLDER = `${GTD_FLOW_FOLDER}/ai/runs`;
const RECOVERY_LEASES_FOLDER = `${GTD_FLOW_FOLDER}/ai/recovery-leases`;

export interface RecoveryLeaseAcquireResult {
	lease: RecoveryLeaseV1 | null;
	/** False means an invalid or competing non-expired lease was observed. */
	safe: boolean;
}

/** Durable run records; timer scheduling remains local and is intentionally absent. */
export class RunRepository {
	private readonly runWriteTails = new Map<string, Promise<void>>();

	constructor(private readonly files: AtomicFilePort) {}

	async create(run: ProcessingRunV1): Promise<void> {
		const parsed = ProcessingRunV1Schema.parse(run);
		const path = runPath(parsed.id);
		try {
			await this.files.writeNew(path, serializeJson(parsed));
		} catch (error: unknown) {
			if ((await this.files.read(path)) !== null) {
				throw new SyncedStorageError("conflict");
			}
			throw error;
		}
	}

	async get(id: string): Promise<ProcessingRunV1> {
		const data = await readJsonFile(this.files, runPath(id));
		if (data === null) throw new SyncedStorageError("not-found");
		return ProcessingRunV1Schema.parse(data);
	}

	async list(): Promise<ProcessingRunV1[]> {
		const paths = await this.files.list(RUNS_FOLDER);
		if (paths.some((path) => !path.startsWith(`${RUNS_FOLDER}/`) || !path.endsWith(".json"))) {
			throw new SyncedStorageError("invalid-record");
		}
		const runs = await Promise.all(
			paths.map(async (path) => {
				const data = await readJsonFile(this.files, path);
				if (data === null) throw new SyncedStorageError("invalid-record");
				const run = ProcessingRunV1Schema.parse(data);
				if (path !== runPath(run.id)) throw new SyncedStorageError("invalid-record");
				return run;
			}),
		);
		return runs.sort(
			(left, right) =>
				Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
	}

	async transition(
		id: string,
		to: ProcessingRunState,
		updatedAt: string,
		options: { nextEligibleAt?: string | null } = {},
	): Promise<ProcessingRunV1> {
		const parsedId = RecordIdSchema.parse(id);
		return this.withRunWrite(parsedId, async () => {
			const current = await this.get(parsedId);
			const next = transitionRun(current, to, updatedAt, options);
			const parsed = ProcessingRunV1Schema.parse(next);
			await this.writeRun(parsed);
			return parsed;
		});
	}

	async recordProviderResult(
		id: string,
		result: Pick<ProcessingRunV1, "actualModel" | "error">,
		updatedAt: string,
	): Promise<ProcessingRunV1> {
		const parsedId = RecordIdSchema.parse(id);
		return this.withRunWrite(parsedId, async () => {
			const current = await this.get(parsedId);
			const parsed = ProcessingRunV1Schema.parse({ ...current, ...result, updatedAt });
			await this.writeRun(parsed);
			return parsed;
		});
	}

	async claimNext(updatedAt: string): Promise<ProcessingRunV1 | null> {
		const queued = (await this.list()).find((run) => run.state === "queued");
		if (!queued) return null;
		return this.transition(queued.id, "processing", updatedAt);
	}

	/**
	 * Acquires a recovery lease through an immutable, create-if-absent record.
	 *
	 * A vault adapter can make this atomic for one local vault, but Obsidian sync
	 * has no cross-device CAS/lock API. Therefore an observed competing or invalid
	 * lease always returns `null` (fail closed); callers must verify again just
	 * before sending. Offline devices can still race until their sync provider
	 * delivers both immutable lease files, so this is a best possible vault-only
	 * protocol rather than a distributed exactly-once guarantee.
	 */
	async acquireRecoveryLease(
		runId: string,
		ownerId: string,
		claimedAt: string,
		leaseMs: number,
	): Promise<RecoveryLeaseAcquireResult> {
		const parsedRunId = RecordIdSchema.parse(runId);
		const parsedOwnerId = RecordIdSchema.parse(ownerId);
		const parsedClaimedAt = IsoTimestampSchema.parse(claimedAt);
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
			throw new Error("invalid-recovery-lease-duration");
		}
		await this.get(parsedRunId);
		const before = await this.readRecoveryLeases(parsedRunId);
		if (!before.safe) return { lease: null, safe: false };
		const active = activeLeases(before.leases, parsedClaimedAt);
		if (active.length > 0) {
			const existing = active.length === 1 ? active[0]! : null;
			if (existing !== null && existing.ownerId === parsedOwnerId) {
				return { lease: existing, safe: true };
			}
			return { lease: null, safe: false };
		}
		const lease = RecoveryLeaseV1Schema.parse({
			schemaVersion: 1,
			kind: "recovery-lease",
			id: `lease-${crypto.randomUUID()}`,
			runId: parsedRunId,
			ownerId: parsedOwnerId,
			claimedAt: parsedClaimedAt,
			expiresAt: new Date(Date.parse(parsedClaimedAt) + leaseMs).toISOString(),
		});
		try {
			await this.files.writeNew(recoveryLeasePath(lease), serializeJson(lease));
		} catch (error: unknown) {
			if ((await this.files.read(recoveryLeasePath(lease))) === null) throw error;
		}
		const confirmed = await this.confirmRecoveryLease(lease, parsedClaimedAt);
		return confirmed;
	}

	async confirmRecoveryLease(
		lease: RecoveryLeaseV1,
		now: string,
	): Promise<RecoveryLeaseAcquireResult> {
		const parsedLease = RecoveryLeaseV1Schema.safeParse(lease);
		const parsedNow = IsoTimestampSchema.safeParse(now);
		if (!parsedLease.success || !parsedNow.success) return { lease: null, safe: false };
		const observed = await this.readRecoveryLeases(parsedLease.data.runId);
		if (!observed.safe) return { lease: null, safe: false };
		const active = activeLeases(observed.leases, parsedNow.data);
		if (active.length !== 1 || !sameLease(active[0]!, parsedLease.data)) {
			return { lease: null, safe: false };
		}
		return { lease: active[0]!, safe: true };
	}

	private async readRecoveryLeases(
		runId: string,
	): Promise<{ leases: RecoveryLeaseV1[]; safe: boolean }> {
		try {
			const folder = recoveryLeaseFolder(runId);
			const paths = (await this.files.list(folder)).sort();
			if (paths.some((path) => !path.startsWith(`${folder}/`) || !path.endsWith(".json"))) {
				return { leases: [], safe: false };
			}
			const leases = await Promise.all(
				paths.map(async (path) => {
					const content = await this.files.read(path);
					if (content === null) throw new Error("lease-disappeared");
					const lease = RecoveryLeaseV1Schema.parse(JSON.parse(content));
					if (lease.runId !== runId || path !== recoveryLeasePath(lease)) {
						throw new Error("wrong-lease-path");
					}
					return lease;
				}),
			);
			return { leases, safe: true };
		} catch {
			return { leases: [], safe: false };
		}
	}

	private async withRunWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
		const previous = this.runWriteTails.get(id) ?? Promise.resolve();
		const operation = previous.then(action);
		const tail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.runWriteTails.set(id, tail);
		try {
			return await operation;
		} finally {
			if (this.runWriteTails.get(id) === tail) this.runWriteTails.delete(id);
		}
	}

	private async writeRun(run: ProcessingRunV1): Promise<void> {
		const path = runPath(run.id);
		const serialized = serializeJson(run);
		try {
			await this.files.writeAtomic(path, serialized);
		} catch (error: unknown) {
			// Atomic replacement may commit before the adapter loses its
			// acknowledgement. Accept only the exact intended durable record.
			if ((await this.files.read(path)) !== serialized) throw error;
		}
	}
}

/** Ensures run records satisfy the pure queue state contract. */
export function asRunSnapshot(run: ProcessingRunV1): ProcessingRunStateSnapshot {
	return run;
}

function runPath(id: string): string {
	return `${RUNS_FOLDER}/${RecordIdSchema.parse(id)}.json`;
}

function recoveryLeaseFolder(runId: string): string {
	return `${RECOVERY_LEASES_FOLDER}/${RecordIdSchema.parse(runId)}`;
}

function recoveryLeasePath(lease: RecoveryLeaseV1): string {
	return `${recoveryLeaseFolder(lease.runId)}/${lease.id}.json`;
}

/** @internal Exported so the cross-offset recovery ordering can be verified directly. */
export function activeLeases(leases: readonly RecoveryLeaseV1[], now: string): RecoveryLeaseV1[] {
	const nowMs = Date.parse(now);
	return (
		leases
			// A future-dated lease may be clock skew, not an absence of ownership.
			// Keep it blocking until its explicit expiry rather than risking a send.
			.filter((lease) => Date.parse(lease.expiresAt) > nowMs)
			.slice()
			.sort(
				(left, right) =>
					Date.parse(left.claimedAt) - Date.parse(right.claimedAt) ||
					left.ownerId.localeCompare(right.ownerId) ||
					left.id.localeCompare(right.id),
			)
	);
}

function sameLease(left: RecoveryLeaseV1, right: RecoveryLeaseV1): boolean {
	return (
		left.id === right.id &&
		left.runId === right.runId &&
		left.ownerId === right.ownerId &&
		left.claimedAt === right.claimedAt &&
		left.expiresAt === right.expiresAt
	);
}
