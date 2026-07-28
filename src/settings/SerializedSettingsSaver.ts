/**
 * Serialize writes of one mutable settings object.
 *
 * Obsidian's `saveData` is asynchronous, while sync results, SettingsTab,
 * onboarding, and background promotion can all request persistence at once.
 * Without a queue, an older write may finish after a newer one and replace the
 * latest data.json. Each request therefore captures its own immutable snapshot
 * immediately and enters one ordered write tail.
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
		const revision = ++this.requestedRevision;
		// A failed write rejects its own caller, but must not poison the queue:
		// a later settings change still gets a chance to persist.
		const run = this.tail.then(async () => {
			await this.write(snapshot);
			// A successful older snapshot is durable, but callers must not publish
			// it through views that read the already-mutated live settings object.
			return { latest: revision === this.requestedRevision };
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
