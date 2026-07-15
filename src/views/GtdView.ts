import { ItemView, WorkspaceLeaf } from "obsidian";
import { mount, unmount, type Component } from "svelte";
import Placeholder from "./common/Placeholder.svelte";
import type { ViewMeta } from "./registry";
import type GtdFlowPlugin from "../main";

/**
 * Базовый ItemView всех шести видов: монтирует Svelte-компонент в onOpen,
 * размонтирует в onClose. Конкретные виды переопределяют component()/props().
 */
export class GtdView extends ItemView {
	private mounted: Record<string, unknown> | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: GtdFlowPlugin,
		readonly meta: ViewMeta,
	) {
		super(leaf);
	}

	getViewType(): string {
		return this.meta.type;
	}

	getDisplayText(): string {
		return this.meta.displayText;
	}

	getIcon(): string {
		return this.meta.icon;
	}

	/** Компонент вида; пока у всех — заглушка, виды подменяют по мере реализации этапов. */
	protected component(): Component<any> {
		return Placeholder as unknown as Component<any>;
	}

	protected props(): Record<string, unknown> {
		return { title: this.meta.displayText };
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("gtd-flow-view");
		this.mounted = mount(this.component(), {
			target: this.contentEl,
			props: this.props(),
		});
	}

	async onClose(): Promise<void> {
		if (this.mounted) {
			await unmount(this.mounted);
			this.mounted = null;
		}
		this.contentEl.removeClass("gtd-flow-view");
	}
}
