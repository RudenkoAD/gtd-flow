import { describe, expect, it } from "vitest";
import { mirrorWindow, parseIcs, type MirrorOccurrence, type MirrorWindow } from "./icsParse";

// ---------------------------------------------------------------------------
// Хелперы фикстур
// ---------------------------------------------------------------------------

/** Обернуть тело в VCALENDAR-каркас. */
function vcal(body: string): string {
	return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${body}\r\nEND:VCALENDAR`;
}

/** Окно, накрывающее июль 2026 (стабильно, не зависит от «сегодня»). */
const WINDOW: MirrorWindow = { start: new Date(2026, 5, 1), end: new Date(2026, 8, 1) };

/** Отсортировать по (дата, время, uid) — для стабильных ассертов. */
function sorted(occ: MirrorOccurrence[]): MirrorOccurrence[] {
	return [...occ].sort((a, b) =>
		a.date !== b.date
			? a.date < b.date
				? -1
				: 1
			: (a.startTime ?? "") !== (b.startTime ?? "")
				? (a.startTime ?? "") < (b.startTime ?? "")
					? -1
					: 1
				: a.uid < b.uid
					? -1
					: 1,
	);
}

// ---------------------------------------------------------------------------

describe("parseIcs — одиночные события", () => {
	it("одиночное событие со временем: дата, HH:mm-HH:mm, место", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Совещание\r\nLOCATION:Комната 5\r\nDTSTART:20260706T140000\r\nDTEND:20260706T153000\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW);
		expect(occ).toHaveLength(1);
		expect(occ[0]).toMatchObject({
			uid: "e1",
			date: "2026-07-06",
			allDay: false,
			startTime: "14:00",
			endTime: "15:30",
			title: "Совещание",
			location: "Комната 5",
			dayIndex: 0,
			dayCount: 1,
		});
	});

	it("all-day одиночное (DATE без времени): без времени, DTEND исключительный", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:d1\r\nSUMMARY:Дедлайн\r\nDTSTART;VALUE=DATE:20260709\r\nDTEND;VALUE=DATE:20260710\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW);
		expect(occ).toHaveLength(1);
		expect(occ[0]).toMatchObject({ date: "2026-07-09", allDay: true, startTime: null, endTime: null });
	});

	it("событие вне окна не попадает в вывод", () => {
		const ics = vcal(`BEGIN:VEVENT\r\nUID:far\r\nSUMMARY:Далеко\r\nDTSTART:20270101T100000\r\nEND:VEVENT`);
		expect(parseIcs(ics, WINDOW)).toHaveLength(0);
	});
});

describe("parseIcs — многодневные", () => {
	it("многодневное all-day: одна строка на каждый покрытый день с суффиксом дня", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:vac\r\nSUMMARY:Отпуск\r\nDTSTART;VALUE=DATE:20260710\r\nDTEND;VALUE=DATE:20260713\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		// DTEND исключительный → покрыты 10, 11, 12 (3 дня)
		expect(occ.map((o) => o.date)).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);
		for (const o of occ) {
			expect(o.allDay).toBe(true);
			expect(o.dayCount).toBe(3);
		}
		expect(occ.map((o) => o.dayIndex)).toEqual([0, 1, 2]);
		// recurrenceKey общий (одно вхождение), различает строки только dayIndex
		expect(new Set(occ.map((o) => o.recurrenceKey)).size).toBe(1);
	});
});

describe("parseIcs — повторяющиеся серии", () => {
	it("RRULE weekly с EXDATE: исключённая дата пропущена", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Стендап\r\nDTSTART:20260706T100000\r\nDTEND:20260706T103000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE:20260713T100000\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		// COUNT=4: 06,13,20,27; EXDATE убирает 13 → остаются 06,20,27
		expect(occ.map((o) => o.date)).toEqual(["2026-07-06", "2026-07-20", "2026-07-27"]);
		for (const o of occ) expect(o).toMatchObject({ startTime: "10:00", endTime: "10:30", title: "Стендап" });
	});

	it("RECURRENCE-ID: переопределённое вхождение берёт новое время/название, а 🆔-база (recurrenceKey) остаётся исходной", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Стендап\r\nDTSTART:20260706T100000\r\nDTEND:20260706T103000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20260713T100000\r\nSUMMARY:Стендап (перенесён)\r\nDTSTART:20260713T140000\r\nDTEND:20260713T150000\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		expect(occ.map((o) => o.date)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
		const moved = occ.find((o) => o.date === "2026-07-13")!;
		expect(moved.startTime).toBe("14:00");
		expect(moved.title).toBe("Стендап (перенесён)");
		// recurrenceKey — ИСХОДНАЯ дата вхождения (10:00), не новое время: 🆔 не «прыгает»
		expect(moved.recurrenceKey).toBe("2026-07-13T10:00:00");
	});
});

describe("parseIcs — таймзоны", () => {
	it("зонированное (UTC) время конвертируется в ЛОКАЛЬНОЕ время устройства", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:utc1\r\nSUMMARY:Звонок\r\nDTSTART:20260706T090000Z\r\nDTEND:20260706T100000Z\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW);
		expect(occ).toHaveLength(1);
		// ожидаемое локальное представление того же инстанта — теми же средствами Date
		// (тест устойчив к таймзоне раннера)
		const start = new Date(Date.UTC(2026, 6, 6, 9, 0));
		const end = new Date(Date.UTC(2026, 6, 6, 10, 0));
		const p = (n: number): string => String(n).padStart(2, "0");
		const expDate = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
		expect(occ[0]!.date).toBe(expDate);
		expect(occ[0]!.startTime).toBe(`${p(start.getHours())}:${p(start.getMinutes())}`);
		expect(occ[0]!.endTime).toBe(`${p(end.getHours())}:${p(end.getMinutes())}`);
	});

	it("VTIMEZONE-зона (Europe/Moscow +3, ≠ UTC) сводится к тому же инстанту, что UTC-эквивалент", () => {
		// 12:00 MSK (+3) == 09:00 UTC — оба вхождения должны лечь на одно локальное время
		const ics = vcal(
			`BEGIN:VTIMEZONE\r\nTZID:Europe/Moscow\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300\r\nTZNAME:MSK\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n` +
				`BEGIN:VEVENT\r\nUID:zoned\r\nSUMMARY:MSK\r\nDTSTART;TZID=Europe/Moscow:20260706T120000\r\nDTEND;TZID=Europe/Moscow:20260706T130000\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:utc\r\nSUMMARY:UTC\r\nDTSTART:20260706T090000Z\r\nDTEND:20260706T100000Z\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW);
		const zoned = occ.find((o) => o.uid === "zoned")!;
		const utc = occ.find((o) => o.uid === "utc")!;
		expect(zoned.date).toBe(utc.date);
		expect(zoned.startTime).toBe(utc.startTime); // конвертация зоны в локаль корректна
	});
});

describe("parseIcs — устойчивость", () => {
	it("битый ICS бросает (вызыватель ловит и пишет в статус)", () => {
		expect(() => parseIcs("это не ICS", WINDOW)).toThrow();
	});

	it("пустой календарь без событий — пустой вывод", () => {
		expect(parseIcs(vcal("PRODID:-//x//EN"), WINDOW)).toHaveLength(0);
	});
});

describe("parseIcs — BOM (FIX-2)", () => {
	it("ведущий BOM (U+FEFF) не мешает разбору", () => {
		const body = `BEGIN:VEVENT\r\nUID:bom1\r\nSUMMARY:Событие\r\nDTSTART:20260706T100000\r\nDTEND:20260706T110000\r\nEND:VEVENT`;
		const withBom = `\uFEFF${vcal(body)}`;
		const occ = parseIcs(withBom, WINDOW);
		expect(occ).toHaveLength(1);
		expect(occ[0]).toMatchObject({ uid: "bom1", date: "2026-07-06", startTime: "10:00" });
	});
});

describe("parseIcs — окно у серий из далёкого прошлого (FIX-3)", () => {
	it("HOURLY двухлетней давности населяет окно (кап на ЭМИТ, не на шаги)", () => {
		// DTSTART за 2 года до окна: прежний кап на ШАГИ (15000) упирался ДО окна → 0 строк
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:h1\r\nSUMMARY:Ежечасно\r\nDTSTART:20240601T000000\r\nDTEND:20240601T003000\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		expect(occ.length).toBeGreaterThan(2000); // ~92 дня × 24 ч
		expect(occ[0]!.date).toBe("2026-06-01"); // начало окна не потеряно
		expect(occ.some((o) => o.date === "2026-08-31")).toBe(true); // и конец окна населён
	});

	it("DAILY трёхлетней давности даёт ровно 92 вхождения (окно не теряется, не задваивается)", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:d1\r\nSUMMARY:Ежедневно\r\nDTSTART:20230601T090000\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT`,
		);
		expect(parseIcs(ics, WINDOW)).toHaveLength(92);
	});

	it("EXDATE внутри окна учтён и у старой серии (перемотка не ломает исключения)", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:d2\r\nSUMMARY:Ежедневно\r\nDTSTART:20230601T090000\r\nRRULE:FREQ=DAILY\r\nEXDATE:20260715T090000\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW);
		expect(occ).toHaveLength(91); // 92 − исключённый день
		expect(occ.some((o) => o.date === "2026-07-15")).toBe(false);
	});
});

describe("parseIcs — ночные (переходящие полночь) вхождения (FIX-7)", () => {
	it("таймированное 23:00–01:00 → две строки СО ВРЕМЕНЕМ (первый день HH:mm–23:59, второй 00:00–HH:mm)", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:night\r\nSUMMARY:Ночная смена\r\nDTSTART:20260706T230000\r\nDTEND:20260707T010000\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		expect(occ).toHaveLength(2);
		expect(occ[0]).toMatchObject({ date: "2026-07-06", allDay: false, startTime: "23:00", endTime: "23:59" });
		expect(occ[1]).toMatchObject({ date: "2026-07-07", allDay: false, startTime: "00:00", endTime: "01:00" });
	});

	it("многодневное таймированное: крайние сутки со временем, промежуточные — all-day", () => {
		// 2026-07-06 20:00 → 2026-07-08 10:00 (покрывает 06,07,08)
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:span\r\nSUMMARY:Смена\r\nDTSTART:20260706T200000\r\nDTEND:20260708T100000\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		expect(occ.map((o) => o.date)).toEqual(["2026-07-06", "2026-07-07", "2026-07-08"]);
		expect(occ[0]).toMatchObject({ allDay: false, startTime: "20:00", endTime: "23:59" });
		expect(occ[1]).toMatchObject({ allDay: true, startTime: null, endTime: null }); // середина
		expect(occ[2]).toMatchObject({ allDay: false, startTime: "00:00", endTime: "10:00" });
	});
});

describe("parseIcs — дубль-мастер (FIX-10)", () => {
	it("второй VEVENT с тем же UID и без RECURRENCE-ID дропается (не задваивание серии)", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:same\r\nSUMMARY:Первый\r\nDTSTART:20260706T100000\r\nDTEND:20260706T110000\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:same\r\nSUMMARY:Второй\r\nDTSTART:20260708T100000\r\nDTEND:20260708T110000\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW);
		expect(occ).toHaveLength(1);
		expect(occ[0]!.title).toBe("Первый");
		expect(occ.some((o) => o.title === "Второй")).toBe(false);
	});
});

describe("mirrorWindow", () => {
	it("окно [−14; +92] дней от «сейчас»", () => {
		const w = mirrorWindow(new Date(2026, 6, 15));
		expect(w.start).toEqual(new Date(2026, 6, 1));
		expect(w.end).toEqual(new Date(2026, 9, 15));
	});
});
