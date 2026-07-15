import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import type { CalendarField } from "../../core/model/projections";
import {
	AGENDA_PAGE_DAYS,
	agendaDays,
	agendaLabel,
	appendLine,
	deferredUntil,
	dropDateField,
	monthGrid,
	monthStart,
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
	sanitizeCalendarState,
	weekRange,
	weekdayNames,
} from "./calendarLogic";
import { addDaysIso } from "../common/dates";

let seq = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
	seq += 1;
	return {
		key: `k${seq}`,
		taskId: null,
		filePath: "Notes/misc.md",
		lineStart: seq,
		lineEnd: seq,
		parentLine: null,
		heading: null,
		description: "тестовая задача",
		rawLine: "- [ ] тестовая задача",
		statusChar: " ",
		due: null,
		scheduled: null,
		start: null,
		dueTime: null,
		scheduledTime: null,
		startTime: null,
		dueTimeEnd: null,
		scheduledTimeEnd: null,
		startTimeEnd: null,
		created: null,
		done: null,
		cancelled: null,
		recurrence: null,
		nextSpawn: null,
		spawnedFrom: null,
		priority: "none",
		dependsOn: [],
		tags: [],
		container: "plain",
		projectActive: true,
		...overrides,
	};
}

const PLACEMENT: CalendarField[] = ["due", "scheduled", "start"];

describe("monthGrid — сетка января 2026 (границы месяца и года)", () => {
	// 2026-01-01 — четверг
	it("firstDayOfWeek=1: сетка начинается с понедельника прошлого года", () => {
		const g = monthGrid("2026-01-15", 1);
		expect(g.daysInView).toEqual({ from: "2025-12-29", to: "2026-02-08" });
		expect(g.weeks[0]![0]).toBe("2025-12-29");
		expect(g.weeks[0]![3]).toBe("2026-01-01");
		expect(g.weeks[5]![6]).toBe("2026-02-08");
	});

	it("firstDayOfWeek=0: та же сетка начинается с воскресенья", () => {
		const g = monthGrid("2026-01-15", 0);
		expect(g.daysInView).toEqual({ from: "2025-12-28", to: "2026-02-07" });
		expect(g.weeks[0]![0]).toBe("2025-12-28");
		expect(g.weeks[0]![4]).toBe("2026-01-01");
	});

	it("всегда 6 недель по 7 подряд идущих дней", () => {
		const g = monthGrid("2026-07-15", 1);
		expect(g.weeks).toHaveLength(6);
		const flat = g.weeks.flat();
		expect(flat).toHaveLength(42);
		for (let i = 1; i < flat.length; i++) {
			expect(flat[i]).toBe(addDaysIso(flat[i - 1]!, 1));
		}
		expect(flat[0]).toBe(g.daysInView.from);
		expect(flat[41]).toBe(g.daysInView.to);
	});

	it("месяц, начинающийся с первого дня недели, не сдвигается назад", () => {
		// 2026-06-01 — понедельник
		const g = monthGrid("2026-06-10", 1);
		expect(g.daysInView.from).toBe("2026-06-01");
	});
});

describe("weekRange", () => {
	it("среда при неделе с понедельника", () => {
		expect(weekRange("2026-07-15", 1)).toEqual({ from: "2026-07-13", to: "2026-07-19" });
	});

	it("та же среда при неделе с воскресенья", () => {
		expect(weekRange("2026-07-15", 0)).toEqual({ from: "2026-07-12", to: "2026-07-18" });
	});

	it("первый день недели — сам себе from", () => {
		expect(weekRange("2026-07-13", 1).from).toBe("2026-07-13");
	});
});

describe("agendaDays", () => {
	it("отдаёт days подряд идущих дат начиная с from", () => {
		expect(agendaDays("2026-07-30", 4)).toEqual([
			"2026-07-30",
			"2026-07-31",
			"2026-08-01",
			"2026-08-02",
		]);
	});

	it("ноль дней — пусто", () => {
		expect(agendaDays("2026-07-15", 0)).toEqual([]);
	});
});

describe("навигация", () => {
	it("prevMonth/nextMonth нормализуют на первое число", () => {
		expect(prevMonth("2026-03-31")).toBe("2026-02-01");
		expect(nextMonth("2026-07-31")).toBe("2026-08-01");
	});

	it("переход через границу года", () => {
		expect(prevMonth("2026-01-15")).toBe("2025-12-01");
		expect(nextMonth("2026-12-05")).toBe("2027-01-01");
	});

	it("prevWeek/nextWeek — ±7 дней", () => {
		expect(prevWeek("2026-01-03")).toBe("2025-12-27");
		expect(nextWeek("2026-12-28")).toBe("2027-01-04");
	});

	it("агенда листается страницей", () => {
		expect(nextAgenda("2026-07-01")).toBe(addDaysIso("2026-07-01", AGENDA_PAGE_DAYS));
		expect(prevAgenda("2026-07-15", 7)).toBe("2026-07-08");
	});

	it("monthStart", () => {
		expect(monthStart("2026-07-15")).toBe("2026-07-01");
	});
});

describe("placeEvents", () => {
	it("fallback полей due → scheduled → start", () => {
		const byDue = makeTask({ due: "2026-07-20", scheduled: "2026-07-18" });
		const bySched = makeTask({ scheduled: "2026-07-18", start: "2026-07-16" });
		const byStart = makeTask({ start: "2026-07-16" });
		const map = placeEvents([byDue, bySched, byStart], PLACEMENT);
		expect(map.get("2026-07-20")).toEqual([{ task: byDue, field: "due" }]);
		expect(map.get("2026-07-18")).toEqual([{ task: bySched, field: "scheduled" }]);
		expect(map.get("2026-07-16")).toEqual([{ task: byStart, field: "start" }]);
	});

	it("задача без полей placement не попадает в карту", () => {
		const map = placeEvents([makeTask()], PLACEMENT);
		expect(map.size).toBe(0);
	});

	it("пустые дни в карте отсутствуют", () => {
		const map = placeEvents([makeTask({ due: "2026-07-20" })], PLACEMENT);
		expect(map.has("2026-07-19")).toBe(false);
		expect(map.has("2026-07-21")).toBe(false);
	});

	it("внутри дня: приоритет по убыванию, затем описание", () => {
		const low = makeTask({ due: "2026-07-20", priority: "low", description: "а-задача" });
		const highB = makeTask({ due: "2026-07-20", priority: "high", description: "б-задача" });
		const highA = makeTask({ due: "2026-07-20", priority: "high", description: "а-задача" });
		const none = makeTask({ due: "2026-07-20", description: "я-задача" });
		const map = placeEvents([none, low, highB, highA], PLACEMENT);
		expect(map.get("2026-07-20")!.map((e) => e.task)).toEqual([highA, highB, low, none]);
	});

	it("уважает кастомный порядок placement", () => {
		const t = makeTask({ due: "2026-07-20", scheduled: "2026-07-18" });
		const map = placeEvents([t], ["scheduled", "due"]);
		expect(map.get("2026-07-18")).toEqual([{ task: t, field: "scheduled" }]);
	});

	it("события со временем идут раньше и сортируются по времени asc", () => {
		// приоритет/алфавит нарочно против времени — время должно победить
		const morning = makeTask({ due: "2026-07-20", dueTime: "09:30", description: "я-задача" });
		const noon = makeTask({ due: "2026-07-20", dueTime: "14:00", description: "а-задача" });
		const untimed = makeTask({ due: "2026-07-20", priority: "highest", description: "б-задача" });
		const map = placeEvents([untimed, noon, morning], PLACEMENT);
		expect(map.get("2026-07-20")!.map((e) => e.task)).toEqual([morning, noon, untimed]);
	});

	it("сортировка берёт время поля-размещения, а не другого поля", () => {
		// размещена по scheduled (08:00); чужое startTime 23:00 не должно влиять
		const bySched = makeTask({
			scheduled: "2026-07-18",
			scheduledTime: "08:00",
			start: "2026-07-01",
			startTime: "23:00",
		});
		const later = makeTask({ scheduled: "2026-07-18", scheduledTime: "09:00" });
		const map = placeEvents([later, bySched], PLACEMENT);
		expect(map.get("2026-07-18")!.map((e) => e.task)).toEqual([bySched, later]);
	});

	it("равное время — приоритет по убыванию, затем описание", () => {
		const lowA = makeTask({
			due: "2026-07-20",
			dueTime: "10:00",
			priority: "low",
			description: "а-задача",
		});
		const highB = makeTask({
			due: "2026-07-20",
			dueTime: "10:00",
			priority: "high",
			description: "б-задача",
		});
		const highA = makeTask({
			due: "2026-07-20",
			dueTime: "10:00",
			priority: "high",
			description: "а-задача",
		});
		const map = placeEvents([lowA, highB, highA], PLACEMENT);
		expect(map.get("2026-07-20")!.map((e) => e.task)).toEqual([highA, highB, lowA]);
	});

	it("без времени сортировка прежняя: приоритет по убыванию, затем описание", () => {
		const low = makeTask({ due: "2026-07-20", priority: "low", description: "а-задача" });
		const high = makeTask({ due: "2026-07-20", priority: "high", description: "я-задача" });
		const map = placeEvents([low, high], PLACEMENT);
		expect(map.get("2026-07-20")!.map((e) => e.task)).toEqual([high, low]);
	});
});

describe("placedTime", () => {
	it("маппинг поля-размещения на его время", () => {
		const t = makeTask({ dueTime: "09:00", scheduledTime: "10:15", startTime: "11:30" });
		expect(placedTime(t, "due")).toBe("09:00");
		expect(placedTime(t, "scheduled")).toBe("10:15");
		expect(placedTime(t, "start")).toBe("11:30");
	});

	it("времени нет — null", () => {
		const t = makeTask({ due: "2026-07-20" });
		expect(placedTime(t, "due")).toBeNull();
		expect(placedTime(t, "scheduled")).toBeNull();
		expect(placedTime(t, "start")).toBeNull();
	});
});

describe("placedTimeEnd", () => {
	it("маппинг поля-размещения на его конец интервала", () => {
		const t = makeTask({
			dueTimeEnd: "10:00",
			scheduledTimeEnd: "11:15",
			startTimeEnd: "12:30",
		});
		expect(placedTimeEnd(t, "due")).toBe("10:00");
		expect(placedTimeEnd(t, "scheduled")).toBe("11:15");
		expect(placedTimeEnd(t, "start")).toBe("12:30");
	});

	it("конца нет — null (событие без длительности)", () => {
		const t = makeTask({ due: "2026-07-20", dueTime: "09:00" });
		expect(placedTimeEnd(t, "due")).toBeNull();
		expect(placedTimeEnd(t, "scheduled")).toBeNull();
		expect(placedTimeEnd(t, "start")).toBeNull();
	});
});

describe("deferredUntil", () => {
	const TODAY = "2026-07-15";

	it("start > today — дата пробуждения", () => {
		expect(deferredUntil(makeTask({ start: "2026-07-16" }), TODAY)).toBe("2026-07-16");
	});

	it("start == today / в прошлом / отсутствует — null (строгое сравнение §1)", () => {
		expect(deferredUntil(makeTask({ start: TODAY }), TODAY)).toBeNull();
		expect(deferredUntil(makeTask({ start: "2026-07-01" }), TODAY)).toBeNull();
		expect(deferredUntil(makeTask(), TODAY)).toBeNull();
	});

	it("done/cancelled с будущим start — не отложена (DONE/CANCELLED выше TICKLER)", () => {
		expect(deferredUntil(makeTask({ start: "2026-08-01", statusChar: "x" }), TODAY)).toBeNull();
		expect(deferredUntil(makeTask({ start: "2026-08-01", statusChar: "-" }), TODAY)).toBeNull();
	});

	it("шаблон/деталь карточки — не отложена (TEMPLATE/DETAIL выше TICKLER)", () => {
		expect(
			deferredUntil(makeTask({ start: "2026-08-01", container: "recurring" }), TODAY),
		).toBeNull();
		expect(deferredUntil(makeTask({ start: "2026-08-01", container: "card" }), TODAY)).toBeNull();
	});
});

describe("dropDateField", () => {
	it("двигает поле, по которому задача уже размещена", () => {
		expect(dropDateField(makeTask({ scheduled: "2026-07-18" }), PLACEMENT)).toBe("scheduled");
		expect(dropDateField(makeTask({ start: "2026-07-16" }), PLACEMENT)).toBe("start");
	});

	it("у задачи нет дат — первое поле placement", () => {
		expect(dropDateField(makeTask(), PLACEMENT)).toBe("due");
		expect(dropDateField(makeTask(), ["scheduled", "due"])).toBe("scheduled");
	});

	it("пустой placement — due", () => {
		expect(dropDateField(makeTask(), [])).toBe("due");
	});
});

describe("openTasks", () => {
	it("отсеивает done и cancelled", () => {
		const open = makeTask();
		const doing = makeTask({ statusChar: "/" });
		const done = makeTask({ statusChar: "x" });
		const doneUpper = makeTask({ statusChar: "X" });
		const cancelled = makeTask({ statusChar: "-" });
		expect(openTasks([open, doing, done, doneUpper, cancelled])).toEqual([open, doing]);
	});
});

describe("quickAddLine / appendLine", () => {
	it("формирует строку захвата с 📅", () => {
		expect(quickAddLine("Позвонить в банк", "2026-07-20")).toBe(
			"- [ ] Позвонить в банк 📅 2026-07-20",
		);
	});

	it("обрезает пробелы; пустой текст — null", () => {
		expect(quickAddLine("  дело  ", "2026-07-20")).toBe("- [ ] дело 📅 2026-07-20");
		expect(quickAddLine("   ", "2026-07-20")).toBeNull();
		expect(quickAddLine("", "2026-07-20")).toBeNull();
	});

	it("время слота time-grid — хвост «📅 <дата> HH:mm»", () => {
		expect(quickAddLine("Встреча", "2026-07-20", "14:30")).toBe(
			"- [ ] Встреча 📅 2026-07-20 14:30",
		);
		expect(quickAddLine("Без времени", "2026-07-20", null)).toBe(
			"- [ ] Без времени 📅 2026-07-20",
		);
		expect(quickAddLine("   ", "2026-07-20", "14:30")).toBeNull();
	});

	it("append в пустой/непустой файл — ровно один перевод строки в конце", () => {
		expect(appendLine("", "- [ ] х")).toBe("- [ ] х\n");
		expect(appendLine("\n", "- [ ] х")).toBe("- [ ] х\n");
		expect(appendLine("- [ ] а", "- [ ] б")).toBe("- [ ] а\n- [ ] б\n");
		expect(appendLine("- [ ] а\n", "- [ ] б")).toBe("- [ ] а\n- [ ] б\n");
	});
});

describe("презентация", () => {
	it("monthTitle", () => {
		expect(monthTitle("2026-07-15")).toBe("Июль 2026");
		expect(monthTitle("2026-01-01")).toBe("Январь 2026");
	});

	it("weekdayNames с понедельника и с воскресенья", () => {
		expect(weekdayNames(1)).toEqual(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
		expect(weekdayNames(0)).toEqual(["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]);
	});

	it("agendaLabel — день недели и дата", () => {
		expect(agendaLabel("2026-07-15")).toBe("Ср 2026-07-15");
		expect(agendaLabel("2026-07-19")).toBe("Вс 2026-07-19");
	});
});

describe("sanitizeCalendarState", () => {
	it("принимает валидные mode и anchor", () => {
		expect(sanitizeCalendarState({ mode: "week", anchor: "2026-07-15" })).toEqual({
			mode: "week",
			anchor: "2026-07-15",
		});
	});

	it("принимает новые time-grid режимы «3 дня»/«День»", () => {
		expect(sanitizeCalendarState({ mode: "3days" })).toEqual({ mode: "3days" });
		expect(sanitizeCalendarState({ mode: "day", anchor: "2026-07-15" })).toEqual({
			mode: "day",
			anchor: "2026-07-15",
		});
	});

	it("отбрасывает мусорные поля по отдельности", () => {
		expect(sanitizeCalendarState({ mode: "bogus", anchor: "2026-07-15" })).toEqual({
			anchor: "2026-07-15",
		});
		expect(sanitizeCalendarState({ mode: "agenda", anchor: "не дата" })).toEqual({
			mode: "agenda",
		});
	});

	it("не-объект — null", () => {
		expect(sanitizeCalendarState(null)).toBeNull();
		expect(sanitizeCalendarState("month")).toBeNull();
		expect(sanitizeCalendarState([1])).toBeNull();
	});
});
