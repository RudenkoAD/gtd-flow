import { describe, expect, it } from "vitest";
import {
	IcsBudgetError,
	mirrorWindow,
	parseIcs,
	type MirrorOccurrence,
	type MirrorWindow,
} from "./icsParse";

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
		expect(occ[0]).toMatchObject({
			date: "2026-07-09",
			allDay: true,
			startTime: null,
			endTime: null,
		});
	});

	it("событие вне окна не попадает в вывод", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:far\r\nSUMMARY:Далеко\r\nDTSTART:20270101T100000\r\nEND:VEVENT`,
		);
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
		for (const o of occ)
			expect(o).toMatchObject({ startTime: "10:00", endTime: "10:30", title: "Стендап" });
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

describe("parseIcs — безопасное ускорение UTC-серий", () => {
	const newYorkVtimezone =
		`BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\n` +
		`BEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nTZNAME:EDT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:DAYLIGHT\r\n` +
		`BEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nTZNAME:EST\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE`;

	it("floating recurring times retain ical.js's wall-clock iterator instead of epoch seeding", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:floating\r\nDTSTART:20260101T090000\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT`,
		);
		// Шаги тратятся от самого DTSTART (сидирование к окну для floating запрещено),
		// поэтому тесный бюджет серия не переживает — и, по своему бюджету, просто
		// выпадает из ленты (см. «бюджет одной серии не роняет ленту» ниже).
		expect(parseIcs(ics, WINDOW, { budget: { maxIteratorStepsPerSeries: 10 } })).toEqual([]);
	});

	it("TZID recurrence crossing DST retains the canonical iterator path", () => {
		const dstWindow: MirrorWindow = { start: new Date(2026, 2, 8), end: new Date(2026, 2, 9) };
		const ics = vcal(
			`${newYorkVtimezone}\r\nBEGIN:VEVENT\r\nUID:dst-hourly\r\nDTSTART;TZID=America/New_York:20260307T003000\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT`,
		);
		// A non-UTC seed derived from epoch milliseconds can land on the wrong
		// side of the DST transition.  The safe path therefore spends iterator
		// steps from DTSTART and visibly trips this deliberately tight budget
		// (which now drops the series instead of the whole feed).
		expect(parseIcs(ics, dstWindow, { budget: { maxIteratorStepsPerSeries: 10 } })).toEqual([]);
		expect(parseIcs(ics, dstWindow).length).toBeGreaterThan(0);
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
		// Coverage instrumentation can push this deliberately large correctness
		// fixture past the production wall-clock budget. Budget enforcement has
		// dedicated deterministic tests below, so keep this assertion focused on
		// recurrence fast-forwarding rather than host load.
		const occ = sorted(parseIcs(ics, WINDOW, { budget: { maxElapsedMs: 10_000 } }));
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

	it("fast-forward keeps EXDATE and RECURRENCE-ID semantics while staying under a tight iterator budget", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:old-ex\r\nSUMMARY:Master\r\nDTSTART:20200101T090000Z\r\nRRULE:FREQ=HOURLY\r\nEXDATE:20260715T090000Z\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:old-ex\r\nRECURRENCE-ID:20260716T090000Z\r\nSUMMARY:Moved\r\nDTSTART:20260717T120000Z\r\nEND:VEVENT`,
		);
		// The mirror window itself has ~2,200 hourly rows; 3,000 permits that
		// useful work but would reject the ~56,000-step pre-window walk.
		const occ = parseIcs(ics, WINDOW, { budget: { maxIteratorStepsPerSeries: 3_000 } });
		const excluded = new Date(Date.UTC(2026, 6, 15, 9, 0));
		const p = (n: number): string => String(n).padStart(2, "0");
		const excludedDate = `${excluded.getFullYear()}-${p(excluded.getMonth() + 1)}-${p(excluded.getDate())}`;
		const excludedTime = `${p(excluded.getHours())}:${p(excluded.getMinutes())}`;
		expect(occ.some((o) => o.date === excludedDate && o.startTime === excludedTime)).toBe(
			false,
		);
		const moved = occ.find((o) => o.title === "Moved")!;
		expect(moved).toMatchObject({ date: "2026-07-17", recurrenceKey: "2026-07-16T09:00:00Z" });
	});

	it("secondly series from years ago fast-forwards before exhausting iterator steps, then stops at output budget", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:seconds\r\nSUMMARY:Ticker\r\nDTSTART:20200101T000000Z\r\nRRULE:FREQ=SECONDLY\r\nEND:VEVENT`,
		);
		// потолок строк ОДНОЙ серии — не фатален: серия выпадает целиком (без хвоста
		// уже добавленных строк), лента остаётся разобранной
		expect(
			parseIcs(ics, WINDOW, {
				budget: { maxIteratorStepsPerSeries: 150, maxSeriesRows: 100, maxTotalRows: 1_000 },
			}),
		).toEqual([]);
		// общефидовый потолок по-прежнему фатален — частичное зеркало хуже честной ошибки
		expect(() =>
			parseIcs(ics, WINDOW, {
				budget: {
					maxIteratorStepsPerSeries: 150,
					maxSeriesRows: 10_000,
					maxTotalRows: 100,
				},
			}),
		).toThrow(IcsBudgetError);
		expect(() =>
			parseIcs(ics, WINDOW, {
				budget: {
					maxIteratorStepsPerSeries: 150,
					maxSeriesRows: 10_000,
					maxTotalRows: 100,
				},
			}),
		).toThrow(/feed exceeds.*row output budget/);
	});
});

describe("parseIcs — adversarial resource budgets", () => {
	it("rejects oversized response and excessive VEVENT count before expansion", () => {
		expect(() =>
			parseIcs(vcal("x".repeat(200)), WINDOW, { budget: { maxResponseBytes: 10 } }),
		).toThrow(/size budget/);
		const twoEvents = vcal(
			`BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260701T090000\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20260702T090000\r\nEND:VEVENT`,
		);
		expect(() => parseIcs(twoEvents, WINDOW, { budget: { maxVevents: 1 } })).toThrow(
			/VEVENT budget/,
		);
	});

	it("enforces elapsed-time and global-output budgets without returning a truncated mirror", () => {
		let now = 0;
		expect(() =>
			parseIcs(
				vcal("BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260701T090000\r\nEND:VEVENT"),
				WINDOW,
				{
					budget: { maxElapsedMs: 1 },
					nowMs: () => now++,
				},
			),
		).toThrow(/time budget/);

		const twoEvents = vcal(
			`BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260701T090000\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20260702T090000\r\nEND:VEVENT`,
		);
		expect(() => parseIcs(twoEvents, WINDOW, { budget: { maxTotalRows: 1 } })).toThrow(
			/feed exceeds.*row output budget/,
		);
	});

	it("rejects folded-line and parameter shapes before synchronous ICAL.parse can amplify them", () => {
		const folded = vcal(
			"BEGIN:VEVENT\r\nUID:folded\r\nDTSTART:20260701T090000\r\nDESCRIPTION:first\r\n second\r\n third\r\nEND:VEVENT",
		);
		expect(() =>
			parseIcs(folded, WINDOW, { budget: { maxFoldedLinesPerContentLine: 1 } }),
		).toThrow(/folded-line budget/);

		const parameterHeavy = vcal(
			"BEGIN:VEVENT\r\nUID:params\r\nDTSTART:20260701T090000\r\nSUMMARY;X-ONE=a;X-TWO=b:Hello\r\nEND:VEVENT",
		);
		expect(() =>
			parseIcs(parameterHeavy, WINDOW, { budget: { maxParametersPerContentLine: 1 } }),
		).toThrow(/parameter budget/);

		const expensiveUnfolding = vcal(
			"BEGIN:VEVENT\r\nUID:unfolding-work\r\nDTSTART:20260701T090000\r\nDESCRIPTION:123456789\r\n more\r\nEND:VEVENT",
		);
		expect(() =>
			parseIcs(expensiveUnfolding, WINDOW, { budget: { maxUnfoldingWorkChars: 8 } }),
		).toThrow(/unfolding-work budget/);

		const expensiveParameterScan = vcal(
			"BEGIN:VEVENT\r\nUID:parameter-work\r\nDTSTART:20260701T090000\r\nSUMMARY;X-ONE=a:123456789\r\nEND:VEVENT",
		);
		expect(() =>
			parseIcs(expensiveParameterScan, WINDOW, { budget: { maxParameterWorkChars: 8 } }),
		).toThrow(/parameter-work budget/);
	});

	it("keeps valid quoted parameters and normal folded descriptions parseable", () => {
		const ics = vcal(
			"BEGIN:VEVENT\r\nUID:quoted\r\nDTSTART:20260701T090000\r\n" +
				'ATTENDEE;CN="Ada, Lovelace";MEMBER="mailto:one@example.test","mailto:two@example.test";ROLE=REQ-PARTICIPANT:mailto:ada@example.test\r\n' +
				"DESCRIPTION:first part\r\n second part\r\nEND:VEVENT",
		);
		expect(
			parseIcs(ics, WINDOW, {
				budget: {
					maxParametersPerContentLine: 3,
					maxParameterValueDelimitersPerContentLine: 1,
					maxFoldedLinesPerContentLine: 1,
				},
			}),
		).toHaveLength(1);
	});

	it("rejects parameter-list amplification before ical.js allocates MEMBER arrays", () => {
		const members = Array.from(
			{ length: 3 },
			(_, index) => `"mailto:member-${index}@example.test"`,
		).join(",");
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:parameter-list\r\nDTSTART:20260701T090000\r\nATTENDEE;MEMBER=${members}:mailto:owner@example.test\r\nEND:VEVENT`,
		);
		expect(() =>
			parseIcs(ics, WINDOW, { budget: { maxParameterValueDelimitersPerContentLine: 1 } }),
		).toThrow(/parameter-value budget/);
	});

	it("bounds nesting, physical lines, and repeated value delimiters in the structural preflight", () => {
		const deep = vcal("BEGIN:X-ONE\r\nBEGIN:X-TWO\r\nEND:X-TWO\r\nEND:X-ONE");
		expect(() => parseIcs(deep, WINDOW, { budget: { maxComponentDepth: 2 } })).toThrow(
			/component-depth budget/,
		);

		const manyValues = vcal(
			"BEGIN:VEVENT\r\nUID:values\r\nDTSTART:20260701T090000\r\nRDATE:20260702T090000,20260703T090000\r\nEND:VEVENT",
		);
		expect(() =>
			parseIcs(manyValues, WINDOW, { budget: { maxValueDelimitersPerContentLine: 0 } }),
		).toThrow(/value-delimiter budget/);

		expect(() => parseIcs(vcal(""), WINDOW, { budget: { maxPhysicalLines: 2 } })).toThrow(
			/physical-line budget/,
		);
	});

	it("rejects a sub-day VTIMEZONE RRULE before lazy timezone expansion can run", () => {
		const ics = vcal(
			`BEGIN:VTIMEZONE\r\nTZID:Poison/Secondly\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nRRULE:FREQ=SECONDLY\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n` +
				`BEGIN:VEVENT\r\nUID:poison\r\nDTSTART;TZID=Poison/Secondly:20260701T090000\r\nEND:VEVENT`,
		);
		expect(() => parseIcs(ics, WINDOW)).toThrow(/VTIMEZONE RRULE must use FREQ=YEARLY/);
	});
});

describe("parseIcs — ночные (переходящие полночь) вхождения (FIX-7)", () => {
	it("таймированное 23:00–01:00 → две строки СО ВРЕМЕНЕМ (первый день HH:mm–23:59, второй 00:00–HH:mm)", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:night\r\nSUMMARY:Ночная смена\r\nDTSTART:20260706T230000\r\nDTEND:20260707T010000\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		expect(occ).toHaveLength(2);
		expect(occ[0]).toMatchObject({
			date: "2026-07-06",
			allDay: false,
			startTime: "23:00",
			endTime: "23:59",
		});
		expect(occ[1]).toMatchObject({
			date: "2026-07-07",
			allDay: false,
			startTime: "00:00",
			endTime: "01:00",
		});
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

// Именно такой формой Google Calendar в «секретном адресе iCal» отдаёт удалённую
// встречу и удалённое вхождение серии. Раньше STATUS не читался вовсе — отменённая
// планёрка оставалась в календаре, агенде и виджетах бессрочно (зеркало только
// дополняется).
describe("parseIcs — отменённые события (STATUS:CANCELLED)", () => {
	it("отменённое одиночное событие в зеркало не попадает", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:c1\r\nSUMMARY:Отменённая встреча\r\nSTATUS:CANCELLED\r\nDTSTART:20260706T140000\r\nDTEND:20260706T150000\r\nEND:VEVENT`,
		);
		expect(parseIcs(ics, WINDOW)).toEqual([]);
	});

	it("отменённое ВХОЖДЕНИЕ серии (RECURRENCE-ID + STATUS:CANCELLED) выпадает, остальные остаются", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Стендап\r\nDTSTART:20260706T090000Z\r\nDTEND:20260706T093000Z\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20260727T090000Z\r\nSUMMARY:Стендап\r\nSTATUS:CANCELLED\r\nDTSTART:20260727T090000Z\r\nDTEND:20260727T093000Z\r\nEND:VEVENT`,
		);
		const occ = sorted(parseIcs(ics, WINDOW));
		expect(occ).toHaveLength(3); // 06, 13, 20 — 27 отменено
		expect(occ.some((o) => o.recurrenceKey === "2026-07-27T09:00:00Z")).toBe(false);
	});

	it("отменённый МАСТЕР гасит серию целиком", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:dead\r\nSUMMARY:Планёрка\r\nSTATUS:CANCELLED\r\nDTSTART:20260706T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT`,
		);
		expect(parseIcs(ics, WINDOW)).toEqual([]);
	});

	it("STATUS:CONFIRMED / TENTATIVE зеркалятся как обычно", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:ok\r\nSUMMARY:Живая\r\nSTATUS:CONFIRMED\r\nDTSTART:20260706T140000\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:maybe\r\nSUMMARY:Под вопросом\r\nSTATUS:TENTATIVE\r\nDTSTART:20260707T140000\r\nEND:VEVENT`,
		);
		expect(sorted(parseIcs(ics, WINDOW)).map((o) => o.title)).toEqual([
			"Живая",
			"Под вопросом",
		]);
	});
});

// Одно экзотическое событие не должно уносить с собой весь календарь: раньше
// per-серийный бюджет перебрасывался наверх, SyncService писал ошибку в lastError,
// и зеркало не обновлялось вообще — «календарь перестал синхронизироваться».
describe("parseIcs — бюджет одной серии не роняет ленту", () => {
	// Часы заморожены: проверяем ИМЕННО развилку «бюджет серии vs бюджет ленты»,
	// а не скорость раннера (общефидовый лимит времени остаётся фатальным — см.
	// «enforces elapsed-time and global-output budgets» выше). Тесный шаговый
	// бюджет играет роль настоящей floating-серии из 2020: она так же сжигает
	// шаги от самого DTSTART, только за миллисекунды.
	const frozen = { budget: { maxIteratorStepsPerSeries: 200 }, nowMs: () => 0 };

	it("floating FREQ=HOURLY из 2020 пропускается, обычная встреча той же ленты остаётся", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:normal\r\nSUMMARY:Совещание\r\nDTSTART:20260723T140000\r\nDTEND:20260723T150000\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:hourly\r\nSUMMARY:Тик\r\nDTSTART:20200101T000000\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT`,
		);
		const occ = parseIcs(ics, WINDOW, frozen);
		expect(occ.map((o) => o.uid)).toEqual(["normal"]);
		expect(occ[0]).toMatchObject({ date: "2026-07-23", startTime: "14:00" });
	});

	it("порядок VEVENT не важен: переразмерная серия перед обычной встречей", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:hourly\r\nSUMMARY:Тик\r\nDTSTART:20200101T000000\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT\r\n` +
				`BEGIN:VEVENT\r\nUID:normal\r\nSUMMARY:Совещание\r\nDTSTART:20260723T140000\r\nEND:VEVENT`,
		);
		expect(parseIcs(ics, WINDOW, frozen).map((o) => o.uid)).toEqual(["normal"]);
	});

	it("пропущенная серия не оставляет в зеркале своего начатого хвоста", () => {
		const ics = vcal(
			`BEGIN:VEVENT\r\nUID:hourly\r\nSUMMARY:Тик\r\nDTSTART:20260701T000000Z\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT`,
		);
		// 50 строк успевают попасть в out до срыва потолка серии — все они снимаются
		expect(parseIcs(ics, WINDOW, { budget: { maxSeriesRows: 50 }, nowMs: () => 0 })).toEqual(
			[],
		);
	});
});

// DESCRIPTION зеркалом не используется вовсе (MirrorOccurrence его не читает), но
// одна длинная свёрнутая строка навсегда роняла всю подписку: приглашения
// Outlook/Teams регулярно несут HTML-подвал и дисклеймеры больше 9 КБ.
describe("parseIcs — длинные свёрнутые свойства (DESCRIPTION приглашений)", () => {
	/** Сложить контент-строку по RFC 5545 (продолжения начинаются с пробела). */
	function fold(line: string, width = 73): string {
		const parts = [line.slice(0, width)];
		for (let i = width; i < line.length; i += width) parts.push(` ${line.slice(i, i + width)}`);
		return parts.join("\r\n");
	}

	function feedWithDescription(length: number): string {
		return vcal(
			`BEGIN:VEVENT\r\nUID:outlook\r\nSUMMARY:Созвон\r\nDTSTART:20260706T140000\r\nDTEND:20260706T150000\r\n` +
				`${fold(`DESCRIPTION:${"д".repeat(length)}`)}\r\nEND:VEVENT`,
		);
	}

	it.each([9_000, 20_000, 60_000])("DESCRIPTION длиной %i символов не роняет ленту", (n) => {
		const occ = parseIcs(feedWithDescription(n), WINDOW);
		expect(occ).toHaveLength(1);
		expect(occ[0]).toMatchObject({ uid: "outlook", title: "Созвон", startTime: "14:00" });
	});

	it("свойство длиннее заявленного потолка строки по-прежнему отвергается", () => {
		expect(() => parseIcs(feedWithDescription(70_000), WINDOW)).toThrow(/unfolded-line budget/);
	});
});

describe("mirrorWindow", () => {
	it("окно [−14; +92] дней от «сейчас»", () => {
		const w = mirrorWindow(new Date(2026, 6, 15));
		expect(w.start).toEqual(new Date(2026, 6, 1));
		expect(w.end).toEqual(new Date(2026, 9, 15));
	});
});
