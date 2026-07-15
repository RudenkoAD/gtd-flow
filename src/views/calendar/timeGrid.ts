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
/** Фиксированная визуальная длительность блока: у задач длительности нет. */
export const EVENT_DURATION_MIN = 45;
/** Шаг снапа времени при drag и quick-add. */
export const SNAP_STEP_MIN = 15;

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
}

export interface TimedBlock {
	key: string;
	startMin: number;
	/** Позиция РОВНО по времени: top = минуты/1440 в процентах высоты сетки. */
	topPct: number;
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
 * позиции; интервалы фиксированной длительности EVENT_DURATION_MIN,
 * перекрывающиеся — жадно по дорожкам: блок идёт в первую дорожку, чей
 * хвост уже закончился, иначе открывает новую. Кластер пересечений
 * закрывается, когда очередное событие начинается не раньше максимального
 * конца кластера; laneCount у всех блоков кластера общий (ширина = 1/laneCount).
 * Конец интервала исключающий: 10:00–10:45 и блок в 10:45 НЕ пересекаются.
 */
export function layoutDay(events: readonly TimedEventInput[]): DayGridLayout {
	const allDay: string[] = [];
	const timedIn: { key: string; startMin: number; order: number }[] = [];
	events.forEach((ev, i) => {
		const min = ev.time === null ? null : timeToMinutes(ev.time);
		if (min === null) allDay.push(ev.key);
		else timedIn.push({ key: ev.key, startMin: min, order: i });
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
		const end = ev.startMin + EVENT_DURATION_MIN;
		laneEnds[lane] = end;
		if (end > clusterMaxEnd) clusterMaxEnd = end;
		blocks.push({
			key: ev.key,
			startMin: ev.startMin,
			topPct: (ev.startMin / MINUTES_PER_DAY) * 100,
			laneIndex: lane,
			laneCount: 1, // проставится при закрытии кластера
		});
	}
	closeCluster();
	return { timed: blocks, allDay };
}
