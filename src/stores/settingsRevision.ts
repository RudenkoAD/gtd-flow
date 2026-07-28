import { writable, type Readable } from "svelte/store";

/**
 * A tiny invalidation source for mutable plugin settings.
 *
 * Obsidian settings are intentionally edited in place by SettingsTab. Passing
 * the same object reference to mounted Svelte components therefore cannot tell
 * them that `saveSettings()` changed a query-relevant value. This revision is
 * bumped only after a successful save and lets views recreate the small derived
 * stores that captured a settings value at construction time.
 */
export interface SettingsRevision {
	readonly store: Readable<number>;
	notifySaved(): void;
}

export function createSettingsRevision(): SettingsRevision {
	const revision = writable(0);
	return {
		store: { subscribe: revision.subscribe },
		notifySaved: () => revision.update((n) => n + 1),
	};
}
