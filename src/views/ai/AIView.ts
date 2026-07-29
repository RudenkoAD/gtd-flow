import type { Component } from "svelte";
import type GtdFlowPlugin from "../../main";
import { GtdView } from "../GtdView";
import { VIEW_META } from "../registry";
import AI from "./AI.svelte";
import type { AIViewPort } from "./aiViewModel";

/**
 * Embedded desktop conversation.  `aiViewPort` remains optional while the
 * runtime integration is assembled, so opening the registered view is safe on
 * existing installations and in tests.
 */
export class AIView extends GtdView {
	protected static override staticMeta = VIEW_META.ai;

	protected override component(): Component<Record<string, unknown>> {
		return AI as unknown as Component<Record<string, unknown>>;
	}

	protected override props(): Record<string, unknown> {
		const plugin = this.plugin as GtdFlowPlugin & { aiViewPort?: AIViewPort };
		return { port: plugin.aiViewPort ?? null };
	}
}
