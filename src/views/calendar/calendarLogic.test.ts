import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import type { CalendarField } from "../../core/model/projections";
import { ALL_NS, DEFAULT_NS, type NamespaceDef } from "../../core/namespace/namespace";
import {
	AGENDA_PAGE_DAYS,
	agendaDays,
	agendaLabel,
	agendaTimeLabel,
	appendLine,
	deferredUntil,
	dropDateField,
	eventTargetForNamespace,
	expandEventOccurrences,
	formatTimeRange,
	mergeDayItems,
	monthGrid,
	monthStart,
	monthTitle,
	nextAgenda,
	nextMonth,
	nextWeek,
	openTasks,
	parseTimeRange,
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
		excludedDates: [],
		location: null,
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

	it("click-drag — хвост «📅 <дата> HH:mm-HH:mm»", () => {
		expect(quickAddLine("Созвон", "2026-07-20", "14:30", "16:00")).toBe(
			"- [ ] Созвон 📅 2026-07-20 14:30-16:00",
		);
		// конец без начала невозможен: timeEnd игнорируется, если time === null
		expect(quickAddLine("Ничего", "2026-07-20", null, "16:00")).toBe(
			"- [ ] Ничего 📅 2026-07-20",
		);
	});

	it("append в пустой/непустой файл — ровно один перевод строки в конце", () => {
		expect(appendLine("", "- [ ] х")).toBe("- [ ] х\n");
		expect(appendLine("\n", "- [ ] х")).toBe("- [ ] х\n");
		expect(appendLine("- [ ] а", "- [ ] б")).toBe("- [ ] а\n- [ ] б\n");
		expect(appendLine("- [ ] а\n", "- [ ] б")).toBe("- [ ] а\n- [ ] б\n");
	});
});

describe("quickAddLine — место 📍 (поле «Место» quick-add, Задание 2)", () => {
	it("непустое место дописывается полем 📍 в конец строки", () => {
		expect(quickAddLine("Купить молоко", "2026-07-20", null, null, "магазин у дома")).toBe(
			"- [ ] Купить молоко 📅 2026-07-20 📍 магазин у дома",
		);
	});

	it("место сочетается со временем слота (📍 после времени)", () => {
		expect(quickAddLine("Встреча", "2026-07-20", "14:30", "16:00", "офис")).toBe(
			"- [ ] Встреча 📅 2026-07-20 14:30-16:00 📍 офис",
		);
	});

	it("пустое/пробельное/null место — строка без 📍", () => {
		expect(quickAddLine("дело", "2026-07-20", null, null, "")).toBe("- [ ] дело 📅 2026-07-20");
		expect(quickAddLine("дело", "2026-07-20", null, null, "   ")).toBe("- [ ] дело 📅 2026-07-20");
		expect(quickAddLine("дело", "2026-07-20", null, null, null)).toBe("- [ ] дело 📅 2026-07-20");
	});

	it("недопустимое место (эмодзи поля) не роняет захват — строка без 📍", () => {
		// 📍 в значении места — эмодзи поля; setValueField бросил бы, но захват задачи
		// важнее: возвращаем строку без места, а не null
		expect(quickAddLine("дело", "2026-07-20", null, null, "у 📅 стены")).toBe(
			"- [ ] дело 📅 2026-07-20",
		);
	});

	it("пустой текст — null даже при заданном месте", () => {
		expect(quickAddLine("  ", "2026-07-20", null, null, "офис")).toBeNull();
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

describe("expandEventOccurrences (§события)", () => {
	function event(overrides: Partial<Task> = {}): Task {
		return makeTask({ container: "events", ...overrides });
	}

	it("разворачивает серию по видимому диапазону с временем из правила", () => {
		const ev = event({
			description: "Тренировка",
			recurrence: "every tuesday at 19:00-20:30",
		});
		const map = expandEventOccurrences([ev], "2026-07-13", "2026-07-19");
		// 2026-07-14 — вторник
		expect([...map.keys()]).toEqual(["2026-07-14"]);
		const [occ] = map.get("2026-07-14")!;
		expect(occ?.title).toBe("Тренировка");
		expect(occ?.time).toBe("19:00");
		expect(occ?.timeEnd).toBe("20:30");
		expect(occ?.task).toBe(ev);
	});

	it("событие без времени — time/timeEnd null («Весь день»)", () => {
		const ev = event({ recurrence: "every day" });
		const map = expandEventOccurrences([ev], "2026-07-15", "2026-07-16");
		expect(map.get("2026-07-15")?.[0]?.time).toBeNull();
		expect(map.get("2026-07-16")?.[0]?.timeEnd).toBeNull();
	});

	it("битое/пустое правило серии пропускается молча", () => {
		const broken = event({ recurrence: "каждый вторник" });
		const empty = event({ recurrence: null });
		expect(expandEventOccurrences([broken, empty], "2026-07-13", "2026-07-20").size).toBe(0);
	});

	it("несколько серий в один день — сортировка со временем asc, затем без времени", () => {
		const a = event({ description: "Б-встреча", recurrence: "every day at 09:00" });
		const b = event({ description: "А-звонок", recurrence: "every day at 08:00" });
		const c = event({ description: "весь день", recurrence: "every day" });
		const list = expandEventOccurrences([a, b, c], "2026-07-15", "2026-07-15").get("2026-07-15")!;
		expect(list.map((o) => o.title)).toEqual(["А-звонок", "Б-встреча", "весь день"]);
	});

	it("вхождения серии помечены kind='series'", () => {
		const ev = event({ recurrence: "every day" });
		const occ = expandEventOccurrences([ev], "2026-07-15", "2026-07-15").get("2026-07-15")![0]!;
		expect(occ.kind).toBe("series");
	});

	it("даты из 🚫 (excludedDates) пропускаются", () => {
		const ev = event({
			description: "Тренировка",
			recurrence: "every day",
			excludedDates: ["2026-07-16"],
		});
		const map = expandEventOccurrences([ev], "2026-07-15", "2026-07-17");
		expect([...map.keys()].sort()).toEqual(["2026-07-15", "2026-07-17"]);
	});

	it("одноразовое событие (без 🔁, с 📅) — на своей дате, kind='single'", () => {
		const single = event({
			description: "Перенесённая тренировка",
			due: "2026-07-21",
			dueTime: "18:00",
			dueTimeEnd: "19:30",
			spawnedFrom: "ev1",
		});
		const map = expandEventOccurrences([single], "2026-07-15", "2026-07-31");
		const occ = map.get("2026-07-21")![0]!;
		expect(occ.kind).toBe("single");
		expect(occ.title).toBe("Перенесённая тренировка");
		expect(occ.time).toBe("18:00");
		expect(occ.timeEnd).toBe("19:30");
		expect(occ.task).toBe(single);
	});

	it("одноразовое событие вне диапазона не собирается", () => {
		const single = event({ due: "2026-08-10" });
		expect(expandEventOccurrences([single], "2026-07-15", "2026-07-31").size).toBe(0);
	});

	it("одноразовое без 📅 (и без 🔁) игнорируется", () => {
		const noop = event({ recurrence: null, due: null });
		expect(expandEventOccurrences([noop], "2026-07-15", "2026-07-31").size).toBe(0);
	});

	it("📍 место прокидывается в вхождение серии и одноразового", () => {
		const series = event({ recurrence: "every day", location: "Спортзал" });
		const so = expandEventOccurrences([series], "2026-07-15", "2026-07-15").get("2026-07-15")![0]!;
		expect(so.location).toBe("Спортзал");

		const single = event({ due: "2026-07-21", location: "Офис, 3 этаж" });
		const oo = expandEventOccurrences([single], "2026-07-15", "2026-07-31").get("2026-07-21")![0]!;
		expect(oo.location).toBe("Офис, 3 этаж");

		const noLoc = event({ recurrence: "every day" });
		const no = expandEventOccurrences([noLoc], "2026-07-15", "2026-07-15").get("2026-07-15")![0]!;
		expect(no.location).toBeNull();
	});
});

describe("mergeDayItems — единый порядок задач и событий дня по времени (без группировки по типу)", () => {
	function event(overrides: Partial<Task> = {}): Task {
		return makeTask({ container: "events", ...overrides });
	}
	const DATE = "2026-07-20";
	/** Метка элемента: тип + название/описание — для проверки точного порядка. */
	const label = (it: ReturnType<typeof mergeDayItems>[number]): string =>
		it.kind === "task" ? `task:${it.ev.task.description}` : `event:${it.occ.title}`;

	it("смешанный день: без времени первыми (событие раньше задачи), затем по времени asc независимо от типа", () => {
		// репорт пользователя: «○ 13:45 задача» стояла ВЫШЕ «◇ 09:00 события» —
		// теперь задача идёт на своём времени, а не в общей группе задач
		const taskLate = makeTask({ due: DATE, dueTime: "13:45", description: "Физиотерапевт" });
		const taskUntimed = makeTask({ due: DATE, description: "Позвонить" });
		const tasks = placeEvents([taskLate, taskUntimed], PLACEMENT).get(DATE)!;

		const ev9 = event({ description: "завтрак", recurrence: "every day at 09:00" });
		const ev10 = event({ description: "созвон", recurrence: "every day at 10:00" });
		const evAllDay = event({ description: "день рождения", recurrence: "every day" });
		const occ = expandEventOccurrences([ev9, ev10, evAllDay], DATE, DATE).get(DATE)!;

		expect(mergeDayItems(tasks, occ).map(label)).toEqual([
			"event:день рождения", // без времени / весь день — первым, событие раньше задачи
			"task:Позвонить", // без времени — после события
			"event:завтрак", // 09:00
			"event:созвон", // 10:00
			"task:Физиотерапевт", // 13:45 — по времени, а не в конце (был баг)
		]);
	});

	it("равное время — событие перед задачей", () => {
		const task = makeTask({ due: DATE, dueTime: "10:00", description: "задача-10" });
		const tasks = placeEvents([task], PLACEMENT).get(DATE)!;
		const ev = event({ description: "событие-10", recurrence: "every day at 10:00" });
		const occ = expandEventOccurrences([ev], DATE, DATE).get(DATE)!;
		expect(mergeDayItems(tasks, occ).map((it) => it.kind)).toEqual(["event", "task"]);
	});

	it("пустые входы — пусто; одиночные списки сохраняют свой внутренний порядок", () => {
		expect(mergeDayItems([], [])).toEqual([]);
		const t1 = makeTask({ due: DATE, dueTime: "08:00" });
		const t2 = makeTask({ due: DATE, dueTime: "09:00" });
		const onlyTasks = mergeDayItems(placeEvents([t2, t1], PLACEMENT).get(DATE)!, []);
		expect(
			onlyTasks.map((it) => (it.kind === "task" ? placedTime(it.ev.task, it.ev.field) : null)),
		).toEqual(["08:00", "09:00"]);
	});
});

describe("agendaTimeLabel — бейдж времени агенды/чипа", () => {
	it("конец задан и строго позже начала — диапазон HH:mm–HH:mm", () => {
		expect(agendaTimeLabel("09:00", "10:30")).toBe("09:00–10:30");
		expect(agendaTimeLabel("23:15", "23:59")).toBe("23:15–23:59");
	});

	it("конца нет — только начало", () => {
		expect(agendaTimeLabel("14:30", null)).toBe("14:30");
	});

	it("вырожденный конец (≤ начала) выпадает — остаётся начало", () => {
		expect(agendaTimeLabel("10:00", "10:00")).toBe("10:00");
		expect(agendaTimeLabel("10:00", "08:00")).toBe("10:00");
	});

	it("времени нет — null (без бейджа)", () => {
		expect(agendaTimeLabel(null, null)).toBeNull();
		// конец без начала бессмыслен — тоже null
		expect(agendaTimeLabel(null, "10:00")).toBeNull();
	});
});

describe("parseTimeRange — поле времени модала одноразового → начало/конец", () => {
	it("пусто — событие без времени (обе null)", () => {
		expect(parseTimeRange("")).toEqual({ time: null, timeEnd: null });
		expect(parseTimeRange("   ")).toEqual({ time: null, timeEnd: null });
	});

	it("только начало «HH:mm»", () => {
		expect(parseTimeRange("09:00")).toEqual({ time: "09:00", timeEnd: null });
		expect(parseTimeRange(" 23:59 ")).toEqual({ time: "23:59", timeEnd: null });
	});

	it("диапазон «HH:mm-HH:mm»", () => {
		expect(parseTimeRange("19:00-20:30")).toEqual({ time: "19:00", timeEnd: "20:30" });
		expect(parseTimeRange("08:15 - 09:45")).toEqual({ time: "08:15", timeEnd: "09:45" });
	});

	it("битое время / лишние части — null (submit заблокирован)", () => {
		expect(parseTimeRange("25:00")).toBeNull();
		expect(parseTimeRange("9:00")).toBeNull(); // не HH:mm
		expect(parseTimeRange("abc")).toBeNull();
		expect(parseTimeRange("10:00-11:00-12:00")).toBeNull();
		expect(parseTimeRange("10:00-xx")).toBeNull();
	});

	it("вырожденный конец (≤ начала) НЕ отбраковывается — снимет строка события", () => {
		// формат валиден; buildSingleOccurrenceLine сам уронит конец ≤ начала
		expect(parseTimeRange("10:00-10:00")).toEqual({ time: "10:00", timeEnd: "10:00" });
		expect(parseTimeRange("12:00-08:00")).toEqual({ time: "12:00", timeEnd: "08:00" });
	});
});

describe("formatTimeRange — преднаполнение поля времени модала (обратно parseTimeRange)", () => {
	it("диапазон и одиночное время; дефис ASCII для round-trip", () => {
		expect(formatTimeRange("19:00", "20:30")).toBe("19:00-20:30");
		expect(formatTimeRange("14:30", null)).toBe("14:30");
	});

	it("без начала — пустая строка; вырожденный конец выпадает", () => {
		expect(formatTimeRange(null, null)).toBe("");
		expect(formatTimeRange(null, "10:00")).toBe("");
		expect(formatTimeRange("10:00", "10:00")).toBe("10:00");
		expect(formatTimeRange("10:00", "08:00")).toBe("10:00");
	});

	it("round-trip format→parse сохраняет пару", () => {
		expect(parseTimeRange(formatTimeRange("19:00", "20:30"))).toEqual({
			time: "19:00",
			timeEnd: "20:30",
		});
		expect(parseTimeRange(formatTimeRange("09:15", null))).toEqual({
			time: "09:15",
			timeEnd: null,
		});
	});
});

describe("eventTargetForNamespace — файл событий инлайн-создания по пространству", () => {
	const WORK: NamespaceDef = { name: "Работа", root: "Work" };
	const LIFE: NamespaceDef = { name: "Жизнь", root: "Личное" };
	const DEFS = [WORK, LIFE];
	const EVENTS_FALLBACK = "GTD/Events.md";
	const COMMON = "GTD";

	it("именованное пространство — <root>/События.md", () => {
		expect(eventTargetForNamespace("Работа", DEFS, EVENTS_FALLBACK, COMMON)).toBe(
			"Work/События.md",
		);
		expect(eventTargetForNamespace("Жизнь", DEFS, EVENTS_FALLBACK, COMMON)).toBe(
			"Личное/События.md",
		);
	});

	it("«Общее» (DEFAULT_NS) — выделенный фолбэк settings.eventsFile", () => {
		expect(eventTargetForNamespace(DEFAULT_NS, DEFS, EVENTS_FALLBACK, COMMON)).toBe(
			"GTD/Events.md",
		);
	});

	it("вкладка «Все» (ALL_NS) — файл событий ОБЩЕЙ папки <commonRoot>/События.md", () => {
		expect(eventTargetForNamespace(ALL_NS, DEFS, EVENTS_FALLBACK, COMMON)).toBe(
			"GTD/События.md",
		);
	});

	it("ALL_NS с пустым commonRoot — голое имя файла (в корне хранилища)", () => {
		expect(eventTargetForNamespace(ALL_NS, DEFS, EVENTS_FALLBACK, "")).toBe("События.md");
	});

	it("пространств не настроено — любое имя падает на фолбэк, ALL_NS — на commonRoot", () => {
		expect(eventTargetForNamespace(DEFAULT_NS, [], EVENTS_FALLBACK, COMMON)).toBe("GTD/Events.md");
		expect(eventTargetForNamespace(ALL_NS, [], EVENTS_FALLBACK, COMMON)).toBe("GTD/События.md");
	});
});
