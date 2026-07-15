import { describe, expect, it } from "vitest";
import {
	DEFAULT_SCROLL_MIN,
	EVENT_DURATION_MIN,
	GRID_END_MIN,
	GRID_START_MIN,
	MINUTES_PER_DAY,
	layoutDay,
	minutesFromOffsetY,
	minutesToTime,
	snapMinutes,
	timeToMinutes,
	type TimedEventInput,
} from "./timeGrid";

function ev(key: string, time: string | null): TimedEventInput {
	return { key, time };
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
