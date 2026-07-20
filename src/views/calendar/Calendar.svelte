<script lang="ts">
	import { Notice, type App } from "obsidian";
	import { derived, get, type Readable } from "svelte/store";
	import type { IsoDate, Task } from "../../core/model/Task";
	import {
		ALL_NS,
		eventVisibleInNamespace,
		NS_CONVENTION,
		nsCommonTarget,
		nsTargetPath,
		type NamespaceDef,
		type NamespaceFilter,
	} from "../../core/namespace/namespace";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { GtdFlowSettings, QuickAddKind } from "../../settings/Settings";
	import { calendarRangeStore } from "../../stores/derived/queryStore";
	import type { TaskStore } from "../../stores/taskStore";
	import { addDaysIso } from "../common/dates";
	import { confirm } from "../common/ConfirmModal";
	import NamespaceSwitcher from "../common/NamespaceSwitcher.svelte";
	import { namespaceLabel } from "../common/namespaceSwitcher";
	import { captureTargetInNamespace, ensureCaptureFileNs } from "../common/taskActions";
	import type { TaskMenuPorts } from "../common/taskMenu";
	import type { DndPort, OccurrenceDrag } from "../dnd/types";
	import DayCell from "./DayCell.svelte";
	import EventChip from "./EventChip.svelte";
	import TimeGrid from "./TimeGrid.svelte";
	import {
		AGENDA_PAGE_DAYS,
		DAYS3_PAGE_DAYS,
		agendaDays,
		agendaLabel,
		appendLine,
		dropDateField,
		eventTargetForNamespace,
		expandEventOccurrences,
		monthGrid,
		monthTitle,
		nextAgenda,
		nextMonth,
		nextWeek,
		openTasks,
		placeEvents,
		placedTime,
		placedTimeEnd,
		prevAgenda,
		prevMonth,
		prevWeek,
		quickAddLine,
		weekRange,
		weekdayNames,
		WEEK_DAYS,
		type CalendarMode,
		type CalendarPersistedState,
		type CalendarWritePort,
	} from "./calendarLogic";
	import {
		createEventSeries,
		createSingleEvent,
		transferEventOccurrence,
		withSeriesAnchor,
	} from "./eventSeries";
	import { EventSeriesModal } from "./EventSeriesModal";
	import { dropTimeEnd, minutesOfDay, preservedTimeEnd } from "./timeGrid";
	import { createPaintController, type PaintPreview } from "./dayStatusPaint";
	import { EMPTY_DAY_STATUS_MODEL, statusForDate, type DayStatusModel } from "../../core/daystatus/dayStatus";
	import type { DayStatusPort } from "../../services/DayStatusService";

	let {
		taskStore,
		dispatcher,
		settings,
		app,
		dnd,
		vault,
		menuPorts = null,
		dayStatus = null,
		activeNamespace,
		namespaces,
		setActiveNamespace,
		persisted,
		persist,
		quickAddKind: initialQuickAddKind = "task",
		persistQuickAddKind = null,
	}: {
		taskStore: TaskStore;
		dispatcher: IntentDispatcher;
		settings: GtdFlowSettings;
		app: App;
		/** null — drag выключен (телефон / сервис недоступен). */
		dnd: DndPort | null;
		/** Порты паритета без drag (меню/пикеры/карточка), ТЗ §8 слой 3. */
		menuPorts?: TaskMenuPorts | null;
		/** Быстрый ввод пишет в цель захвата активного пространства (структурный порт VaultAdapter). */
		vault: CalendarWritePort;
		/** Порт статусов дней (покраска календаря) или null. */
		dayStatus?: DayStatusPort | null;
		/** Реактивное ЛОКАЛЬНОЕ активное пространство вида (per-tab). У календаря может
		 *  быть ALL_NS («Все») — агрегат всех пространств (см. GtdView/CalendarView). */
		activeNamespace: Readable<string>;
		/** Снимок списка пространств (settings.namespaces). */
		namespaces: readonly NamespaceDef[];
		/** Смена ЛОКАЛЬНОГО пространства этого вида (persist в viewState). */
		setActiveNamespace: (name: string) => void;
		/** Состояние из workspace-раскладки; приходит ПОСЛЕ монтирования. */
		persisted: Readable<CalendarPersistedState>;
		persist: (s: CalendarPersistedState) => void;
		/** Липкое положение переключателя «Задача | Событие» из настроек плагина
		 *  (снимок на монтировании; дефолт «Задача» для новых пользователей). */
		quickAddKind?: QuickAddKind;
		/** Сохранить новый выбор переключателя в настройки (persist через плагин). */
		persistQuickAddKind?: ((kind: QuickAddKind) => void) | null;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf) —
	// одноразовый снимок при инициализации намеренный
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	// Линия текущего времени (§сегодня): локальные минуты от полуночи, пересчёт раз
	// в минуту. ОДИН интервал на весь вид — общий для тайм-сетки (горизонталь в
	// колонке сегодня) и агенды (маркер ● HH:mm ———). Смену суток ловит today-стор
	// (ObsidianClock): колонка/секция «сегодня» переезжает сама, nowMin к 00:00
	// сбрасывается этим же минутным тиком.
	let nowMin = $state(minutesOfDay(new Date()));
	$effect(() => {
		const id = window.setInterval(() => (nowMin = minutesOfDay(new Date())), 60_000);
		return () => window.clearInterval(id);
	});

	// Фильтр пространства: реактивный derive из активного namespace + список корней.
	// Задачи/события календаря режутся по нему; смена активного пере-рендерит вид
	// подпиской (эпоху индекса не бампает, см. память проекта).
	// svelte-ignore state_referenced_locally
	const namespace$: Readable<NamespaceFilter> = derived(activeNamespace, (a) => ({
		active: a,
		defs: namespaces,
	}));
	/** Метка активного пространства для шапки — только когда пространства настроены. */
	const nsLabel = $derived(namespaces.length === 0 ? null : namespaceLabel($activeNamespace));

	let mode = $state<CalendarMode>("month");
	// svelte-ignore state_referenced_locally
	let anchor = $state<IsoDate>(get(taskStore.today));

	// Липкий тип инлайн-ввода: единый источник для ОБЕИХ сеток вида (месяц/тайм-сетка);
	// снимок настройки на монтировании, дальше живёт локально и при каждой смене
	// пишется в настройки плагина (переживает перезапуск).
	// svelte-ignore state_referenced_locally
	let quickAddKind = $state<QuickAddKind>(initialQuickAddKind);
	function setQuickAddKind(kind: QuickAddKind): void {
		quickAddKind = kind;
		persistQuickAddKind?.(kind);
	}

	// восстановление из viewState (setState приходит после onOpen — поэтому store)
	$effect(() =>
		persisted.subscribe((s) => {
			if (s.mode !== undefined) mode = s.mode;
			if (s.anchor !== undefined) anchor = s.anchor;
		}),
	);

	const grid = $derived(monthGrid(anchor, settings.firstDayOfWeek));
	const range = $derived.by(() => {
		if (mode === "month") return grid.daysInView;
		if (mode === "week") return weekRange(anchor, settings.firstDayOfWeek);
		if (mode === "3days") return { from: anchor, to: addDaysIso(anchor, DAYS3_PAGE_DAYS - 1) };
		if (mode === "day") return { from: anchor, to: anchor };
		return { from: anchor, to: addDaysIso(anchor, AGENDA_PAGE_DAYS - 1) };
	});

	// Store пересоздаётся при смене диапазона: (from, to) входят в QuerySpec,
	// живой store на диапазон — подписка внутри $effect с отпиской при пересоздании.
	let rangeTasks = $state<Task[]>([]);
	$effect(() => {
		// namespace$ — стабильная ссылка (не реактивная зависимость $effect): стор
		// пересоздаётся лишь на смену диапазона, смену пространства он ловит своей
		// внутренней подпиской (ось nsKey мемо-ключа).
		const store = calendarRangeStore(
			taskStore,
			range.from,
			range.to,
			settings.calendarPlacement,
			settings.debounceMs.queryRecompute,
			namespace$,
		);
		return store.subscribe((v) => {
			rangeTasks = v;
		});
	});

	// Просроченные: события АКТИВНОГО пространства с датой < today; пересоздание на смене дня.
	let overdueRaw = $state<Task[]>([]);
	$effect(() => {
		const store = calendarRangeStore(
			taskStore,
			"0001-01-01",
			addDaysIso($today, -1),
			settings.calendarPlacement,
			settings.debounceMs.queryRecompute,
			namespace$,
		);
		return store.subscribe((v) => {
			overdueRaw = v;
		});
	});

	// Серии-события (container events) — из индекса, реактивно по epoch И по смене
	// локального пространства. В calendar-range QueryEngine их не отдаёт: рендерим
	// ОТДЕЛЬНО как виртуальные вхождения (expandEventOccurrences). Видимость события —
	// eventVisibleInNamespace: серии активного ns ∪ «общие» события (DEFAULT_NS видны
	// в ЛЮБОМ календаре); ALL_NS («Все») — все. Задач это НЕ касается (обычный
	// inNamespace режет их по пространству) — общие задачи в чужой календарь не текут.
	let eventSeries = $state<Task[]>([]);
	$effect(() => {
		const recompute = (filter: NamespaceFilter): void => {
			const out: Task[] = [];
			for (const t of taskStore.index().all())
				if (
					t.container === "events" &&
					eventVisibleInNamespace(t.filePath, t.nsOverride ?? null, filter)
				)
					out.push(t);
			eventSeries = out;
		};
		let filter = get(namespace$);
		const unsubNs = namespace$.subscribe((f) => {
			filter = f;
			recompute(filter);
		});
		const unsubEpoch = taskStore.epoch.subscribe(() => recompute(filter));
		return () => {
			unsubNs();
			unsubEpoch();
		};
	});
	const eventsByDay = $derived(expandEventOccurrences(eventSeries, range.from, range.to));

	// --- статусы дней (покраска календаря) ---
	let dsModel = $state<DayStatusModel>(EMPTY_DAY_STATUS_MODEL);
	$effect(() => dayStatus?.model.subscribe((m) => (dsModel = m)));
	/** Статус (имя+цвет) даты или null — читает реактивную модель. */
	const dsFor = (date: IsoDate): { name: string; color: string } | null =>
		dayStatus === null ? null : statusForDate(dsModel, date);
	/** Активное превью диапазона покраски (подсветка во время протяжки). */
	let dsPreview = $state<PaintPreview | null>(null);
	const dsInPreview = (date: IsoDate): boolean =>
		dsPreview !== null && date >= dsPreview.from && date <= dsPreview.to;
	const paint = createPaintController({
		app,
		port: () => dayStatus,
		setPreview: (p) => (dsPreview = p),
	});

	const byDay = $derived(placeEvents(rangeTasks, settings.calendarPlacement));
	const overdue = $derived(openTasks(overdueRaw));
	// placeEvents сохраняет порядок вставки, вход отсортирован по дате — entries по возрастанию
	const overdueEntries = $derived(
		Array.from(placeEvents(overdue, settings.calendarPlacement).entries()),
	);

	const title = $derived(
		mode === "month"
			? monthTitle(anchor)
			: mode === "day"
				? agendaLabel(anchor)
				: `${range.from} — ${range.to}`,
	);

	/** Число колонок почасовой сетки: день — 1, «3 дня» — 3, «Неделя» — 7. */
	const timeGridDays = $derived(
		mode === "day" ? 1 : mode === "week" ? WEEK_DAYS : DAYS3_PAGE_DAYS,
	);

	const MODE_ORDER: readonly { id: CalendarMode; label: string }[] = [
		{ id: "month", label: "Месяц" },
		{ id: "week", label: "Неделя" },
		{ id: "agenda", label: "Агенда" },
		{ id: "3days", label: "3 дня" },
		{ id: "day", label: "День" },
	];

	function persistNow(): void {
		persist({ mode, anchor });
	}

	function setMode(m: CalendarMode): void {
		mode = m;
		persistNow();
	}

	function goToday(): void {
		anchor = $today;
		persistNow();
	}

	/** Шаг листания: день — ±1, «3 дня» — ±3 (страницей, без перекрытия). */
	function goPrev(): void {
		anchor =
			mode === "month"
				? prevMonth(anchor)
				: mode === "week"
					? prevWeek(anchor)
					: mode === "agenda"
						? prevAgenda(anchor)
						: addDaysIso(anchor, mode === "day" ? -1 : -DAYS3_PAGE_DAYS);
		persistNow();
	}

	function goNext(): void {
		anchor =
			mode === "month"
				? nextMonth(anchor)
				: mode === "week"
					? nextWeek(anchor)
					: mode === "agenda"
						? nextAgenda(anchor)
						: addDaysIso(anchor, mode === "day" ? 1 : DAYS3_PAGE_DAYS);
		persistNow();
	}

	/** Drop на день/слот (ТЗ §8): двигаем поле, по которому задача видна в
	 *  календаре, иначе первое из settings.calendarPlacement.
	 *  time: undefined — drop на день (существующее время поля сохраняется,
	 *  контракт SetDate/setField: undefined = не трогать, перенос «14:30-задачи»
	 *  на другой день оставляет 14:30, интервал «14:30-16:00» — целиком);
	 *  строка — слот time-grid (точное время); null — полоса «Весь день»
	 *  time-grid (время снимается, конец интервала setField снимает сам). */
	async function dropTask(taskKey: string, date: IsoDate, time?: string | null): Promise<void> {
		const task = taskStore.index().get(taskKey);
		if (task === undefined) {
			new Notice("GTD Flow: задача не найдена");
			return;
		}
		const field = dropDateField(task, settings.calendarPlacement);
		// Конец интервала при drop на слот тайм-сетки (dropTimeEnd):
		//  • блок с длительностью тянет конец за собой (новый старт + прежняя
		//    длительность) — явно, а не undefined: setField при undefined сохранил
		//    бы СТАРЫЙ конец, который после переноса может оказаться не позже
		//    нового начала (throw);
		//  • карточка БЕЗ времени поля-размещения (входящие/доска/полоса «Весь
		//    день») получает дефолтные 30 минут: time = слот, timeEnd = слот+30;
		//  • перенос уже-таймированного блока БЕЗ конца — конец не появляется.
		const timeEnd =
			typeof time === "string"
				? dropTimeEnd(placedTime(task, field), placedTimeEnd(task, field), time)
				: undefined;
		// «🛫 и 📅 взаимоисключающие»: планирование реально отложенной задачи
		// (🛫 в будущем) возвращает её из отложенных — с подтверждением и одной
		// атомарной записью. Инертный 🛫 в прошлом конфликтом не считается.
		let clearStart = false;
		if (field === "due" && task.start !== null && task.start > $today) {
			const ok = await confirm(
				app,
				"Вернуть из отложенных?",
				`Задача отложена до ${task.start}. Запланированная задача не может ` +
					`оставаться отложенной: запланировать на ${date} и вернуть из отложенных?`,
				"Запланировать и вернуть",
			);
			if (!ok) return;
			clearStart = true;
		}
		const res = await dispatcher.dispatch({
			type: "set-date",
			key: taskKey,
			field,
			date,
			time,
			timeEnd,
			clearStart,
		});
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
		else if (clearStart) new Notice(`Запланирована на ${date}, возвращена из отложенных`);
	}

	/** Быстрый ввод: `- [ ] <текст> 📅 <дата>[ HH:mm[-HH:mm]]` в первый файл захвата
	 *  (gtd-inbox, фолбэк <commonRoot>/Входящие.md для «Общего»); цель — В МОМЕНТ ввода.
	 *  timeEnd — из click-drag по слоту сетки (задаёт длительность события сразу). */
	async function quickAdd(
		date: IsoDate,
		text: string,
		time: string | null = null,
		timeEnd: string | null = null,
		location: string | null = null,
	): Promise<void> {
		const line = quickAddLine(text, date, time, timeEnd, location);
		if (line === null) return;
		// цель захвата — В ЛОКАЛЬНОМ пространстве вида, В МОМЕНТ ввода: его первый
		// gtd-inbox файл, иначе конвенционные Входящие.md: <root>/ (именованное) или
		// <commonRoot>/ («Общее» — nsCommonTarget подставляет корень «Общего»).
		// В режиме «Все» (ALL_NS) конкретного пространства нет — пишем в ГЛОБАЛЬНЫЙ
		// дефолт (settings.activeNamespace) и уведомляем, в какое пространство ушло.
		const local = get(activeNamespace);
		const allMode = local === ALL_NS;
		const active = allMode ? settings.activeNamespace : local;
		const fallback = nsCommonTarget(active, namespaces, NS_CONVENTION.inbox, settings.commonRoot);
		const target = captureTargetInNamespace(taskStore.index().all(), active, namespaces, fallback);
		if (target === "") {
			new Notice("GTD Flow: не задан файл входящих (пустая «Корневая папка Общего»)");
			return;
		}
		// файл входящих создаётся и помечается gtd-inbox: true (+ gtd-namespace для
		// файла-исключения вне корня пространства) СТРОГО до записи строки
		if (!(await ensureCaptureFileNs(vault, target, active, namespaces))) {
			new Notice(`GTD Flow: не удалось подготовить файл входящих ${target}`);
			return;
		}
		const ok = await vault.processFile(target, (content) => appendLine(content, line));
		if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}`);
		else if (allMode) new Notice(`Добавлено в пространство «${namespaceLabel(active)}»`);
	}

	/** Инлайн-создание СОБЫТИЯ из поля ввода (сегмент «Событие»): одноразовое событие
	 *  `- [ ] <текст> 📅 <дата>[ HH:mm[-HH:mm]]` в файле событий ЛОКАЛЬНОГО пространства
	 *  вида — В МОМЕНТ ввода. Цель: <root>/События.md (именованное), settings.eventsFile
	 *  («Общее»), <commonRoot>/События.md (вкладка «Все» — ALL_NS; конкретного
	 *  пространства нет, пишем в «дом» «Общего»). Файл создаётся с frontmatter
	 *  gtd-events:true, если его нет. time/timeEnd — из слота/протяжки тайм-сетки
	 *  (в месячной сетке и полосе «Весь день» — null: событие без времени). */
	async function quickAddEvent(
		date: IsoDate,
		text: string,
		time: string | null = null,
		timeEnd: string | null = null,
		location: string | null = null,
	): Promise<void> {
		if (text.trim() === "") return;
		const eventsFile = eventTargetForNamespace(
			get(activeNamespace),
			namespaces,
			settings.eventsFile,
			settings.commonRoot,
		);
		const res = await createSingleEvent({
			vault,
			eventsFile,
			name: text,
			date,
			time,
			timeEnd,
			location,
		});
		if (res.ok) new Notice("GTD Flow: событие создано");
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	/** Drop блока-вхождения события на слот тайм-сетки: перенос на дату колонки +
	 *  время слота с сохранением длительности вхождения. ОДНА атомарная запись в
	 *  файле событий (см. transferEventOccurrence): серия гасит вхождение через 🚫
	 *  и порождает одноразовую строку, одноразовое — правит собственную 📅. */
	async function moveOccurrence(
		taskKey: string,
		occ: OccurrenceDrag,
		date: IsoDate,
		time: string,
	): Promise<void> {
		const task = taskStore.index().get(taskKey);
		if (task === undefined) {
			new Notice("GTD Flow: событие не найдено");
			return;
		}
		// конец = новый старт + прежняя длительность (null, если её не было)
		const timeEnd = preservedTimeEnd(occ.time, occ.timeEnd, time) ?? null;
		const res = await transferEventOccurrence({
			vault,
			task,
			kind: occ.kind,
			fromDate: occ.date,
			toDate: date,
			time,
			timeEnd,
		});
		if (res.ok) new Notice(`Перенесено: ${occ.date} → ${date}`);
		else new Notice(`GTD Flow: ${res.reason}`);
	}

	/** ПКМ по пустому месту → «Повторяющееся событие…»: модал → createEventSeries.
	 *  time — из слота тайм-сетки (prefill), null для DayCell (месяц/неделя/агенда). */
	function createEvent(date: IsoDate, time: string | null): void {
		// цель серии — файл событий ЛОКАЛЬНОГО пространства вида: <root>/События.md
		// (именованное) или settings.eventsFile («Общее»); в режиме «Все» (ALL_NS)
		// конкретного пространства нет — создаём в ГЛОБАЛЬНОМ дефолте. Берём в момент ПКМ.
		const local = get(activeNamespace);
		const active = local === ALL_NS ? settings.activeNamespace : local;
		const eventsFile = nsTargetPath(active, namespaces, NS_CONVENTION.events, settings.eventsFile);
		new EventSeriesModal(
			app,
			{ name: "", rule: "", time: time ?? "", location: "" },
			`Новое событие · ${date}`,
			(name, ruleText, location) => {
				// weekly n>1 с byDay без from → дописать 'from <дата ПКМ>': закрепляет
				// чётность недель новой серии (иначе фаза опиралась бы на эпоха-фолбэк)
				void createEventSeries({
					vault,
					eventsFile,
					name,
					ruleText: withSeriesAnchor(ruleText, date),
					location,
				}).then((res) => {
					if (res.ok) new Notice("GTD Flow: событие создано");
					else new Notice(`GTD Flow: ${res.reason}`);
				});
			},
		).open();
	}
</script>

<div class="gtd-cal">
	<div class="gtd-cal-header">
		<div class="gtd-cal-nav">
			<button aria-label="Назад" onclick={goPrev}>‹</button>
			<button onclick={goToday}>Сегодня</button>
			<button aria-label="Вперёд" onclick={goNext}>›</button>
		</div>
		<span class="gtd-cal-title">{title}{nsLabel !== null ? ` · ${nsLabel}` : ""}</span>
		{#if overdue.length > 0}
			<button
				class="gtd-cal-overdue"
				title="Просроченных задач: {overdue.length} — показать в агенде"
				onclick={() => setMode("agenda")}
			>
				⚠ {overdue.length}
			</button>
		{/if}
		<div class="gtd-cal-modes">
			{#each MODE_ORDER as m (m.id)}
				<button class:is-active={mode === m.id} onclick={() => setMode(m.id)}>{m.label}</button>
			{/each}
		</div>
		<!-- allowAll — вкладка «Все» (агрегат всех пространств), только у календаря -->
		<NamespaceSwitcher active={activeNamespace} {namespaces} onSelect={setActiveNamespace} allowAll={true} />
	</div>

	{#if mode === "agenda"}
		<div class="gtd-cal-agenda">
			{#if overdueEntries.length > 0}
				<section class="gtd-cal-agenda-overdue">
					<div class="gtd-cal-agenda-head is-overdue">Просроченные</div>
					<div class="gtd-cal-agenda-overdue-list">
						{#each overdueEntries as [date, list] (date)}
							{#each list as ev (ev.task.key)}
								<EventChip
									{ev}
									today={$today}
									{dnd}
									{dispatcher}
									{app}
									{settings}
									{menuPorts}
									showDate={date}
								/>
							{/each}
						{/each}
					</div>
				</section>
			{/if}
			{#each agendaDays(range.from, AGENDA_PAGE_DAYS) as date (date)}
				<DayCell
					{date}
					today={$today}
					label={agendaLabel(date)}
					events={byDay.get(date) ?? []}
					eventOccurrences={eventsByDay.get(date) ?? []}
					nowMinutes={nowMin}
					{dnd}
					{dispatcher}
					{app}
					{settings}
					{vault}
					{menuPorts}
					statusColor={dsFor(date)?.color ?? null}
					statusName={dsFor(date)?.name ?? null}
					onDropTask={dropTask}
					onQuickAdd={(date, text, location) => quickAdd(date, text, null, null, location)}
					onQuickAddEvent={(date, text, location) =>
						quickAddEvent(date, text, null, null, location)}
					onCreateEvent={createEvent}
					{quickAddKind}
					onQuickAddKindChange={setQuickAddKind}
				/>
			{/each}
		</div>
	{:else if mode === "day" || mode === "3days" || mode === "week"}
		<TimeGrid
			days={agendaDays(range.from, timeGridDays)}
			today={$today}
			nowMinutes={nowMin}
			{byDay}
			{eventsByDay}
			{dnd}
			{dispatcher}
			{app}
			{settings}
			{vault}
			{menuPorts}
			dayStatusColor={dsFor}
			dayStatusPainting={dsInPreview}
			paintHandlers={dayStatus === null ? null : paint}
			onDropTask={dropTask}
			onQuickAdd={quickAdd}
			onQuickAddEvent={quickAddEvent}
			onCreateEvent={createEvent}
			onMoveOccurrence={moveOccurrence}
			{quickAddKind}
			onQuickAddKindChange={setQuickAddKind}
		/>
	{:else}
		<div class="gtd-cal-weekdays">
			{#each weekdayNames(settings.firstDayOfWeek) as name (name)}
				<div class="gtd-cal-weekday">{name}</div>
			{/each}
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="gtd-cal-grid"
			onpointerdown={paint.pointerdown}
			onpointermove={paint.pointermove}
			onpointerup={paint.pointerup}
			onpointercancel={paint.pointercancel}
		>
			{#each grid.weeks as week (week[0])}
				{#each week as date (date)}
					<DayCell
						{date}
						today={$today}
						muted={date.slice(0, 7) !== anchor.slice(0, 7)}
						compact={true}
						events={byDay.get(date) ?? []}
						eventOccurrences={eventsByDay.get(date) ?? []}
						{dnd}
						{dispatcher}
						{app}
						{settings}
						{vault}
						{menuPorts}
						statusColor={dsFor(date)?.color ?? null}
						statusName={dsFor(date)?.name ?? null}
						painting={dsInPreview(date)}
						onDropTask={dropTask}
						onQuickAdd={(date, text, location) => quickAdd(date, text, null, null, location)}
						onQuickAddEvent={(date, text, location) =>
							quickAddEvent(date, text, null, null, location)}
						onCreateEvent={createEvent}
						{quickAddKind}
						onQuickAddKindChange={setQuickAddKind}
					/>
				{/each}
			{/each}
		</div>
	{/if}
</div>

<style>
	.gtd-cal {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-cal-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-cal-nav {
		display: flex;
		gap: 2px;
	}
	.gtd-cal-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.gtd-cal-overdue {
		flex: none;
		border: none;
		box-shadow: none;
		background: transparent;
		color: var(--text-warning, var(--text-muted));
		cursor: pointer;
		padding: 1px 6px;
		border-radius: var(--radius-s, 4px);
	}
	.gtd-cal-overdue:hover {
		background: var(--background-modifier-hover);
	}
	.gtd-cal-modes {
		flex: none;
		display: flex;
		gap: 2px;
	}
	.gtd-cal-modes button.is-active {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}
	.gtd-cal-weekdays {
		flex: none;
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		padding: 4px 10px 0;
	}
	.gtd-cal-weekday {
		text-align: center;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-cal-grid {
		flex: 1 1 auto;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		grid-auto-rows: minmax(0, 1fr);
		overflow-y: auto;
		padding: 3px 10px 10px 11px; /* +1px слева под схлопнутые рамки ячеек */
	}
	.gtd-cal-agenda {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 3px 10px 10px 11px;
	}
	.gtd-cal-agenda-overdue {
		margin-bottom: 8px;
		border: 1px solid var(--text-warning, var(--background-modifier-border));
		border-radius: var(--radius-m, 8px);
		padding: 4px 6px;
	}
	.gtd-cal-agenda-head {
		font-weight: 600;
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
		padding: 2px 0;
	}
	.gtd-cal-agenda-head.is-overdue {
		color: var(--text-warning, var(--text-muted));
	}
	.gtd-cal-agenda-overdue-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
</style>
