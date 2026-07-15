/**
 * Чистая логика time-grid режимов календаря «День»/«3 дня» (ТЗ §4):
 * минуты ↔ "HH:mm", позиция события ровно по времени в сетке суток,
 * жадная раскладка пересечений в дорожки, снап для drag/quick-add.
 * Ноль obsidian/DOM — тестируется в node.
 */

export const MINUTES_PER_DAY = 24 * 60;
export const GRID_START_MIN = 0;
export const GRID_END_MIN = MINUTES_PER_DAY;
/** Автоскролл сетки при открытии — к 08:00. */
export const DEFAULT_SCROLL_MIN = 8 * 60;
/** Визуальная длительность блока БЕЗ конца интервала (timeEnd задаёт реальную). */
export const EVENT_DURATION_MIN = 45;
/** Шаг снапа времени при drag, resize и quick-add. */
export const SNAP_STEP_MIN = 15;
/** Длительность по умолчанию для карточки без времени, брошенной на слот сетки. */
export const DEFAULT_DROP_DURATION_MIN = 30;

/** Тот же формат, что у парсера времени задач: 00:00–23:59. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:mm" → минуты от полуночи; null — не время (защита от чужих строк). */
export function timeToMinutes(time: string): number | null {
	const m = TIME_RE.exec(time);
	if (m === null) return null;
	return Number(m[1]) * 60 + Number(m[2]);
}

/** Минуты от полуночи → "HH:mm"; вне [0, 1439] — клампится ("24:00" не существует). */
export function minutesToTime(min: number): string {
	const clamped = Math.min(Math.max(Math.trunc(min), 0), MINUTES_PER_DAY - 1);
	const h = Math.trunc(clamped / 60);
	const m = clamped % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Снап к ближайшему кратному step; результат в [0, 1440−step]. */
export function snapMinutes(min: number, step = SNAP_STEP_MIN): number {
	const snapped = Math.round(min / step) * step;
	return Math.min(Math.max(snapped, GRID_START_MIN), GRID_END_MIN - step);
}

/** Вертикальное смещение внутри сетки высотой gridHeight → минуты [0, 1439]. */
export function minutesFromOffsetY(offsetY: number, gridHeight: number): number {
	if (gridHeight <= 0) return 0;
	const ratio = Math.min(Math.max(offsetY / gridHeight, 0), 1);
	return Math.min(Math.trunc(ratio * MINUTES_PER_DAY), MINUTES_PER_DAY - 1);
}

export interface TimedEventInput {
	key: string;
	/** "HH:mm" или null — событие без времени (полоса «Весь день»). */
	time: string | null;
	/** "HH:mm" конца интервала. Парсер гарантирует «строго позже начала», но
	 *  раскладка защищается сама: битый или не больший начала конец игнорируется
	 *  (блок получает дефолтные EVENT_DURATION_MIN, дату и начало не ломает). */
	timeEnd?: string | null;
}

export interface TimedBlock {
	key: string;
	startMin: number;
	/** Реальный конец: timeEnd, иначе startMin + EVENT_DURATION_MIN; капнут 24:00. */
	endMin: number;
	/** true — у события валидный собственный конец (рендер «14:30–16:00»). */
	hasEnd: boolean;
	/** Позиция РОВНО по времени: top = минуты/1440 в процентах высоты сетки. */
	topPct: number;
	/** Высота = реальная длительность; читаемый минимум (24px) — забота CSS. */
	heightPct: number;
	laneIndex: number;
	laneCount: number;
}

export interface DayGridLayout {
	timed: TimedBlock[];
	/** Ключи событий без времени (и с нераспознанным временем), порядок входа сохранён. */
	allDay: string[];
}

/**
 * Раскладка одного дня. События со временем становятся блоками на точной
 * позиции; интервал — реальный (timeEnd), у событий без конца — визуальные
 * EVENT_DURATION_MIN. Перекрывающиеся — жадно по дорожкам: блок идёт в первую
 * дорожку, чей хвост уже закончился, иначе открывает новую. Кластер пересечений
 * закрывается, когда очередное событие начинается не раньше максимального
 * конца кластера; laneCount у всех блоков кластера общий (ширина = 1/laneCount).
 * Конец интервала исключающий: 10:00–10:45 и блок в 10:45 НЕ пересекаются.
 */
export function layoutDay(events: readonly TimedEventInput[]): DayGridLayout {
	const allDay: string[] = [];
	const timedIn: { key: string; startMin: number; endMin: number; hasEnd: boolean; order: number }[] =
		[];
	events.forEach((ev, i) => {
		const min = ev.time === null ? null : timeToMinutes(ev.time);
		if (min === null) {
			allDay.push(ev.key);
			return;
		}
		// защитная валидация конца: не время или не строго позже начала — как без конца
		const endRaw = ev.timeEnd == null ? null : timeToMinutes(ev.timeEnd);
		const hasEnd = endRaw !== null && endRaw > min;
		// кламп к 24:00: блок «23:30 + 45 мин» не вылезает за низ сетки
		const endMin = Math.min(hasEnd ? endRaw : min + EVENT_DURATION_MIN, MINUTES_PER_DAY);
		timedIn.push({ key: ev.key, startMin: min, endMin, hasEnd, order: i });
	});
	// стабильно по времени: при равном времени — порядок входа
	timedIn.sort((a, b) => a.startMin - b.startMin || a.order - b.order);

	const blocks: TimedBlock[] = [];
	let laneEnds: number[] = []; // конец последнего блока каждой дорожки кластера
	let clusterFrom = 0; // индекс первого блока текущего кластера в blocks
	let clusterMaxEnd = -1;

	const closeCluster = (): void => {
		for (let i = clusterFrom; i < blocks.length; i++) blocks[i]!.laneCount = laneEnds.length;
	};

	for (const ev of timedIn) {
		if (blocks.length > clusterFrom && ev.startMin >= clusterMaxEnd) {
			closeCluster();
			laneEnds = [];
			clusterFrom = blocks.length;
		}
		let lane = laneEnds.findIndex((end) => end <= ev.startMin);
		if (lane === -1) {
			lane = laneEnds.length;
			laneEnds.push(0);
		}
		laneEnds[lane] = ev.endMin;
		if (ev.endMin > clusterMaxEnd) clusterMaxEnd = ev.endMin;
		blocks.push({
			key: ev.key,
			startMin: ev.startMin,
			endMin: ev.endMin,
			hasEnd: ev.hasEnd,
			topPct: (ev.startMin / MINUTES_PER_DAY) * 100,
			heightPct: ((ev.endMin - ev.startMin) / MINUTES_PER_DAY) * 100,
			laneIndex: lane,
			laneCount: 1, // проставится при закрытии кластера
		});
	}
	closeCluster();
	return { timed: blocks, allDay };
}

// ---------------------------------------------------------------------------
// Resize за нижний край и перенос блока с длительностью
// ---------------------------------------------------------------------------

/**
 * Конец интервала при resize: снап к SNAP_STEP_MIN, минимум startMin + шаг,
 * потолок 1440 («24:00» не существует — minutesToTime отдаст "23:59").
 * Возвращает минуты для live-превью; строку для set-date даёт minutesToTime.
 */
export function resizeEndMin(rawMin: number, startMin: number): number {
	const snapped = Math.round(rawMin / SNAP_STEP_MIN) * SNAP_STEP_MIN;
	return Math.min(Math.max(snapped, startMin + SNAP_STEP_MIN), MINUTES_PER_DAY);
}

/**
 * timeEnd для set-date при drop блока с длительностью на новый слот: новый
 * старт + прежняя длительность (кламп к низу суток). undefined — длительности
 * не было или конец не вычислим: timeEnd интента не трогаем. Считать надо
 * ЯВНО: undefined в setField оставил бы СТАРЫЙ конец, который после переноса
 * может оказаться не позже нового начала.
 */
export function preservedTimeEnd(
	oldTime: string | null,
	oldTimeEnd: string | null,
	newTime: string,
): string | undefined {
	if (oldTime === null || oldTimeEnd === null) return undefined;
	const s = timeToMinutes(oldTime);
	const e = timeToMinutes(oldTimeEnd);
	const n = timeToMinutes(newTime);
	if (s === null || e === null || n === null || e <= s) return undefined;
	const end = minutesToTime(Math.min(n + (e - s), MINUTES_PER_DAY));
	// у самого низа суток длительность не помещается и конец вырождается —
	// лучше без конца, чем невалидный ("HH:mm" лексикографика == хронология)
	return end > newTime ? end : undefined;
}

/**
 * timeEnd для set-date при drop карточки на слот тайм-сетки (Calendar.dropTask):
 * - была длительность (oldTime и oldTimeEnd заданы) — сохраняем её, как перенос
 *   таймированного блока (preservedTimeEnd);
 * - был старт БЕЗ конца (oldTime задан, oldTimeEnd === null) — конец не появляется
 *   (undefined): перенос no-end блока внутри сетки прежнюю логику не меняет;
 * - времени НЕ было вовсе (oldTime === null: карточка из входящих/доски/полосы
 *   «Весь день») — дефолтная длительность 30 минут: конец = слот + 30. Если конец
 *   вылезает за сутки (слот ≥ 23:30, слот+30 > 23:59) — без конца (undefined),
 *   а не вырожденный «23:30–23:59».
 */
export function dropTimeEnd(
	oldTime: string | null,
	oldTimeEnd: string | null,
	newTime: string,
): string | undefined {
	if (oldTime !== null) return preservedTimeEnd(oldTime, oldTimeEnd, newTime);
	const n = timeToMinutes(newTime);
	if (n === null) return undefined;
	const end = n + DEFAULT_DROP_DURATION_MIN;
	return end <= MINUTES_PER_DAY - 1 ? minutesToTime(end) : undefined;
}
