import type { EstimateField } from "../core/estimates/provenance";
import type { Task } from "../core/model/Task";

export type EstimateFieldValue = number | string | null;

export interface UserFieldEdit {
	task: Task;
	field: EstimateField;
	previousValue: EstimateFieldValue;
	value: EstimateFieldValue;
}

interface ExpectedValue {
	value: EstimateFieldValue;
	expiresAt: number;
}

/**
 * Compares stable-ID task snapshots. Changes that cannot be matched to a
 * registered agent mutation are conservatively classified as user edits.
 */
export class FieldOwnershipMonitor {
	private previous = new Map<string, Task>();
	private readonly expected = new Map<string, Partial<Record<EstimateField, ExpectedValue>>>();
	private pending: Promise<void> = Promise.resolve();
	private pendingFailure: unknown = null;

	constructor(
		private readonly onUserEdit: (edit: UserFieldEdit) => Promise<void>,
		private readonly nowMs: () => number = () => Date.now(),
	) {}

	expectAiPatch(
		taskId: string,
		patch: Partial<Record<EstimateField, EstimateFieldValue>>,
		ttlMs = 5 * 60_000,
	): () => void {
		const state = this.expected.get(taskId) ?? {};
		const registered: Array<[EstimateField, ExpectedValue]> = [];
		for (const [field, value] of Object.entries(patch) as Array<
			[EstimateField, EstimateFieldValue]
		>) {
			const expected = { value, expiresAt: this.nowMs() + ttlMs };
			state[field] = expected;
			registered.push([field, expected]);
		}
		this.expected.set(taskId, state);
		return () => {
			const current = this.expected.get(taskId);
			if (current === undefined) return;
			for (const [field, expected] of registered) {
				if (current[field] === expected) delete current[field];
			}
			if (Object.keys(current).length === 0) this.expected.delete(taskId);
		};
	}

	observe(tasks: readonly Task[]): void {
		const next = new Map<string, Task>();
		for (const task of tasks) {
			if (task.taskId === null) continue;
			next.set(task.taskId, task);
			const before = this.previous.get(task.taskId);
			if (!before) continue;
			for (const field of FIELDS) {
				const previousValue = fieldValue(before, field);
				const value = fieldValue(task, field);
				if (previousValue === value) continue;
				if (this.consumeExpected(task.taskId, field, value)) continue;
				this.pending = this.pending.then(async () => {
					try {
						await this.onUserEdit({ task, field, previousValue, value });
					} catch (error: unknown) {
						// One persistence failure must not suppress ownership locks for
						// every later field. Surface the first error from drain while
						// keeping the serialized observation queue alive.
						if (this.pendingFailure === null) this.pendingFailure = error;
					}
				});
			}
		}
		this.previous = next;
		this.pruneExpired();
	}

	async drain(): Promise<void> {
		await this.pending;
		if (this.pendingFailure === null) return;
		const error = this.pendingFailure;
		this.pendingFailure = null;
		throw error;
	}

	private consumeExpected(
		taskId: string,
		field: EstimateField,
		value: EstimateFieldValue,
	): boolean {
		const state = this.expected.get(taskId);
		const expected = state?.[field];
		if (!expected || expected.expiresAt < this.nowMs() || expected.value !== value)
			return false;
		delete state![field];
		if (Object.keys(state!).length === 0) this.expected.delete(taskId);
		return true;
	}

	private pruneExpired(): void {
		const now = this.nowMs();
		for (const [taskId, state] of this.expected) {
			for (const field of FIELDS) {
				if (state[field] && state[field]!.expiresAt < now) delete state[field];
			}
			if (Object.keys(state).length === 0) this.expected.delete(taskId);
		}
	}
}

const FIELDS: readonly EstimateField[] = [
	"duration",
	"cognitive",
	"emotional",
	"physical",
	"scope",
];

function fieldValue(task: Task, field: EstimateField): EstimateFieldValue {
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
