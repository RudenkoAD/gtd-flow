/**
 * Serialize writes of one mutable settings object.
 *
 * Obsidian's `saveData` is asynchronous, while sync results, SettingsTab,
 * onboarding, and background promotion can all request persistence at once.
 * Without a queue, an older write may finish after a newer one and replace the
 * latest data.json. `save` captures immediately; `saveFrom` deliberately waits
 * to capture at the head so it can coordinate with an exclusive transaction.
 * Both enter the same ordered write tail.
 */
export class SerializedSettingsSaver<T> {
	private tail: Promise<void> = Promise.resolve();
	private requestedRevision = 0;

	constructor(
		private readonly write: (snapshot: T) => Promise<void>,
		private readonly clone: (value: T) => T = (value) => structuredClone(value),
	) {}

	save(value: T): Promise<{ latest: boolean }> {
		const snapshot = this.clone(value);
		return this.saveFrom(() => snapshot);
	}

	/**
	 * Queue a save whose snapshot is captured only when it reaches the head.
	 *
	 * This is important for settings transactions which temporarily change the
	 * live object while their durable write is pending: a later ordinary save
	 * must observe the committed value (or the restored value after failure),
	 * never that speculative intermediate state.
	 */
	saveFrom(read: () => T): Promise<{ latest: boolean }> {
		return this.runExclusive(async (persist) => {
			await persist(read());
		}).then(({ latest }) => ({ latest }));
	}

	/**
	 * Serialize a compound live-settings transition with every ordinary save.
	 * `persist` writes directly inside the held queue slot, so callers must not
	 * call save/saveFrom from the operation itself.
	 */
	runExclusive<R>(
		operation: (persist: (value: T) => Promise<void>) => Promise<R>,
	): Promise<{ value: R; latest: boolean }> {
		const revision = ++this.requestedRevision;
		// A failed write rejects its own caller, but must not poison the queue:
		// a later settings change still gets a chance to persist.
		const run = this.tail.then(async () => {
			const value = await operation(async (next) => {
				await this.write(this.clone(next));
			});
			// A successful older snapshot is durable, but callers must not publish
			// it through views that read the already-mutated live settings object.
			return { value, latest: revision === this.requestedRevision };
		});
		// Keep the internal tail fulfilled even when the caller observes `run` as
		// rejected. Attaching this handler also prevents a forgotten UI callback
		// from turning the queue's own reference into an unhandled rejection.
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

export interface SerializedCompareAndSetOptions<TPersisted, TValue> {
	read(): TValue;
	expected: TValue;
	next: TValue;
	equal(left: TValue, right: TValue): boolean;
	replace(value: TValue): void;
	/**
	 * Merge a failed/superseded transaction with the latest live value. Callers
	 * can preserve fields changed by a later user action while restoring fields
	 * which still contain this transaction's speculative value.
	 */
	restore(before: TValue, speculative: TValue, current: TValue): TValue;
	persistenceSnapshot(): TPersisted;
}

/**
 * Compare, publish, and durably persist one subset of a larger settings object.
 *
 * The whole operation shares the saver queue with ordinary lazy saves. A user
 * edit to the compared subset while persistence is pending causes a durable
 * compensating write and a false result instead of a false-positive commit.
 */
export function runSerializedCompareAndSet<TPersisted, TValue>(
	saver: SerializedSettingsSaver<TPersisted>,
	options: SerializedCompareAndSetOptions<TPersisted, TValue>,
): Promise<{ value: boolean; latest: boolean }> {
	return saver.runExclusive(async (persist) => {
		const observed = options.read();
		if (!options.equal(observed, options.expected)) return false;
		const before = observed;
		options.replace(options.next);
		try {
			await persist(options.persistenceSnapshot());
			const afterWrite = options.read();
			if (!options.equal(afterWrite, options.next)) {
				options.replace(options.restore(before, options.next, afterWrite));
				await persist(options.persistenceSnapshot());
				return false;
			}
			return true;
		} catch (error) {
			options.replace(options.restore(before, options.next, options.read()));
			// saveData may reject after its atomic replacement reached disk. Restore
			// the live subset first, then make a best-effort compensating write in
			// the same queue slot so a lost acknowledgement cannot leave `next`
			// durable behind a failed migration journal.
			try {
				await persist(options.persistenceSnapshot());
			} catch {
				// Preserve the original transition failure for the migration
				// journal; a later queued ordinary save still gets to retry.
			}
			throw error;
		}
	});
}
