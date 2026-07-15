import { ItemView, WorkspaceLeaf } from "obsidian";
import { mount, unmount, type Component } from "svelte";
import Placeholder from "./common/Placeholder.svelte";
import type { ViewMeta } from "./registry";
import type GtdFlowPlugin from "../main";

/** Страховка для базового класса без staticMeta (недостижимо при полной фабрике). */
const FALLBACK_META: ViewMeta = {
	kind: "inbox",
	type: "gtd-flow-view",
	displayText: "GTD Flow",
	icon: "inbox",
};

/**
 * Базовый ItemView всех шести видов: монтирует Svelte-компонент в onOpen,
 * размонтирует в onClose. Конкретные виды переопределяют component()/props().
 */
export class GtdView extends ItemView {
	/**
	 * Метаданные на уровне КЛАССА. Конструктор View в Obsidian ≥1.12 вызывает
	 * getViewType() ДО того, как присвоятся параметр-свойства подкласса
	 * (this.meta в этот момент ещё undefined), поэтому инстанс-поля там
	 * недостаточно — каждый конкретный вид обязан задать staticMeta.
	 */
	protected static staticMeta?: ViewMeta;

	private mounted: Record<string, unknown> | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: GtdFlowPlugin,
		readonly meta: ViewMeta,
	) {
		super(leaf);
	}

	/** this.meta после конструирования; во время super() — статика класса. */
	private metaInfo(): ViewMeta {
		return this.meta ?? (this.constructor as typeof GtdView).staticMeta ?? FALLBACK_META;
	}

	getViewType(): string {
		return this.metaInfo().type;
	}

	getDisplayText(): string {
		return this.metaInfo().displayText;
	}

	getIcon(): string {
		return this.metaInfo().icon;
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
