import { describe, expect, it } from "vitest";
import {
	DEFAULT_DROP_DURATION_MIN,
	DEFAULT_SCROLL_MIN,
	EVENT_DURATION_MIN,
	GRID_END_MIN,
	GRID_START_MIN,
	MINUTES_PER_DAY,
	dropTimeEnd,
	layoutDay,
	minutesFromOffsetY,
	minutesOfDay,
	minutesToTime,
	preservedTimeEnd,
	resizeEndMin,
	showNowLine,
	snapMinutes,
	timeToMinutes,
	timeTopPct,
	type TimedEventInput,
} from "./timeGrid";

function ev(key: string, time: string | null, timeEnd: string | null = null): TimedEventInput {
	return { key, time, timeEnd };
}

describe("константы сетки", () => {
	it("сутки 00:00–24:00, автоскролл к 08:00", () => {
		expect(GRID_START_MIN).toBe(0);
		expect(GRID_END_MIN).toBe(1440);
		expect(MINUTES_PER_DAY).toBe(1440);
		expect(DEFAULT_SCROLL_MIN).toBe(480);
	});
});

describe("timeToMinutes", () => {
	it("границы суток и обычные значения", () => {
		expect(timeToMinutes("00:00")).toBe(0);
		expect(timeToMinutes("08:30")).toBe(510);
		expect(timeToMinutes("14:30")).toBe(870);
		expect(timeToMinutes("23:59")).toBe(1439);
	});

	it("не-время — null (тот же формат, что у парсера задач)", () => {
		expect(timeToMinutes("24:00")).toBeNull();
		expect(timeToMinutes("8:30")).toBeNull();
		expect(timeToMinutes("12:60")).toBeNull();
		expect(timeToMinutes("aa:bb")).toBeNull();
		expect(timeToMinutes("")).toBeNull();
		expect(timeToMinutes("12:345")).toBeNull();
	});
});

describe("minutesToTime", () => {
	it("обратен timeToMinutes", () => {
		expect(minutesToTime(0)).toBe("00:00");
		expect(minutesToTime(510)).toBe("08:30");
		expect(minutesToTime(1439)).toBe("23:59");
	});

	it("вне суток — клампится, дробные — усекаются", () => {
		expect(minutesToTime(-5)).toBe("00:00");
		expect(minutesToTime(1440)).toBe("23:59");
		expect(minutesToTime(90.9)).toBe("01:30");
	});
});

describe("snapMinutes", () => {
	it("округляет к ближайшему шагу 15", () => {
		expect(snapMinutes(0)).toBe(0);
		expect(snapMinutes(7)).toBe(0);
		expect(snapMinutes(8)).toBe(15);
		expect(snapMinutes(870)).toBe(870);
		expect(snapMinutes(877)).toBe(870);
		expect(snapMinutes(878)).toBe(885);
	});

	it("низ сетки не даёт несуществующего 24:00", () => {
		expect(snapMinutes(1439)).toBe(1425);
		expect(snapMinutes(1433)).toBe(1425);
	});

	it("кастомный шаг", () => {
		expect(snapMinutes(50, 30)).toBe(60);
		expect(snapMinutes(44, 30)).toBe(30);
		expect(snapMinutes(1439, 60)).toBe(1380);
	});
});

describe("minutesFromOffsetY", () => {
	const H = 1152; // 24ч × 48px

	it("линейное отображение высоты в минуты", () => {
		expect(minutesFromOffsetY(0, H)).toBe(0);
		expect(minutesFromOffsetY(H / 2, H)).toBe(720);
		expect(minutesFromOffsetY(H / 3, H)).toBe(480);
	});

	it("края: выше сетки — 0, ниже — 1439 (не 1440)", () => {
		expect(minutesFromOffsetY(-10, H)).toBe(0);
		expect(minutesFromOffsetY(H, H)).toBe(1439);
		expect(minutesFromOffsetY(H + 100, H)).toBe(1439);
	});

	it("вырожденная высота — 0", () => {
		expect(minutesFromOffsetY(100, 0)).toBe(0);
		expect(minutesFromOffsetY(100, -5)).toBe(0);
	});
});

describe("линия текущего времени (§сегодня)", () => {
	it("minutesOfDay — локальные часы:минуты в минуты от полуночи (секунды отброшены)", () => {
		expect(minutesOfDay(new Date(2026, 6, 20, 0, 0, 0))).toBe(0);
		expect(minutesOfDay(new Date(2026, 6, 20, 8, 30, 45))).toBe(510);
		expect(minutesOfDay(new Date(2026, 6, 20, 14, 30, 0))).toBe(870);
		expect(minutesOfDay(new Date(2026, 6, 20, 23, 59, 59))).toBe(1439);
	});

	it("timeTopPct — минуты→% высоты сетки, тот же маппинг, что у topPct блоков", () => {
		expect(timeTopPct(0)).toBe(0);
		expect(timeTopPct(720)).toBe(50); // полдень — середина суток
		expect(timeTopPct(540)).toBe(37.5); // 09:00 == topPct блока в 09:00
		expect(timeTopPct(MINUTES_PER_DAY)).toBe(100);
	});

	it("timeTopPct — кламп вне суток в [0,100]", () => {
		expect(timeTopPct(-30)).toBe(0);
		expect(timeTopPct(MINUTES_PER_DAY + 100)).toBe(100);
	});

	it("showNowLine — линия только в колонке сегодня и при валидном времени", () => {
		expect(showNowLine("2026-07-20", "2026-07-20", 870)).toBe(true);
		// не сегодня → нет линии
		expect(showNowLine("2026-07-19", "2026-07-20", 870)).toBe(false);
		expect(showNowLine("2026-07-21", "2026-07-20", 870)).toBe(false);
		// нет времени (null) → нет линии даже в колонке сегодня
		expect(showNowLine("2026-07-20", "2026-07-20", null)).toBe(false);
	});
});

describe("layoutDay — позиционирование ровно по времени", () => {
	it("top = минуты/1440 в процентах", () => {
		const { timed } = layoutDay([ev("a", "09:00"), ev("b", "00:00"), ev("c", "23:30")]);
		const byKey = new Map(timed.map((t) => [t.key, t]));
		expect(byKey.get("b")!.topPct).toBe(0);
		expect(byKey.get("a")!.topPct).toBe(37.5); // 540/1440
		expect(byKey.get("a")!.startMin).toBe(540);
		expect(byKey.get("c")!.topPct).toBeCloseTo((1410 / 1440) * 100, 10);
	});

	it("границы суток: 00:00 и 23:xx — валидные блоки", () => {
		const { timed, allDay } = layoutDay([ev("mid", "00:00"), ev("late", "23:59")]);
		expect(allDay).toEqual([]);
		expect(timed[0]!.key).toBe("mid");
		expect(timed[1]!.key).toBe("late");
		expect(timed[1]!.startMin).toBe(1439);
	});

	it("события без времени → allDay, порядок входа сохранён", () => {
		const { timed, allDay } = layoutDay([
			ev("x", null),
			ev("a", "10:00"),
			ev("y", null),
		]);
		expect(allDay).toEqual(["x", "y"]);
		expect(timed.map((t) => t.key)).toEqual(["a"]);
	});

	it("нераспознанное время — защитно в allDay, дату не ломает", () => {
		const { timed, allDay } = layoutDay([ev("bad", "25:00"), ev("ok", "12:00")]);
		expect(allDay).toEqual(["bad"]);
		expect(timed.map((t) => t.key)).toEqual(["ok"]);
	});

	it("пустой вход — пустая раскладка", () => {
		expect(layoutDay([])).toEqual({ timed: [], allDay: [] });
	});
});

describe("layoutDay — реальная длительность (timeEnd)", () => {
	it("событие с концом: высота = (end − start) минуты, endMin реальный", () => {
		const { timed } = layoutDay([ev("a", "14:30", "16:00")]);
		const a = timed[0]!;
		expect(a.startMin).toBe(870);
		expect(a.endMin).toBe(960);
		expect(a.hasEnd).toBe(true);
		expect(a.heightPct).toBeCloseTo((90 / 1440) * 100, 10);
	});

	it("без конца — прежняя визуальная длительность 45 мин", () => {
		const { timed } = layoutDay([ev("a", "10:00")]);
		expect(timed[0]!.endMin).toBe(645);
		expect(timed[0]!.hasEnd).toBe(false);
		expect(timed[0]!.heightPct).toBeCloseTo((EVENT_DURATION_MIN / 1440) * 100, 10);
	});

	it("timeEnd не передан (поле опционально) — как без конца", () => {
		const { timed } = layoutDay([{ key: "a", time: "10:00" }]);
		expect(timed[0]!.endMin).toBe(645);
		expect(timed[0]!.hasEnd).toBe(false);
	});

	it("битый конец — защитно игнорируется, начало не ломает", () => {
		const { timed, allDay } = layoutDay([ev("a", "10:00", "25:00"), ev("b", "11:00", "xx")]);
		expect(allDay).toEqual([]);
		expect(timed.map((t) => [t.key, t.hasEnd, t.endMin - t.startMin])).toEqual([
			["a", false, EVENT_DURATION_MIN],
			["b", false, EVENT_DURATION_MIN],
		]);
	});

	it("конец не позже начала — игнорируется (контракт: строго позже)", () => {
		const { timed } = layoutDay([ev("a", "10:00", "10:00"), ev("b", "12:00", "11:00")]);
		expect(timed.map((t) => t.hasEnd)).toEqual([false, false]);
		expect(timed.map((t) => t.endMin - t.startMin)).toEqual([
			EVENT_DURATION_MIN,
			EVENT_DURATION_MIN,
		]);
	});

	it("хвост суток: 45-минутный дефолт от 23:30 капнут к 24:00", () => {
		const { timed } = layoutDay([ev("a", "23:30")]);
		expect(timed[0]!.endMin).toBe(MINUTES_PER_DAY);
		expect(timed[0]!.topPct + timed[0]!.heightPct).toBeCloseTo(100, 10);
	});
});

describe("layoutDay — дорожки по РЕАЛЬНЫМ интервалам", () => {
	it("длинное событие пересекает то, что фикс-45 не задел бы", () => {
		// a 10:00–12:00; b 11:30 (при фикс. 45 мин a кончился бы в 10:45)
		const { timed } = layoutDay([ev("a", "10:00", "12:00"), ev("b", "11:30")]);
		expect(timed.map((t) => [t.key, t.laneIndex, t.laneCount])).toEqual([
			["a", 0, 2],
			["b", 1, 2],
		]);
	});

	it("короткое событие освобождает дорожку раньше 45 мин", () => {
		// a 10:00–10:15; b 10:20 — при фикс. 45 пересеклись бы, реально нет
		const { timed } = layoutDay([ev("a", "10:00", "10:15"), ev("b", "10:20")]);
		expect(timed.map((t) => [t.laneIndex, t.laneCount])).toEqual([
			[0, 1],
			[0, 1],
		]);
	});

	it("конец исключающий и для реальных интервалов: 10:00–10:30 и 10:30", () => {
		const { timed } = layoutDay([ev("a", "10:00", "10:30"), ev("b", "10:30")]);
		expect(timed.map((t) => [t.laneIndex, t.laneCount])).toEqual([
			[0, 1],
			[0, 1],
		]);
	});

	it("кластер держится, пока идёт длинное: 09:00–12:00 накрывает 10:00 и 11:00", () => {
		const { timed } = layoutDay([
			ev("long", "09:00", "12:00"),
			ev("b", "10:00"),
			ev("c", "11:00"),
		]);
		// b 10:00–10:45 (lane 1); c 11:00 ≥ 10:45 — переиспользует lane 1;
		// кластер общий (clusterMaxEnd 12:00) — laneCount 2 у всех
		expect(timed.map((t) => [t.key, t.laneIndex, t.laneCount])).toEqual([
			["long", 0, 2],
			["b", 1, 2],
			["c", 1, 2],
		]);
	});
});

describe("resizeEndMin — снап конца при resize за нижний край", () => {
	it("снап к 15 минутам", () => {
		expect(resizeEndMin(877, 600)).toBe(870);
		expect(resizeEndMin(878, 600)).toBe(885);
	});

	it("минимум start + 15", () => {
		expect(resizeEndMin(600, 600)).toBe(615);
		expect(resizeEndMin(0, 600)).toBe(615);
		expect(resizeEndMin(607, 600)).toBe(615); // снап 600 == start → поднимается
	});

	it("низ сетки — потолок 1440 (в строку уйдёт «23:59» через minutesToTime)", () => {
		expect(resizeEndMin(1439, 600)).toBe(1440);
		expect(minutesToTime(resizeEndMin(1439, 600))).toBe("23:59");
	});
});

describe("preservedTimeEnd — перенос блока сохраняет длительность", () => {
	it("новый старт + прежняя длительность", () => {
		expect(preservedTimeEnd("14:30", "16:00", "09:00")).toBe("10:30");
		expect(preservedTimeEnd("08:00", "08:15", "23:00")).toBe("23:15");
	});

	it("длительности не было — undefined (timeEnd интента не трогаем)", () => {
		expect(preservedTimeEnd("14:30", null, "09:00")).toBeUndefined();
		expect(preservedTimeEnd(null, null, "09:00")).toBeUndefined();
	});

	it("битые значения — undefined, а не мусор в set-date", () => {
		expect(preservedTimeEnd("xx", "16:00", "09:00")).toBeUndefined();
		expect(preservedTimeEnd("14:30", "24:60", "09:00")).toBeUndefined();
		expect(preservedTimeEnd("16:00", "14:30", "09:00")).toBeUndefined(); // конец ≤ начала
	});

	it("хвост суток: конец клампится к 23:59, вырожденный — undefined", () => {
		// 2 часа от 23:00 не помещаются — кламп к «23:59», но конец валиден
		expect(preservedTimeEnd("10:00", "12:00", "23:00")).toBe("23:59");
		// от 23:59 любой конец вырождается (не строго позже) — без конца
		expect(preservedTimeEnd("10:00", "12:00", "23:59")).toBeUndefined();
	});
});

describe("dropTimeEnd — конец при drop карточки на слот", () => {
	it("дефолт 30 минут: карточка без времени поля-размещения", () => {
		expect(DEFAULT_DROP_DURATION_MIN).toBe(30);
		expect(dropTimeEnd(null, null, "09:00")).toBe("09:30");
		expect(dropTimeEnd(null, null, "14:15")).toBe("14:45");
	});

	it("таймированный блок с длительностью — длительность сохраняется (как preservedTimeEnd)", () => {
		expect(dropTimeEnd("14:30", "16:00", "09:00")).toBe("10:30");
		expect(dropTimeEnd("10:00", "12:00", "23:00")).toBe("23:59");
	});

	it("таймированный блок без конца — конец не появляется (undefined)", () => {
		expect(dropTimeEnd("14:30", null, "09:00")).toBeUndefined();
		expect(dropTimeEnd("08:00", null, "23:45")).toBeUndefined();
	});

	it("хвост суток: слот+30 > 23:59 → без конца (не вырожденный 23:30–23:59)", () => {
		// 23:29 + 30 = 23:59 — ещё влезает
		expect(dropTimeEnd(null, null, "23:29")).toBe("23:59");
		// 23:30 + 30 = 24:00 — вылезает за сутки → без конца
		expect(dropTimeEnd(null, null, "23:30")).toBeUndefined();
		expect(dropTimeEnd(null, null, "23:59")).toBeUndefined();
	});

	it("битый слот — undefined (защита от чужой строки)", () => {
		expect(dropTimeEnd(null, null, "25:00")).toBeUndefined();
	});
});

describe("layoutDay — дорожки пересечений", () => {
	it("непересекающиеся — по одной дорожке во всю ширину", () => {
		const { timed } = layoutDay([ev("a", "09:00"), ev("b", "10:00")]);
		expect(timed.map((t) => [t.laneIndex, t.laneCount])).toEqual([
			[0, 1],
			[0, 1],
		]);
	});

	it("конец интервала исключающий: 10:00 (45 мин) и 10:45 не пересекаются", () => {
		const { timed } = layoutDay([ev("a", "10:00"), ev("b", "10:45")]);
		expect(timed.map((t) => [t.laneIndex, t.laneCount])).toEqual([
			[0, 1],
			[0, 1],
		]);
	});

	it("два пересекающихся — две дорожки у обоих", () => {
		const { timed } = layoutDay([ev("a", "10:00"), ev("b", "10:30")]);
		expect(timed.map((t) => [t.laneIndex, t.laneCount])).toEqual([
			[0, 2],
			[1, 2],
		]);
	});

	it("цепочка 10:00/10:30/11:00 — транзитивный кластер, третий переиспользует дорожку 0", () => {
		const { timed } = layoutDay([ev("a", "10:00"), ev("b", "10:30"), ev("c", "11:00")]);
		// a: 10:00–10:45 (lane 0); b: 10:30–11:15 (lane 1);
		// c 11:00 < clusterMaxEnd 11:15 — тот же кластер, lane 0 свободна с 10:45
		expect(timed.map((t) => [t.key, t.laneIndex, t.laneCount])).toEqual([
			["a", 0, 2],
			["b", 1, 2],
			["c", 0, 2],
		]);
	});

	it("три одновременных — три дорожки", () => {
		const { timed } = layoutDay([ev("a", "10:00"), ev("b", "10:00"), ev("c", "10:00")]);
		expect(timed.map((t) => [t.laneIndex, t.laneCount])).toEqual([
			[0, 3],
			[1, 3],
			[2, 3],
		]);
	});

	it("равное время — стабильный порядок входа", () => {
		const { timed } = layoutDay([ev("b", "10:00"), ev("a", "10:00")]);
		expect(timed.map((t) => t.key)).toEqual(["b", "a"]);
	});

	it("кластеры независимы: пересечение утром не расширяет одиночку днём", () => {
		const { timed } = layoutDay([ev("a", "09:00"), ev("b", "09:20"), ev("c", "14:00")]);
		const byKey = new Map(timed.map((t) => [t.key, t]));
		expect(byKey.get("a")!.laneCount).toBe(2);
		expect(byKey.get("b")!.laneCount).toBe(2);
		expect(byKey.get("c")!.laneCount).toBe(1);
		expect(byKey.get("c")!.laneIndex).toBe(0);
	});

	it("вход не обязан быть отсортирован по времени", () => {
		const { timed } = layoutDay([ev("late", "15:00"), ev("early", "08:00")]);
		expect(timed.map((t) => t.key)).toEqual(["early", "late"]);
	});

	it("фиксированная длительность блока — константа 45 мин", () => {
		expect(EVENT_DURATION_MIN).toBe(45);
	});
});
