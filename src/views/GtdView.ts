import { ItemView, type WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { mount, unmount, type Component } from "svelte";
import { writable, type Writable } from "svelte/store";
import { normalizeActiveNamespace } from "../core/namespace/namespace";
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
 * Базовый ItemView всех семи видов: монтирует Svelte-компонент в onOpen,
 * размонтирует в onClose. Конкретные виды переопределяют component()/props().
 *
 * ПОФАЙЛОВОЕ ПРОСТРАНСТВО (итерация 2 фидбека): у каждой вкладки вида — СВОЁ
 * активное пространство (localNamespace$), персистится в viewState по ключу
 * nsName. Новая вкладка наследует ГЛОБАЛЬНЫЙ дефолт (plugin.settings.activeNamespace),
 * который остаётся «дефолтом новых вкладок + целью палитры-захвата». Селектор шапки
 * меняет только свой вид; команда палитры «Переключить пространство GTD» — глобальный
 * дефолт И локальные пространства всех открытых видов (см. main.setNamespaceEverywhere).
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

	/**
	 * Локальное активное пространство вида (per-tab). Инициализируется ГЛОБАЛЬНЫМ
	 * дефолтом в момент создания вкладки; setState восстанавливает персистнутое
	 * nsName поверх. Компонент подписывается на этот store (как на epoch) —
	 * переключение пере-рендерит вид (смена пространства эпоху индекса не бампает).
	 */
	protected readonly localNamespace$: Writable<string>;
	/** Зеркало localNamespace$ для getState (store синхронного чтения не даёт). */
	protected currentNsName: string;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: GtdFlowPlugin,
		readonly meta: ViewMeta,
	) {
		super(leaf);
		// новая вкладка наследует глобальный дефолт; нормализуем на случай ALL_NS
		// в глобальном (недостижимо — глобальный его не принимает, но fail-safe)
		this.currentNsName = this.normalizeNs(plugin.settings.activeNamespace);
		this.localNamespace$ = writable(this.currentNsName);
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

	// --- локальное пространство вида ---

	/**
	 * Нормализация локального имени: DEFAULT_NS / существующее имя, иначе «Общее».
	 * Календарь переопределяет (разрешает ALL_NS — вкладку «Все»).
	 */
	protected normalizeNs(name: string): string {
		return normalizeActiveNamespace(name, this.plugin.settings.namespaces);
	}

	/**
	 * Сменить локальное пространство вида (селектор шапки / команда палитры):
	 * толкает локальный store + просит workspace сохранить раскладку (persist nsName).
	 * Неизвестное имя нормализуется. Равное текущему — no-op.
	 */
	setLocalNamespace(name: string): void {
		const next = this.normalizeNs(name);
		if (next === this.currentNsName) return;
		this.currentNsName = next;
		this.localNamespace$.set(next);
		this.app.workspace.requestSaveLayout();
	}

	/**
	 * Форс-пере-нормализация локального пространства при правке СПИСКА пространств
	 * (удалённое из настроек имя откатывается к «Общему») + толчок стора даже при
	 * неизменном имени: writable глотает равные строки, поэтому проход «сентинел →
	 * назад». Зовётся из plugin.pokeNamespaceViews (SettingsTab).
	 */
	pokeNamespace(): void {
		const n = this.normalizeNs(this.currentNsName);
		this.currentNsName = n;
		this.localNamespace$.set("\0__ns_poke__");
		this.localNamespace$.set(n);
	}

	// --- viewState (nsName): общая часть для всех видов ---

	/** nsName-часть viewState; подмешивается в getState (подклассы мёржат своё). */
	protected namespaceState(): { nsName: string } {
		return { nsName: this.currentNsName };
	}

	/** Восстановление nsName из viewState (общая часть setState). */
	protected restoreNamespaceState(state: unknown): void {
		if (typeof state !== "object" || state === null || Array.isArray(state)) return;
		const raw = (state as Record<string, unknown>)["nsName"];
		if (typeof raw !== "string" || raw === "") return;
		const n = this.normalizeNs(raw);
		this.currentNsName = n;
		this.localNamespace$.set(n);
	}

	override getState(): Record<string, unknown> {
		return { ...this.namespaceState() };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		this.restoreNamespaceState(state);
		await super.setState(state, result);
	}

	/** Компонент вида; пока у всех — заглушка, виды подменяют по мере реализации этапов. */
	protected component(): Component<Record<string, unknown>> {
		return Placeholder as unknown as Component<Record<string, unknown>>;
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
