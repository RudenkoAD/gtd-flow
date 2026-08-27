<script lang="ts">
	import { Menu, type App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings, QuickAddKind } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort } from "../dnd/types";
	import EventChip from "./EventChip.svelte";
	import EventOccurrenceChip from "./EventOccurrenceChip.svelte";
	import QuickAddKindSwitch from "./QuickAddKindSwitch.svelte";
	import {
		mergeDayItems,
		nowMarkerIndex,
		type CalendarWritePort,
		type EventOccurrence,
		type PlacedEvent,
	} from "./calendarLogic";
	import { minutesToTime } from "./timeGrid";
	import { surfaceKeyboardAction } from "./calendarKeyboard";
	import { reportAsync } from "../common/runAction";

	let {
		date,
		today,
		events,
		eventOccurrences = [],
		nowMinutes = null,
		dnd,
		dispatcher,
		app,
		settings,
		vault = null,
		menuPorts = null,
		muted = false,
		compact = false,
		label = null,
		statusColor = null,
		statusName = null,
		painting = false,
		onDropTask,
		onQuickAdd,
		onQuickAddEvent = null,
		onCreateEvent = null,
		quickAddKind = "task",
		onQuickAddKindChange = null,
	}: {
		date: IsoDate;
		today: IsoDate;
		events: PlacedEvent[];
		/** Виртуальные вхождения серий-событий на этот день (§события). */
		eventOccurrences?: EventOccurrence[];
		/** Минуты от полуночи для маркера «сейчас» (● HH:mm ———) в агенде; рисуется
		 *  только когда date === today. null — маркера нет (месяц/неделя, §сегодня). */
		nowMinutes?: number | null;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		/** Порт файла событий — для правки серии из меню вхождения. */
		vault?: CalendarWritePort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** День соседнего месяца в сетке месяца. */
		muted?: boolean;
		/** Месяц — компактные ячейки; неделя/агенда — растянутые. */
		compact?: boolean;
		/** Заголовок вместо номера дня (агенда: «Ср 2026-07-15»). */
		label?: string | null;
		/** Цвет статуса дня (фича покраски) или null — тонирует ячейку и полосу. */
		statusColor?: string | null;
		/** Имя статуса дня — подпись на полосе и в подсказке. */
		statusName?: string | null;
		/** День входит в активный диапазон покраски (подсветка превью). */
		painting?: boolean;
		/** Drop карточки любого вида на этот день (ТЗ §8). */
		onDropTask: (taskKey: string, date: IsoDate) => Promise<void>;
		/** Быстрый ввод задачи с датой этого дня. location — из поля «Место» (📍) или null. */
		onQuickAdd: (date: IsoDate, text: string, location: string | null) => Promise<void>;
		/** Инлайн-создание СОБЫТИЯ «Весь день» с датой этого дня (сегмент «Событие»
		 *  переключателя). location — из поля «Место» (📍) или null. null-колбэк —
		 *  переключатель скрыт, ввод создаёт только задачи. */
		onQuickAddEvent?:
			((date: IsoDate, text: string, location: string | null) => Promise<void>) | null;
		/** ПКМ по пустому месту — создать повторяющееся событие (time=null для дня). */
		onCreateEvent?: ((date: IsoDate, time: string | null) => void) | null;
		/** Липкое положение переключателя «Задача | Событие» (общее для всех сеток вида). */
		quickAddKind?: QuickAddKind;
		/** Смена переключателя — родитель сохраняет выбор в настройки (persist). */
		onQuickAddKindChange?: ((kind: QuickAddKind) => void) | null;
	} = $props();

	// Задачи и вхождения событий — в ОДНОМ списке с общей сортировкой по времени
	// (без группировки «сначала задачи, потом события»): элементы без времени —
	// первыми, затем по возрастанию времени, при равенстве событие раньше задачи.
	const dayItems = $derived(mergeDayItems(events, eventOccurrences));

	// Маркер «сейчас» (● HH:mm ———) — только в секции СЕГОДНЯШНЕГО дня агенды
	// (nowMinutes передаётся лишь оттуда). Индекс вставки в отсортированный список:
	// после начавшихся до «сейчас» и без-времени, перед первым временем >= сейчас.
	// null — маркера нет (не сегодня либо месяц/неделя, где nowMinutes === null).
	const markerAt = $derived(
		nowMinutes !== null && date === today ? nowMarkerIndex(dayItems, nowMinutes) : null,
	);
	/** Подпись маркера «HH:mm» ("" когда маркера нет — narrowing для шаблона). */
	const nowText = $derived(nowMinutes === null ? "" : minutesToTime(nowMinutes));

	let cellEl: HTMLElement | null = $state(null);
	let adding = $state(false);
	let draft = $state("");
	/** Необязательное «Место» (📍) — второй инпут под названием. */
	let locationDraft = $state("");
	/** Обёртка ввода+переключателя — для blur-guard по relatedTarget. */
	let addWrap = $state<HTMLElement | null>(null);

	// Ячейка — drop-цель; подсветка под курсором — DND_OVER_CLASS от сервиса.
	// drop-замыкание читает реактивный prop date — цель всегда бьёт в актуальный день.
	$effect(() => {
		if (dnd === null || cellEl === null) return;
		return dnd.registerDropTarget({
			el: cellEl,
			// вхождение события (occurrence) сюда не принимаем: его перенос — только
			// на слот тайм-сетки; set-date по серии сломал бы саму строку серии
			accepts: (p) => p.taskKey !== "" && p.occurrence === undefined,
			drop: (p) => onDropTask(p.taskKey, date),
		});
	});

	/** ЛКМ по пустой области дня — быстрый ввод; клики по chip/контролам — их дело. */
	function onCellClick(e: MouseEvent): void {
		if (
			e.target instanceof Element &&
			e.target.closest(
				".gtd-cal-chip, .gtd-cal-statusband, button, input, a, select, textarea",
			)
		)
			return;
		adding = true;
	}

	/** ПКМ по пустому месту дня — меню «Повторяющееся событие…» (§события).
	 *  Клики по chip обрабатывают сами chip'ы (stopPropagation). */
	function onCellContextMenu(e: MouseEvent): void {
		if (onCreateEvent === null) return;
		if (
			e.target instanceof Element &&
			e.target.closest(
				".gtd-cal-chip, .gtd-cal-statusband, button, input, a, select, textarea",
			)
		)
			return;
		e.preventDefault();
		const menu = new Menu();
		menu.addItem((mi) =>
			mi
				.setTitle("Повторяющееся событие…")
				.setIcon("repeat")
				.onClick(() => onCreateEvent?.(date, null)),
		);
		menu.showAtMouseEvent(e);
	}

	/** Клавиатурный эквивалент контекстного меню: меню привязываем к центру ячейки,
	 * а не к давно прошедшей позиции мыши. */
	function openContextMenuFromKeyboard(): void {
		if (cellEl === null) return;
		const rect = cellEl.getBoundingClientRect();
		onCellContextMenu(
			new MouseEvent("contextmenu", {
				bubbles: true,
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
			}),
		);
	}

	/** Ячейка была pointer-only. Enter/Space открывают быстрый ввод, а клавиша
	 * меню (или Shift+F10) даёт тот же путь к повторяющемуся событию, что ПКМ. */
	function onCellKeydown(e: KeyboardEvent): void {
		if (e.target !== e.currentTarget) return;
		const action = surfaceKeyboardAction(e.key, e.shiftKey);
		if (action === "quick-add") {
			e.preventDefault();
			adding = true;
			return;
		}
		if (action === "menu") {
			e.preventDefault();
			openContextMenuFromKeyboard();
		}
	}

	function focusInput(el: HTMLInputElement): void {
		el.focus();
	}

	function cancelDraft(): void {
		adding = false;
		draft = "";
		locationDraft = "";
		// тип НЕ сбрасываем: положение переключателя липкое (последний выбор
		// живёт в настройках и переживает перезапуск, см. quickAddKind)
	}

	/** blur ввода: отмена, КРОМЕ ухода фокуса в переключатель той же обёртки —
	 *  клик/Tab по сегменту «Задача|Событие» не схлопывает ввод (иначе выбор
	 *  типа рвал бы флоу). Escape/blur наружу отменяют, как прежде. */
	function onDraftBlur(e: FocusEvent): void {
		const to = e.relatedTarget;
		if (to instanceof Node && addWrap?.contains(to)) return;
		cancelDraft();
	}

	function submitDraft(): void {
		const text = draft;
		const kind = quickAddKind;
		const locationText = locationDraft;
		const location = locationText.trim() === "" ? null : locationText.trim();
		cancelDraft();
		if (text.trim() === "") return;
		// «Событие» → инлайн-создание события «Весь день»; иначе — задача (как прежде).
		// Место (📍) идёт в обе ветки: у события — в createSingleEvent, у задачи — полем
		// 📍 строки (quickAddLine).
		const action =
			kind === "event" && onQuickAddEvent !== null
				? () => onQuickAddEvent(date, text, location)
				: () => onQuickAdd(date, text, location);
		reportAsync(
			kind === "event" ? "не удалось создать событие" : "не удалось добавить задачу",
			async () => {
				try {
					await action();
				} catch (error) {
					// Do not clobber a newer draft opened while the write was pending.
					if (!adding) {
						adding = true;
						draft = text;
						locationDraft = locationText;
					}
					throw error;
				}
			},
		);
	}
</script>

<!-- Разделитель «сейчас»: ● HH:mm ———, между элементами дня «сегодня» (§сегодня). -->
{#snippet nowLine()}
	<div class="gtd-now" aria-hidden="true">
		<span class="gtd-now-label">{nowText}</span>
		<span class="gtd-now-rule"></span>
	</div>
{/snippet}

<div
	class="gtd-cal-cell"
	class:is-muted={muted}
	class:is-today={date === today}
	class:is-compact={compact}
	class:has-status={statusColor !== null}
	style={statusColor !== null ? `--gtd-ds-color: ${statusColor}` : undefined}
	bind:this={cellEl}
	role="gridcell"
	tabindex="0"
	aria-label={`День ${date}. Enter — новая задача, Shift+F10 — меню события`}
	onclick={onCellClick}
	oncontextmenu={onCellContextMenu}
	onkeydown={onCellKeydown}
>
	<!-- полоса-статус: цель клика/протяжки покраски (data-gtd-ds-date), подпись статуса -->
	<div
		class="gtd-cal-statusband"
		class:is-set={statusColor !== null}
		class:is-painting={painting}
		data-gtd-ds-date={date}
		title={statusName !== null ? `Статус дня: ${statusName}` : "Покрасить день"}
	>
		<span class="gtd-cal-statusband-label">{statusName ?? ""}</span>
	</div>
	<div class="gtd-cal-daynum" class:is-today={date === today}>
		{label ?? Number(date.slice(8, 10))}
	</div>
	<div class="gtd-cal-events">
		{#each dayItems as it, i (it.kind === "task" ? "t:" + it.ev.task.key : "e:" + it.occ.task.key)}
			{#if markerAt === i}{@render nowLine()}{/if}
			{#if it.kind === "task"}
				<EventChip ev={it.ev} {today} {dnd} {dispatcher} {app} {settings} {menuPorts} />
			{:else if vault !== null}
				<EventOccurrenceChip occ={it.occ} {app} {dispatcher} {vault} {settings} />
			{/if}
		{/each}
		<!-- маркер под всеми элементами (индекс == длине) и в пустой сегодняшний день -->
		{#if markerAt !== null && markerAt >= dayItems.length}{@render nowLine()}{/if}
		{#if adding}
			<div class="gtd-cal-quickadd-wrap" bind:this={addWrap}>
				<input
					class="gtd-cal-quickadd"
					type="text"
					placeholder={quickAddKind === "event" ? "Новое событие…" : "Новая задача…"}
					aria-label="{quickAddKind === 'event'
						? 'Новое событие'
						: 'Новая задача'} на {date}"
					bind:value={draft}
					use:focusInput
					onkeydown={(e) => {
						if (e.key === "Enter") submitDraft();
						else if (e.key === "Escape") cancelDraft();
					}}
					onblur={onDraftBlur}
				/>
				<!-- необязательное «Место» (📍): Tab из названия, Enter создаёт из любого поля -->
				<input
					class="gtd-cal-quickadd gtd-cal-quickadd-loc"
					type="text"
					placeholder="📍 Место"
					aria-label="Место (необязательно) на {date}"
					bind:value={locationDraft}
					onkeydown={(e) => {
						if (e.key === "Enter") submitDraft();
						else if (e.key === "Escape") cancelDraft();
					}}
					onblur={onDraftBlur}
				/>
				{#if onQuickAddEvent !== null && onQuickAddKindChange !== null}
					<QuickAddKindSwitch kind={quickAddKind} onChange={onQuickAddKindChange} />
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.gtd-cal-cell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		padding: 2px 4px 4px;
		border: 1px solid var(--background-modifier-border);
		margin: -1px 0 0 -1px; /* схлопывание соседних рамок в одну линию */
		cursor: cell;
	}
	.gtd-cal-cell.is-compact {
		min-height: 76px;
	}
	.gtd-cal-cell.is-muted {
		background: var(--background-secondary-alt);
	}
	.gtd-cal-cell.is-muted .gtd-cal-daynum {
		color: var(--text-faint);
	}
	.gtd-cal-cell.is-today {
		background: var(--background-modifier-hover);
	}
	/* статус дня тонирует ячейку и выигрывает у muted/today по фону (правило ниже) */
	.gtd-cal-cell.has-status {
		background: color-mix(in srgb, var(--gtd-ds-color) 16%, transparent);
	}
	.gtd-cal-statusband {
		flex: none;
		height: 15px;
		margin: -2px -4px 2px; /* растянуть на всю ширину ячейки поверх паддинга */
		display: flex;
		align-items: center;
		padding: 0 5px;
		border-radius: 0 0 var(--radius-s, 4px) var(--radius-s, 4px);
		cursor: pointer;
		border-bottom: 1px solid transparent;
	}
	.gtd-cal-statusband:hover {
		border-bottom-color: var(--background-modifier-border);
		background: var(--background-modifier-hover);
	}
	.gtd-cal-statusband.is-set {
		background: color-mix(in srgb, var(--gtd-ds-color) 60%, var(--background-primary));
		border-bottom-color: var(--gtd-ds-color);
	}
	.gtd-cal-statusband.is-painting {
		outline: 2px solid var(--interactive-accent);
		outline-offset: -2px;
	}
	.gtd-cal-statusband-label {
		font-size: calc(var(--font-ui-smaller, 0.75em) * var(--gtd-cal-font-scale, 1));
		line-height: 1;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.gtd-cal-statusband.is-set .gtd-cal-statusband-label {
		color: var(--text-normal);
	}
	.gtd-cal-daynum {
		flex: none;
		align-self: flex-start;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: calc(var(--font-ui-smaller, 0.85em) * var(--gtd-cal-font-scale, 1));
		padding: 0 4px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-cal-daynum.is-today {
		color: var(--text-on-accent);
		background: var(--interactive-accent);
		font-weight: 600;
	}
	.gtd-cal-events {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
	}
	/* Разделитель «сейчас» в агенде: ● HH:mm ——— между элементами дня. Тонкая
	   линия (2px) акцентным красным темы (--color-red, фолбэк interactive-accent). */
	.gtd-now {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 1px 0;
	}
	.gtd-now::before {
		content: "";
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-red, var(--interactive-accent));
	}
	.gtd-now-label {
		flex: none;
		font-size: calc(var(--font-ui-smaller, 0.75em) * var(--gtd-cal-font-scale, 1));
		font-variant-numeric: tabular-nums;
		line-height: 1;
		font-weight: 600;
		color: var(--color-red, var(--interactive-accent));
	}
	.gtd-now-rule {
		flex: 1 1 auto;
		height: 2px;
		border-radius: 1px;
		background: var(--color-red, var(--interactive-accent));
	}
	.gtd-cal-quickadd-wrap {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}
	.gtd-cal-quickadd {
		width: 100%;
		font-size: calc(var(--font-ui-smaller, 0.85em) * var(--gtd-cal-font-scale, 1));
	}
	/* поле «Место» — компактнее и приглушённее названия (необязательное) */
	.gtd-cal-quickadd-loc {
		font-size: calc(var(--font-ui-smaller, 0.8em) * var(--gtd-cal-font-scale, 1));
		color: var(--text-muted);
	}
</style>
