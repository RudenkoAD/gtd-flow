/**
 * Тесты виджет-ядра: агрегат «сегодня» (события ∪ задачи), входящие по
 * пространствам, быстрый захват и цель записи, дефолты без data.json, изоляция
 * ошибок. Все входные времена — из аргументов (todayIso/nowMinutes), поэтому
 * ассерты детерминированы.
 */
import { describe, expect, it } from "vitest";
import {
	buildCaptureLine,
	buildEditedLine,
	captureTargetPath,
	computeWidgetData,
	type LineEdits,
	type WidgetData,
} from "./widgetCore";

/** Разобрать JSON-результат buildEditedLine в объект {ok, line?, error?}. */
function edit(rawLine: string, edits: LineEdits): { ok: boolean; line?: string; error?: string } {
	return JSON.parse(buildEditedLine(rawLine, edits)) as {
		ok: boolean;
		line?: string;
		error?: string;
	};
}

const TODAY = "2026-07-20"; // понедельник

/** data.json с двумя пространствами (Работа→Work, Личное→Home) + commonRoot GTD. */
const DATA_JSON = JSON.stringify({
	commonRoot: "GTD",
	namespaces: [
		{ name: "Работа", root: "Work" },
		{ name: "Личное", root: "Home" },
	],
});

/** Набор файлов: общий инбокс/события + инбоксы пространств + файл задач с датами. */
function fixtureFiles(): Record<string, string> {
	return {
		// «Общее»: файл захвата (container inbox)
		"GTD/Входящие.md":
			"---\ngtd-inbox: true\n---\n" +
			"- [ ] Позвонить маме\n" +
			"- [ ] Купить билеты 🆔 abc123 📍 Вокзал\n" +
			"- [x] Уже сделано\n" +
			"- [ ] С датой уже разобрана 📅 2026-07-25\n",
		// «Общее»: события (одноразовое с местом, all-day, две серии every 2 weeks)
		"GTD/События.md":
			"---\ngtd-events: true\n---\n" +
			"- [ ] Врач 📅 2026-07-20 09:00-09:30 📍 Поликлиника\n" +
			"- [ ] Дедлайн отчёта 📅 2026-07-20\n" +
			"- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 18:00\n" +
			"- [ ] Йога 🔁 every 2 weeks on monday from 2026-07-13 at 07:00\n",
		// «Работа»: инбокс + задачи с датами/временем/🛫
		"Work/Входящие.md": "---\ngtd-inbox: true\n---\n- [ ] Рабочая задача\n",
		"Work/Проект.md":
			"- [ ] Отчёт 📅 2026-07-20 14:00\n" +
			"- [ ] Планёрка 🛫 2026-07-20 11:00\n" +
			"- [ ] Купить подарок 📅 2026-07-20\n" +
			"- [x] Готово 📅 2026-07-20\n" +
			"- [ ] Завтрашняя 📅 2026-07-21\n",
		// «Личное»: инбокс
		"Home/Входящие.md": "---\ngtd-inbox: true\n---\n- [ ] Домашнее дело\n",
	};
}

async function compute(
	over: Partial<{
		files: Record<string, string>;
		dataJson: string | null;
		todayIso: string;
		nowMinutes: number;
		inboxNamespace: string | null;
		agendaDays: number;
	}> = {},
): Promise<WidgetData> {
	const json = await computeWidgetData({
		files: over.files ?? fixtureFiles(),
		dataJson: over.dataJson === undefined ? DATA_JSON : over.dataJson,
		todayIso: over.todayIso ?? TODAY,
		nowMinutes: over.nowMinutes ?? 8 * 60 + 30,
		inboxNamespace: over.inboxNamespace ?? null,
		agendaDays: over.agendaDays,
	});
	return JSON.parse(json) as WidgetData;
}

describe("computeWidgetData — сегодня (агрегат всех пространств)", () => {
	it("порядок: all-day (событие→задача) вперёд, затем по времени", async () => {
		const data = await compute();
		expect(data.errors).toEqual([]);
		const titles = data.today.items.map((i) => i.title);
		// all-day: Дедлайн (событие) → Купить подарок (задача); затем по startMinutes
		expect(titles).toEqual([
			"Дедлайн отчёта",
			"Купить подарок",
			"Врач", // 09:00
			"Планёрка", // 11:00 (🛫)
			"Отчёт", // 14:00
			"Спортзал", // 18:00 (серия every 2 weeks from 07-06)
		]);
	});

	it("одноразовое событие несёт время-интервал, место и пространство", async () => {
		const data = await compute();
		const vrach = data.today.items.find((i) => i.title === "Врач")!;
		expect(vrach.kind).toBe("event");
		expect(vrach.startMinutes).toBe(9 * 60);
		expect(vrach.endMinutes).toBe(9 * 60 + 30);
		expect(vrach.allDay).toBe(false);
		expect(vrach.location).toBe("Поликлиника");
		expect(vrach.namespace).toBe("Общее");
		expect(vrach.file).toBe("GTD/События.md");
	});

	it("задача с 🛫 сегодня размещается по start; выполненные и завтрашние скрыты", async () => {
		const data = await compute();
		const planerka = data.today.items.find((i) => i.title === "Планёрка")!;
		expect(planerka.kind).toBe("task");
		expect(planerka.startMinutes).toBe(11 * 60);
		expect(planerka.namespace).toBe("Работа");
		expect(data.today.items.some((i) => i.title === "Готово")).toBe(false);
		expect(data.today.items.some((i) => i.title === "Завтрашняя")).toBe(false);
	});

	it("серия every 2 weeks: правильная чётность недель (from-якорь)", async () => {
		const today = await compute(); // 2026-07-20
		const todayTitles = today.today.items.map((i) => i.title);
		expect(todayTitles).toContain("Спортзал"); // 07-06 +14 = 07-20
		expect(todayTitles).not.toContain("Йога"); // 07-13 +14 = 07-27

		const alt = await compute({ todayIso: "2026-07-13" });
		const altTitles = alt.today.items.map((i) => i.title);
		expect(altTitles).toContain("Йога"); // якорь 07-13
		expect(altTitles).not.toContain("Спортзал"); // 07-13 — нечётная неделя серии
	});

	it("generatedAt собирается из todayIso + nowMinutes (без Date.now())", async () => {
		const data = await compute({ nowMinutes: 14 * 60 + 5 });
		expect(data.today.date).toBe(TODAY);
		expect(data.today.generatedAt).toBe("2026-07-20T14:05");
	});

	it("обогащение элементов: itemKind / recurrenceText / rawLine (шторка деталей)", async () => {
		const data = await compute();

		const vrach = data.today.items.find((i) => i.title === "Врач")!;
		expect(vrach.itemKind).toBe("single-event");
		expect(vrach.recurrenceText).toBeNull();
		expect(vrach.rawLine).toContain("Врач 📅 2026-07-20 09:00-09:30 📍 Поликлиника");

		const sport = data.today.items.find((i) => i.title === "Спортзал")!;
		expect(sport.itemKind).toBe("series-occurrence");
		expect(sport.recurrenceText).toBe("every 2 weeks on monday from 2026-07-06 at 18:00");
		expect(sport.rawLine).toContain("🔁");

		const planerka = data.today.items.find((i) => i.title === "Планёрка")!;
		expect(planerka.itemKind).toBe("task");
		expect(planerka.recurrenceText).toBeNull();
		expect(planerka.rawLine).toContain("🛫 2026-07-20 11:00");
	});
});

describe("computeWidgetData — входящие по пространствам", () => {
	it("«Общее» (null) — только неразобранные задачи файла захвата", async () => {
		const data = await compute({ inboxNamespace: null });
		expect(data.inbox.namespace).toBe("Общее");
		const titles = data.inbox.items.map((i) => i.title);
		expect(titles).toEqual(["Позвонить маме", "Купить билеты"]);
		const bilety = data.inbox.items.find((i) => i.title === "Купить билеты")!;
		expect(bilety.id).toBe("abc123");
		expect(bilety.location).toBe("Вокзал");
		expect(bilety.file).toBe("GTD/Входящие.md");
	});

	it("«Работа» и «Личное» видят только свой инбокс", async () => {
		const work = await compute({ inboxNamespace: "Работа" });
		expect(work.inbox.namespace).toBe("Работа");
		expect(work.inbox.items.map((i) => i.title)).toEqual(["Рабочая задача"]);

		const home = await compute({ inboxNamespace: "Личное" });
		expect(home.inbox.items.map((i) => i.title)).toEqual(["Домашнее дело"]);
	});

	it("неизвестное пространство — откат к «Общему» + запись в errors", async () => {
		const data = await compute({ inboxNamespace: "Несуществующее" });
		expect(data.inbox.namespace).toBe("Общее");
		expect(data.errors.some((e) => e.includes("Несуществующее"))).toBe(true);
	});

	it("«Все» — агрегат входящих ВСЕХ пространств, у каждого item namespace-метка", async () => {
		const data = await compute({ inboxNamespace: "Все" });
		expect(data.errors).toEqual([]);
		expect(data.inbox.namespace).toBe("Все");
		// порядок cmpInbox: приоритет/created равны ⇒ файл лексикографически, затем строка
		// GTD/… < Home/… < Work/…; внутри GTD — по строке файла
		expect(data.inbox.items.map((i) => i.title)).toEqual([
			"Позвонить маме",
			"Купить билеты",
			"Домашнее дело",
			"Рабочая задача",
		]);
		expect(data.inbox.items.map((i) => i.namespace)).toEqual([
			"Общее",
			"Общее",
			"Личное",
			"Работа",
		]);
	});

	it("метка namespace проставляется и в одиночном режиме пространства", async () => {
		const work = await compute({ inboxNamespace: "Работа" });
		expect(work.inbox.items.every((i) => i.namespace === "Работа")).toBe(true);
	});

	it("namespaces выдаёт список пространств для конфигуратора", async () => {
		const data = await compute();
		expect(data.namespaces).toEqual([
			{ name: "Работа", root: "Work" },
			{ name: "Личное", root: "Home" },
		]);
	});
});

describe("computeWidgetData — дефолты без data.json и изоляция ошибок", () => {
	it("без data.json — дефолты (namespaces пуст, «Общее» видит инбокс)", async () => {
		const data = await compute({ dataJson: null });
		expect(data.namespaces).toEqual([]);
		expect(data.inbox.namespace).toBe("Общее");
		// defs пуст ⇒ nsPredicate прозрачен ⇒ виден общий инбокс
		expect(data.inbox.items.map((i) => i.title)).toContain("Позвонить маме");
	});

	it("битый файл (не строка) уходит в errors, остальное индексируется", async () => {
		const files = fixtureFiles();
		(files as Record<string, unknown>)["broken.md"] = null; // не строка
		const data = await compute({ files });
		expect(data.errors.some((e) => e.includes("broken.md"))).toBe(true);
		// остальные файлы обработаны: входящие и сегодня непусты
		expect(data.inbox.items.length).toBeGreaterThan(0);
		expect(data.today.items.length).toBeGreaterThan(0);
	});

	it("битый data.json — дефолты + error, результат не падает", async () => {
		const data = await compute({ dataJson: "{не json" });
		expect(data.errors.some((e) => e.includes("data.json"))).toBe(true);
		expect(data.namespaces).toEqual([]);
	});
});

describe("buildCaptureLine", () => {
	it("пустой текст — ошибка", () => {
		expect(() => buildCaptureLine("")).toThrow();
		expect(() => buildCaptureLine("   \n  ")).toThrow();
	});

	it("санитация: схлопывание пробелов и срез набранного префикса", () => {
		expect(buildCaptureLine("многострочный\nввод  с   пробелами")).toBe(
			"- [ ] многострочный ввод с пробелами",
		);
		expect(buildCaptureLine("- [x] уже задача")).toBe("- [ ] уже задача");
	});

	it("эмодзи в тексте сохраняются дословно", () => {
		expect(buildCaptureLine("отметить 🎉 праздник")).toBe("- [ ] отметить 🎉 праздник");
	});

	it("место дописывается полем 📍", () => {
		expect(buildCaptureLine("встреча", "офис")).toBe("- [ ] встреча 📍 офис");
	});

	it("недопустимое место (эмодзи поля) не роняет захват — строка без 📍", () => {
		expect(buildCaptureLine("встреча", "офис 📅")).toBe("- [ ] встреча");
	});
});

describe("captureTargetPath", () => {
	it("дефолт (null data.json, «Общее») — <commonRoot>/Входящие.md", () => {
		expect(captureTargetPath(null, null)).toBe("GTD/Входящие.md");
	});

	it("именованное пространство — <root>/Входящие.md", () => {
		expect(captureTargetPath(DATA_JSON, "Работа")).toBe("Work/Входящие.md");
		expect(captureTargetPath(DATA_JSON, "Личное")).toBe("Home/Входящие.md");
	});

	it("«Общее» и «Все» (не цель записи) — <commonRoot>/Входящие.md", () => {
		expect(captureTargetPath(DATA_JSON, "Общее")).toBe("GTD/Входящие.md");
		expect(captureTargetPath(DATA_JSON, "Все")).toBe("GTD/Входящие.md");
	});

	it("пустой commonRoot — голое имя файла в корне", () => {
		const data = JSON.stringify({ commonRoot: "" });
		expect(captureTargetPath(data, null)).toBe("Входящие.md");
	});
});

describe("computeWidgetData — агенда (agendaDays)", () => {
	it("без agendaDays (или 0) агенда не считается — days пуст", async () => {
		const none = await compute();
		expect(none.agenda.days).toEqual([]);
		const zero = await compute({ agendaDays: 0 });
		expect(zero.agenda.days).toEqual([]);
	});

	it("agendaDays: дни от todayIso включительно; день 0 == today.items", async () => {
		const data = await compute({ agendaDays: 8 });
		expect(data.errors).toEqual([]);
		// 8 дней подряд от 2026-07-20
		expect(data.agenda.days.map((d) => d.date)).toEqual([
			"2026-07-20",
			"2026-07-21",
			"2026-07-22",
			"2026-07-23",
			"2026-07-24",
			"2026-07-25",
			"2026-07-26",
			"2026-07-27",
		]);
		// день 0 — та же лента, что today.items
		expect(data.agenda.days[0]!.items.map((i) => i.title)).toEqual(
			data.today.items.map((i) => i.title),
		);
	});

	it("пустые дни включаются с items: []", async () => {
		const data = await compute({ agendaDays: 8 });
		const empty = data.agenda.days.find((d) => d.date === "2026-07-22")!;
		expect(empty.items).toEqual([]);
	});

	it("серия попадает в свой день по якорю (Йога 07-13 +14 = 07-27)", async () => {
		const data = await compute({ agendaDays: 8 });
		const d27 = data.agenda.days.find((d) => d.date === "2026-07-27")!;
		const yoga = d27.items.find((i) => i.title === "Йога")!;
		expect(yoga.itemKind).toBe("series-occurrence");
		expect(yoga.startMinutes).toBe(7 * 60);
		expect(yoga.recurrenceText).toBe("every 2 weeks on monday from 2026-07-13 at 07:00");
		// Спортзал (from 07-06) следующее вхождение 08-03 — вне 8-дневного окна
		expect(d27.items.some((i) => i.title === "Спортзал")).toBe(false);
	});

	it("завтрашняя задача — в дне 07-21, не в today", async () => {
		const data = await compute({ agendaDays: 8 });
		const d21 = data.agenda.days.find((d) => d.date === "2026-07-21")!;
		expect(d21.items.map((i) => i.title)).toEqual(["Завтрашняя"]);
		expect(data.today.items.some((i) => i.title === "Завтрашняя")).toBe(false);
	});

	it("agendaDays клампится к максимуму 30", async () => {
		const data = await compute({ agendaDays: 100 });
		expect(data.agenda.days.length).toBe(30);
		expect(data.agenda.days[0]!.date).toBe("2026-07-20");
	});
});

describe("buildEditedLine — задача", () => {
	it("title через setDescription", () => {
		expect(edit("- [ ] Позвонить маме", { title: "Позвонить папе" })).toEqual({
			ok: true,
			line: "- [ ] Позвонить папе",
		});
	});

	it("дата в ПЕРВОЕ имеющееся поле (📅)", () => {
		expect(edit("- [ ] Купить подарок 📅 2026-07-20", { date: "2026-07-25" })).toEqual({
			ok: true,
			line: "- [ ] Купить подарок 📅 2026-07-25",
		});
	});

	it("дата в 🛫, когда 📅/⏳ нет; время поля сохраняется", () => {
		expect(edit("- [ ] Планёрка 🛫 2026-07-20 11:00", { date: "2026-07-22" })).toEqual({
			ok: true,
			line: "- [ ] Планёрка 🛫 2026-07-22 11:00",
		});
	});

	it("дата добавляется как 📅, если дат нет", () => {
		expect(edit("- [ ] Позвонить маме", { date: "2026-07-25", timeRange: "09:00" })).toEqual({
			ok: true,
			line: "- [ ] Позвонить маме 📅 2026-07-25 09:00",
		});
	});

	it("time — хвост той же даты; интервал", () => {
		expect(edit("- [ ] Отчёт 📅 2026-07-20 14:00", { timeRange: "15:00-16:30" })).toEqual({
			ok: true,
			line: "- [ ] Отчёт 📅 2026-07-20 15:00-16:30",
		});
	});

	it("timeRange null снимает время (дата остаётся)", () => {
		expect(edit("- [ ] Отчёт 📅 2026-07-20 14:00", { timeRange: null })).toEqual({
			ok: true,
			line: "- [ ] Отчёт 📅 2026-07-20",
		});
	});

	it("date null снимает поле-дату целиком", () => {
		expect(edit("- [ ] Купить подарок 📅 2026-07-20", { date: null })).toEqual({
			ok: true,
			line: "- [ ] Купить подарок",
		});
	});

	it("место ставится и снимается", () => {
		expect(edit("- [ ] Встреча", { location: "офис" })).toEqual({
			ok: true,
			line: "- [ ] Встреча 📍 офис",
		});
		expect(edit("- [ ] Встреча 📍 офис", { location: null })).toEqual({
			ok: true,
			line: "- [ ] Встреча",
		});
	});

	it("ведущий 📍 в title допустим (заголовок, не поле)", () => {
		expect(edit("- [ ] Позвонить маме", { title: "📍 Важная встреча" })).toEqual({
			ok: true,
			line: "- [ ] 📍 Важная встреча",
		});
	});
});

describe("buildEditedLine — одноразовое событие", () => {
	it("совмещённая правка title/📅даты/времени/места", () => {
		const res = edit("- [ ] Врач 📅 2026-07-20 09:00-09:30 📍 Поликлиника", {
			title: "Врач-стоматолог",
			date: "2026-07-21",
			timeRange: "10:00",
			location: "Клиника",
		});
		expect(res).toEqual({
			ok: true,
			line: "- [ ] Врач-стоматолог 📅 2026-07-21 10:00 📍 Клиника",
		});
	});
});

describe("buildEditedLine — серия", () => {
	const SERIES = "- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 18:00";

	it("time внутри правила 🔁 (хвост at), интервал", () => {
		expect(edit(SERIES, { timeRange: "19:00-20:30" })).toEqual({
			ok: true,
			line: "- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 19:00-20:30",
		});
	});

	it("timeRange null снимает хвост at из правила", () => {
		expect(edit(SERIES, { timeRange: null })).toEqual({
			ok: true,
			line: "- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06",
		});
	});

	it("title и место серии правятся (место — поле 📍 строки)", () => {
		expect(edit(SERIES, { title: "Тренировка" })).toEqual({
			ok: true,
			line: "- [ ] Тренировка 🔁 every 2 weeks on monday from 2026-07-06 at 18:00",
		});
		expect(edit(SERIES, { location: "Зал" })).toEqual({
			ok: true,
			line: "- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 18:00 📍 Зал",
		});
	});

	it("правка даты серии запрещена", () => {
		expect(edit(SERIES, { date: "2026-07-21" })).toEqual({
			ok: false,
			error: "series-date-not-editable",
		});
		expect(edit(SERIES, { date: null })).toEqual({
			ok: false,
			error: "series-date-not-editable",
		});
	});

	it("вырожденный/битый интервал в правиле — invalid-time-range", () => {
		expect(edit(SERIES, { timeRange: "20:00-19:00" }).error).toBe("invalid-time-range");
	});

	it("серия с «every!» (попала руками) — правку времени отклоняем (§every!)", () => {
		// событий-серий с every! не бывает (создание запрещено), но если строка
		// оказалась в файле — buildEditedLine не должен её «легализовать»
		const line = "- [ ] Полив 🔁 every! 3 days";
		expect(edit(line, { timeRange: "09:00" }).error).toBe("series-completion-not-allowed");
	});
});

// Повторяющаяся ЗАДАЧА (Obsidian Tasks: 🔁 ВМЕСТЕ с полем-датой) — НЕ серия-событие.
// computeWidgetData размещает её placeEvents и отдаёт itemKind='task'; шторка
// показывает поле даты и шлёт date=Set. Правки должны применяться к полю-дате, а
// правило 🔁 — оставаться нетронутым (регресс дефекта: раньше любая правка такой
// строки отвергалась с series-date-not-editable).
describe("buildEditedLine — повторяющаяся задача (🔁 + поле-дата)", () => {
	const RECUR_TASK = "- [ ] Полить цветы 🔁 every 3 days 📅 2026-07-20 09:00";

	it("Tasks-миграция: '🔁 … when done 📅 дата' — задача, дата правится, правило (с «when done») нетронуто", () => {
		// строка мигранта с Tasks: 🔁 несёт «when done», расписание — поле 📅.
		// Классифицируется как задача (есть поле-дата) → дата правится в поле, а
		// сырой текст правила не переписывается (каноникализации в 'every!' нет).
		const line = "- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-21";
		expect(edit(line, { date: "2026-07-28" })).toEqual({
			ok: true,
			line: "- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-28",
		});
	});

	it("правка названия проходит, правило 🔁 и дата сохраняются", () => {
		expect(edit(RECUR_TASK, { title: "Полить фикус" })).toEqual({
			ok: true,
			line: "- [ ] Полить фикус 🔁 every 3 days 📅 2026-07-20 09:00",
		});
	});

	it("дата = текущей (title-only-правка шторки шлёт date=Set(dayIso)) — no-op по дате", () => {
		expect(
			edit(RECUR_TASK, { title: "Полить цветы", date: "2026-07-20", timeRange: "09:00" }),
		).toEqual({
			ok: true,
			line: "- [ ] Полить цветы 🔁 every 3 days 📅 2026-07-20 09:00",
		});
	});

	it("время правится В ПОЛЕ 📅 (а не паразитным 'at' в правиле)", () => {
		expect(edit(RECUR_TASK, { timeRange: "10:00" })).toEqual({
			ok: true,
			line: "- [ ] Полить цветы 🔁 every 3 days 📅 2026-07-20 10:00",
		});
	});

	it("дата-поле реально переносится (перепланирование задачи), 🔁 остаётся", () => {
		expect(edit(RECUR_TASK, { date: "2026-07-25" })).toEqual({
			ok: true,
			line: "- [ ] Полить цветы 🔁 every 3 days 📅 2026-07-25 09:00",
		});
	});

	it("совмещённая правка title/дата/время/место — всё в поле, 🔁 цел", () => {
		expect(
			edit("- [ ] Зарядка 🔁 every day ⏳ 2026-07-20", {
				title: "Зарядка утром",
				date: "2026-07-21",
				timeRange: "07:00-07:30",
				location: "Дом",
			}),
		).toEqual({
			ok: true,
			line: "- [ ] Зарядка утром 🔁 every day ⏳ 2026-07-21 07:00-07:30 📍 Дом",
		});
	});

	it("дата в 🛫 повторяющейся задачи, когда 📅/⏳ нет", () => {
		expect(edit("- [ ] Ревью 🔁 every week 🛫 2026-07-20", { date: "2026-07-27" })).toEqual({
			ok: true,
			line: "- [ ] Ревью 🔁 every week 🛫 2026-07-27",
		});
	});
});

describe("buildEditedLine — ошибки и защита", () => {
	it("не задача — not-a-task", () => {
		expect(edit("обычный текст", { title: "x" })).toEqual({ ok: false, error: "not-a-task" });
	});

	it("пустой title — empty-title", () => {
		expect(edit("- [ ] Задача", { title: "   " }).error).toBe("empty-title");
	});

	it("эмодзи поля в title — invalid-title (ведущий 📍 исключение)", () => {
		expect(edit("- [ ] Задача", { title: "Купить 📅 хлеб" }).error).toBe("invalid-title");
	});

	it("эмодзи поля в location — invalid-location", () => {
		expect(edit("- [ ] Задача", { location: "дом 📅" }).error).toBe("invalid-location");
	});

	it("битое время — invalid-time-range", () => {
		expect(edit("- [ ] Задача 📅 2026-07-20", { timeRange: "25:00" }).error).toBe(
			"invalid-time-range",
		);
		expect(edit("- [ ] Задача 📅 2026-07-20", { timeRange: "10:00-09:00" }).error).toBe(
			"invalid-time-range",
		);
	});

	it("календарно-битая дата — invalid-date", () => {
		expect(edit("- [ ] Задача 📅 2026-07-20", { date: "2026-02-30" }).error).toBe("invalid-date");
	});

	it("время без даты — time-without-date", () => {
		expect(edit("- [ ] Задача", { timeRange: "10:00" }).error).toBe("time-without-date");
	});

	it("результат всегда валидная JSON-строка", () => {
		const raw = buildEditedLine("- [ ] Задача", { title: "Новая" });
		expect(typeof raw).toBe("string");
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});
