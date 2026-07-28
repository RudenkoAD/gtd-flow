<script lang="ts">
	import { Menu, Notice, type App } from "obsidian";
	import type { IsoDate } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings, QuickAddKind } from "../../settings/Settings";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort, OccurrenceDrag } from "../dnd/types";
	import { addDaysIso } from "../common/dates";
	import EventOccurrenceChip from "./EventOccurrenceChip.svelte";
	import QuickAddKindSwitch from "./QuickAddKindSwitch.svelte";
	import TimeGridBlock from "./TimeGridBlock.svelte";
	import type { CalendarWritePort, EventOccurrence, PlacedEvent } from "./calendarLogic";
	import {
		MINUTES_PER_DAY,
		SNAP_STEP_MIN,
		minutesFromOffsetY,
		minutesToTime,
		snapMinutes,
		timeTopPct,
		type TimedBlock,
	} from "./timeGrid";
	import { occurrenceKeyboardAction, surfaceKeyboardAction } from "./calendarKeyboard";
	import { reportAsync } from "../common/runAction";

	let {
		date,
		today,
		nowMinutes = null,
		blocks,
		eventBlocks = [],
		statusColor = null,
		dnd,
		dispatcher,
		app,
		settings,
		vault = null,
		menuPorts = null,
		onDropTask,
		onQuickAdd,
		onQuickAddEvent = null,
		onCreateEvent = null,
		onMoveOccurrence = null,
		quickAddKind = "task",
		onQuickAddKindChange = null,
	}: {
		date: IsoDate;
		today: IsoDate;
		/** Минуты от полуночи для линии текущего времени; рисуется только когда
		 *  date === today и nowMinutes !== null. null — линии нет (§сегодня). */
		nowMinutes?: number | null;
		/** Блоки со временем этого дня (раскладку делает родитель через layoutDay). */
		blocks: { block: TimedBlock; ev: PlacedEvent }[];
		/** Виртуальные блоки серий-событий со временем (§события). */
		eventBlocks?: { block: TimedBlock; occ: EventOccurrence }[];
		/** Цвет статуса дня (покраска колонки) или null. */
		statusColor?: string | null;
		dnd: DndPort | null;
		dispatcher: IntentDispatcher;
		app: App;
		settings: GtdFlowSettings;
		/** Порт файла событий — для правки серии из меню вхождения. */
		vault?: CalendarWritePort | null;
		menuPorts?: TaskMenuPorts | null;
		/** Drop на слот: дата колонки + время по позиции (снап 15 мин). */
		onDropTask: (taskKey: string, date: IsoDate, time: string | null) => Promise<void>;
		/** Quick-add из клика/протяжки по пустому слоту — дата, время начала и, при
		 *  click-drag, конец интервала (задаёт длительность события сразу). */
		onQuickAdd: (
			date: IsoDate,
			text: string,
			time: string | null,
			timeEnd?: string | null,
			location?: string | null,
		) => Promise<void>;
		/** Инлайн-создание СОБЫТИЯ (сегмент «Событие» переключателя): дата колонки +
		 *  время начала слота и, при click-drag, конец интервала. location — из поля
		 *  «Место» (📍) или null. null-колбэк — переключатель скрыт, ввод создаёт только задачи. */
		onQuickAddEvent?:
			| ((
					date: IsoDate,
					text: string,
					time: string | null,
					timeEnd?: string | null,
					location?: string | null,
			  ) => Promise<void>)
			| null;
		/** ПКМ по пустому слоту — создать событие с временем слота. */
		onCreateEvent?: ((date: IsoDate, time: string | null) => void) | null;
		/** Drop блока-вхождения события: перенос на дату колонки + время слота. */
		onMoveOccurrence?:
			| ((taskKey: string, occ: OccurrenceDrag, date: IsoDate, time: string) => Promise<void>)
			| null;
		/** Липкое положение переключателя «Задача | Событие» (общее для всех сеток вида). */
		quickAddKind?: QuickAddKind;
		/** Смена переключателя — родитель сохраняет выбор в настройки (persist). */
		onQuickAddKindChange?: ((kind: QuickAddKind) => void) | null;
	} = $props();

	let colEl: HTMLElement | null = $state(null);
	/** Минуты начала открытого quick-add; null — не редактируем. */
	let addingMin = $state<number | null>(null);
	/** Минуты конца интервала quick-add (из click-drag); null — без длительности. */
	let addingEndMin = $state<number | null>(null);
	let draft = $state("");
	/** Необязательное «Место» (📍) — второй инпут под названием. */
	let locationDraft = $state("");
	/** Обёртка ввода+переключателя — для blur-guard по relatedTarget. */
	let addWrap = $state<HTMLElement | null>(null);

	// --- click-drag создание: тянем по вертикали → начало+конец за один жест ---
	// Отдельный pointer-жест на колонке (по образцу ресайза блока), а не DnD-сервис:
	// тот двигает существующий элемент, здесь же создаём новый.
	const CREATE_DRAG_THRESHOLD_PX = 4;
	/** Начало выделения (минуты) во время жеста; null — жест не идёт. */
	let selFromMin = $state<number | null>(null);
	let selToMin = $state<number | null>(null);
	/** Жест пересёк порог — это протяжка, а не клик. */
	let dragging = $state(false);
	let pointerDownY = 0;
	let capturedPointer: number | null = null;

	function isBlockOrControl(target: EventTarget | null): boolean {
		return (
			target instanceof Element &&
			// .gtd-tg-quickadd — обёртка ввода+переключателя: клик по её пустоте (зазор
			// между полем и сегментами) не должен начинать НОВЫЙ жест выделения
			target.closest(
				".gtd-tg-block, .gtd-cal-chip, .gtd-tg-quickadd, button, input, a, select, textarea",
			) !== null
		);
	}

	/** Снапнутые минуты по вертикальной позиции курсора в колонке. */
	function minAtClientY(clientY: number): number {
		const rect = colEl!.getBoundingClientRect();
		return snapMinutes(minutesFromOffsetY(clientY - rect.top, rect.height));
	}

	// Колонка — drop-цель на все 24ч: время из вертикальной позиции отпускания.
	// grabOffsetY (блоки time-grid) восстанавливает верх блока — чисто
	// горизонтальный перенос в соседний день сохраняет время с точностью снапа.
	$effect(() => {
		if (dnd === null || colEl === null) return;
		const el = colEl;
		return dnd.registerDropTarget({
			el,
			accepts: (p) => p.taskKey !== "",
			drop: (p, ctx) => {
				const rect = el.getBoundingClientRect();
				const anchorY = ctx.clientY - (p.grabOffsetY ?? 0);
				const min = snapMinutes(minutesFromOffsetY(anchorY - rect.top, rect.height));
				const time = minutesToTime(min);
				// вхождение события переносим ОТДЕЛЬНЫМ путём (не set-date задачи)
				if (p.occurrence !== undefined) {
					return onMoveOccurrence?.(p.taskKey, p.occurrence, date, time);
				}
				return onDropTask(p.taskKey, date, time);
			},
		});
	});

	/** ЛКМ по пустому слоту: pointerdown стартует жест (клик или протяжка);
	 *  клики по блокам/контролам — их дело. */
	function onColPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || isBlockOrControl(e.target) || colEl === null) return;
		pointerDownY = e.clientY;
		selFromMin = minAtClientY(e.clientY);
		selToMin = selFromMin;
		dragging = false;
		capturedPointer = e.pointerId;
		colEl.setPointerCapture(e.pointerId);
	}

	function onColPointerMove(e: PointerEvent): void {
		if (capturedPointer !== e.pointerId || selFromMin === null) return;
		if (!dragging && Math.abs(e.clientY - pointerDownY) < CREATE_DRAG_THRESHOLD_PX) return;
		dragging = true;
		selToMin = minAtClientY(e.clientY);
	}

	function onColPointerUp(e: PointerEvent): void {
		if (capturedPointer !== e.pointerId) return;
		const from = selFromMin;
		const to = selToMin;
		const wasDrag = dragging;
		colEl?.releasePointerCapture(e.pointerId);
		capturedPointer = null;
		selFromMin = null;
		selToMin = null;
		dragging = false;
		if (from === null || to === null) return;
		draft = "";
		if (wasDrag && to !== from) {
			// протяжка: начало = верх выделения, конец = низ (минимум шаг снапа)
			addingMin = Math.min(from, to);
			addingEndMin = Math.max(Math.max(from, to), addingMin + SNAP_STEP_MIN);
		} else {
			// простой клик — прежнее поведение: точка без длительности
			addingMin = from;
			addingEndMin = null;
		}
	}

	function onColPointerCancel(e: PointerEvent): void {
		if (capturedPointer !== e.pointerId) return;
		colEl?.releasePointerCapture(e.pointerId);
		capturedPointer = null;
		selFromMin = null;
		selToMin = null;
		dragging = false;
	}

	/** ПКМ по пустому слоту — меню «Повторяющееся событие…» с временем слота (§события). */
	function onColContextMenu(e: MouseEvent): void {
		if (onCreateEvent === null || colEl === null) return;
		if (
			e.target instanceof Element &&
			e.target.closest(
				".gtd-tg-block, .gtd-cal-chip, .gtd-tg-quickadd, button, input, a, select, textarea",
			)
		)
			return;
		e.preventDefault();
		const rect = colEl.getBoundingClientRect();
		const min = snapMinutes(minutesFromOffsetY(e.clientY - rect.top, rect.height));
		const time = minutesToTime(min);
		const menu = new Menu();
		menu.addItem((mi) =>
			mi
				.setTitle("Повторяющееся событие…")
				.setIcon("repeat")
				.onClick(() => onCreateEvent?.(date, time)),
		);
		menu.showAtMouseEvent(e);
	}

	const KEYBOARD_SLOT_MIN = 9 * 60;

	function openQuickAddAt(min: number): void {
		draft = "";
		addingMin = snapMinutes(min);
		addingEndMin = null;
	}

	function openContextMenuFromKeyboard(): void {
		if (colEl === null) return;
		const rect = colEl.getBoundingClientRect();
		onColContextMenu(
			new MouseEvent("contextmenu", {
				bubbles: true,
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + (KEYBOARD_SLOT_MIN / MINUTES_PER_DAY) * rect.height,
			}),
		);
	}

	/** Keyboard parity for an otherwise pointer-only time grid.  A focused empty
	 * column starts quick-add at 09:00; ContextMenu/Shift+F10 opens the recurring
	 * event menu at that same documented slot. */
	function onColKeydown(e: KeyboardEvent): void {
		if (e.target !== e.currentTarget) return;
		const action = surfaceKeyboardAction(e.key, e.shiftKey);
		if (action === "quick-add") {
			e.preventDefault();
			openQuickAddAt(KEYBOARD_SLOT_MIN);
			return;
		}
		if (action === "menu") {
			e.preventDefault();
			openContextMenuFromKeyboard();
		}
	}

	/** Arrow keys on a focused timed occurrence are the keyboard counterpart of
	 * dragging its block: ←/→ move day, ↑/↓ move by the 15-minute snap. */
	function moveOccurrenceFromKeyboard(occ: EventOccurrence, key: string): void {
		if (onMoveOccurrence === null || occ.time === null) return;
		const action = occurrenceKeyboardAction(key);
		if (action === null) return;
		let toDate = date;
		let minutes = Number(occ.time.slice(0, 2)) * 60 + Number(occ.time.slice(3, 5));
		if (action === "move-left") toDate = addDaysIso(date, -1);
		else if (action === "move-right") toDate = addDaysIso(date, 1);
		else if (action === "move-up") minutes = Math.max(0, minutes - SNAP_STEP_MIN);
		else minutes = Math.min(MINUTES_PER_DAY - SNAP_STEP_MIN, minutes + SNAP_STEP_MIN);
		const drag: OccurrenceDrag = {
			kind: occ.kind,
			date: occ.date,
			time: occ.time,
			timeEnd: occ.timeEnd,
		};
		void onMoveOccurrence(
			occ.task.key,
			drag,
			toDate,
			minutesToTime(snapMinutes(minutes)),
		).catch((error) => new Notice(`GTD Flow: не удалось перенести событие: ${String(error)}`));
	}

	function focusInput(el: HTMLInputElement): void {
		el.focus();
	}

	/** Диапазон слота для плейсхолдера/aria: «HH:mm–HH:mm» при click-drag, иначе «HH:mm». */
	const slotRange = $derived(
		addingMin === null
			? ""
			: addingEndMin !== null
				? `${minutesToTime(addingMin)}–${minutesToTime(addingEndMin)}`
				: minutesToTime(addingMin),
	);

	function cancelDraft(): void {
		addingMin = null;
		addingEndMin = null;
		draft = "";
		locationDraft = "";
		// тип НЕ сбрасываем: положение переключателя липкое (последний выбор
		// живёт в настройках и переживает перезапуск, см. quickAddKind)
	}

	/** blur ввода: отмена, КРОМЕ ухода фокуса в переключатель той же обёртки —
	 *  клик/Tab по сегменту «Задача|Событие» не схлопывает ввод. */
	function onDraftBlur(e: FocusEvent): void {
		const to = e.relatedTarget;
		if (to instanceof Node && addWrap?.contains(to)) return;
		cancelDraft();
	}

	function submitDraft(): void {
		const min = addingMin;
		const endMin = addingEndMin;
		const kind = quickAddKind;
		const text = draft;
		const locationText = locationDraft;
		const location = locationText.trim() === "" ? null : locationText.trim();
		cancelDraft();
		if (min === null || text.trim() === "") return;
		const time = minutesToTime(min);
		const timeEnd = endMin !== null ? minutesToTime(endMin) : null;
		// «Событие» → инлайн-создание события с временем слота; иначе — задача (как прежде).
		// Место (📍) идёт в обе ветки: у события — в createSingleEvent, у задачи — полем 📍.
		const action =
			kind === "event" && onQuickAddEvent !== null
				? () => onQuickAddEvent(date, text, time, timeEnd, location)
				: () => onQuickAdd(date, text, time, timeEnd, location);
		reportAsync(
			kind === "event" ? "не удалось создать событие" : "не удалось добавить задачу",
			async () => {
				try {
					await action();
				} catch (error) {
					// A later quick-add must win over restoring this failed write's draft.
					if (addingMin === null) {
						addingMin = min;
						addingEndMin = endMin;
						draft = text;
						locationDraft = locationText;
					}
					throw error;
				}
			},
		);
	}
</script>

<div
	class="gtd-tg-col"
	class:is-today={date === today}
	class:has-status={statusColor !== null}
	style={statusColor !== null ? `--gtd-ds-color: ${statusColor}` : undefined}
	bind:this={colEl}
	role="gridcell"
	tabindex="0"
	aria-label={`Расписание ${date}. Enter — новая задача на 09:00, Shift+F10 — меню события`}
	onpointerdown={onColPointerDown}
	onpointermove={onColPointerMove}
	onpointerup={onColPointerUp}
	onpointercancel={onColPointerCancel}
	oncontextmenu={onColContextMenu}
	onkeydown={onColKeydown}
>
	{#each blocks as b (b.ev.task.key)}
		<TimeGridBlock
			ev={b.ev}
			block={b.block}
			{date}
			{today}
			{dnd}
			{dispatcher}
			{app}
			{settings}
			{menuPorts}
		/>
	{/each}
	{#each eventBlocks as eb (eb.occ.task.key)}
		{#if vault !== null}
			<EventOccurrenceChip
				occ={eb.occ}
				block={eb.block}
				{app}
				{dispatcher}
				{vault}
				{dnd}
				{settings}
				onKeyboardMove={(key) => moveOccurrenceFromKeyboard(eb.occ, key)}
			/>
		{/if}
	{/each}
	{#if nowMinutes !== null && date === today}
		<!-- Горизонталь текущего времени (● HH:mm ———), только колонка сегодня.
		     Оверлей поверх блоков, но pointer-events:none — не мешает кликам/жестам. -->
		<div class="gtd-tg-now" style="top:{timeTopPct(nowMinutes)}%" aria-hidden="true">
			<span class="gtd-tg-now-label">{minutesToTime(nowMinutes)}</span>
			<span class="gtd-tg-now-rule"></span>
		</div>
	{/if}
	{#if dragging && selFromMin !== null && selToMin !== null}
		<!-- живое выделение диапазона во время протяжки (pointer-events:none) -->
		<div
			class="gtd-tg-createsel"
			style="top:{(Math.min(selFromMin, selToMin) / MINUTES_PER_DAY) * 100}%;
			       height:{(Math.abs(selToMin - selFromMin) / MINUTES_PER_DAY) * 100}%"
		>
			<span class="gtd-tg-createsel-label"
				>{minutesToTime(Math.min(selFromMin, selToMin))}–{minutesToTime(
					Math.max(selFromMin, selToMin),
				)}</span
			>
		</div>
	{/if}
	{#if addingMin !== null}
		<div
			class="gtd-tg-quickadd"
			style="top:{(addingMin / MINUTES_PER_DAY) * 100}%"
			bind:this={addWrap}
		>
			<input
				class="gtd-tg-quickadd-input"
				type="text"
				placeholder="{quickAddKind === 'event'
					? 'Новое событие'
					: 'Новая задача'} {slotRange}…"
				aria-label="{quickAddKind === 'event'
					? 'Новое событие'
					: 'Новая задача'} на {date} {slotRange}"
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
				class="gtd-tg-quickadd-input gtd-tg-quickadd-loc"
				type="text"
				placeholder="📍 Место"
				aria-label="Место (необязательно) на {date} {slotRange}"
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

<style>
	.gtd-tg-col {
		position: relative;
		min-width: 0;
		border-left: 1px solid var(--background-modifier-border);
		/* линии часов: 1px границы через каждый час (--gtd-tg-hour с корня сетки) */
		background-image: repeating-linear-gradient(
			to bottom,
			var(--background-modifier-border) 0,
			var(--background-modifier-border) 1px,
			transparent 1px,
			transparent var(--gtd-tg-hour, 48px)
		);
		cursor: cell;
	}
	.gtd-tg-col:last-child {
		border-right: 1px solid var(--background-modifier-border);
	}
	.gtd-tg-col.is-today {
		background-color: var(--background-modifier-hover);
	}
	/* лёгкая тонировка колонки по статусу дня (правило ниже is-today — выигрывает фон) */
	.gtd-tg-col.has-status {
		background-color: color-mix(in srgb, var(--gtd-ds-color) 10%, transparent);
	}
	.gtd-tg-quickadd {
		position: absolute;
		left: 0;
		width: calc(100% - 4px);
		z-index: 3; /* над блоками — редактируем именно его */
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}
	.gtd-tg-quickadd-input {
		width: 100%;
		font-size: var(--font-ui-smaller, 0.85em);
	}
	/* поле «Место» — компактнее и приглушённее названия (необязательное) */
	.gtd-tg-quickadd-loc {
		font-size: var(--font-ui-smaller, 0.8em);
		color: var(--text-muted);
	}
	/* Линия текущего времени: тонкая горизонталь через колонку сегодня, точка +
	   подпись HH:mm слева (стиль Google Calendar). Оверлей — pointer-events:none,
	   не перехватывает клики/жесты по блокам и пустому слоту. Цвет — акцентный
	   красный темы (--color-red), фолбэк на interactive-accent. */
	.gtd-tg-now {
		position: absolute;
		left: 0;
		right: 0;
		z-index: 2; /* над блоками, под quickadd-вводом (z:3) — ввод не перекрывается линией */
		display: flex;
		align-items: center;
		gap: 3px;
		transform: translateY(-50%); /* линия центрируется на пиксельной позиции времени */
		pointer-events: none;
	}
	/* точка-кружок слева от подписи */
	.gtd-tg-now::before {
		content: "";
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-red, var(--interactive-accent));
	}
	.gtd-tg-now-label {
		flex: none;
		font-size: var(--font-ui-smaller, 0.7em);
		font-variant-numeric: tabular-nums;
		line-height: 1;
		color: var(--color-red, var(--interactive-accent));
		font-weight: 600;
		white-space: nowrap;
	}
	.gtd-tg-now-rule {
		flex: 1 1 auto;
		height: 2px;
		background: var(--color-red, var(--interactive-accent));
	}
	.gtd-tg-createsel {
		position: absolute;
		left: 1px;
		right: 1px;
		z-index: 2;
		box-sizing: border-box;
		min-height: 2px;
		background: color-mix(in srgb, var(--interactive-accent) 25%, transparent);
		border: 1px solid var(--interactive-accent);
		border-radius: var(--radius-s, 4px);
		pointer-events: none;
	}
	.gtd-tg-createsel-label {
		position: absolute;
		top: 1px;
		left: 4px;
		font-size: var(--font-ui-smaller, 0.8em);
		color: var(--text-on-accent, var(--text-normal));
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
</style>
