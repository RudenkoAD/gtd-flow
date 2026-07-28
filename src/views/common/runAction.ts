import { Notice } from "obsidian";

/** The common result shape used by write-capable view ports. */
export interface ActionResult {
	ok: boolean;
	reason?: string;
}

/**
 * Await a UI action, surface both expected refusals and thrown failures, and
 * never leave a rejected fire-and-forget promise unobserved.  Callers that
 * apply optimistic state can use `null`/`ok:false` to restore their snapshot.
 */
export async function runAction<T extends ActionResult>(
	label: string,
	action: () => Promise<T>,
): Promise<T | null> {
	try {
		const result = await action();
		if (!result.ok) new Notice(`GTD Flow: ${label}: ${result.reason ?? "операция отклонена"}`);
		return result;
	} catch (error) {
		new Notice(`GTD Flow: ${label}: ${String(error)}`);
		return null;
	}
}

/** Fire-and-forget only at the markup boundary; the rejection is always handled.
 * The background work may also resolve to a report; only its rejection matters
 * at this boundary. */
export function reportAsync<T>(label: string, action: () => Promise<T>): void {
	try {
		void action().catch((error) => new Notice(`GTD Flow: ${label}: ${String(error)}`));
	} catch (error) {
		// The UI callback may throw before producing the promised work.
		new Notice(`GTD Flow: ${label}: ${String(error)}`);
	}
}

/** Same boundary for ports that reject instead of returning `{ ok }`. */
export async function runVoidAction(label: string, action: () => Promise<void>): Promise<boolean> {
	try {
		await action();
		return true;
	} catch (error) {
		new Notice(`GTD Flow: ${label}: ${String(error)}`);
		return false;
	}
}
