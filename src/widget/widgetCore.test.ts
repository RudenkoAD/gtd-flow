/**
 * Тесты виджет-ядра — ЕДИНСТВЕННЫЙ автоматический контракт между плагином и
 * Android-приложением: коды ошибок buildEditedLine, семантика buildCaptureLine/
 * captureTargetPath, состав и сортировка лент «сегодня»/«агенда» (Kotlin строит
 * ленту на допущении «пустые дни включены»). Регрессия здесь не всплывёт ни в
 * одном другом гейте плагина — только на телефоне.
 *
 * Все входные времена приходят аргументами (todayIso/nowMinutes), поэтому
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

function edit(rawLine: string, edits: LineEdits): { ok: boolean; line?: string; error?: string } {
	return JSON.parse(buildEditedLine(rawLine, edits)) as {
		ok: boolean;
		line?: string;
		error?: string;
	};
}

const files = {
	"GTD/Inbox.md":
		"---\ngtd-inbox: true\n---\n- [ ] Reconcile invoices ⏱ 90m 🧠 4 💓 2 💪 0 🧭 work\n",
	".gtd-flow/config/scopes.json": JSON.stringify({
		schemaVersion: 1,
		scopes: [{ id: "work", name: "Work", order: 0, archived: false }],
	}),
};

describe("widget metadata", () => {
	it("returns unified inbox items with parsed and resolved manual metadata", async () => {
		const data = JSON.parse(
			await computeWidgetData({
				files,
				dataJson: JSON.stringify({ inboxFile: "GTD/Inbox.md" }),
				todayIso: "2026-07-20",
				nowMinutes: 0,
				inboxScope: "work",
			}),
		) as WidgetData;
		expect(data.inbox.scope).toBe("work");
		expect(data.inbox.items[0]?.metadata).toEqual({
			durationMinutes: 90,
			durationLabel: "1h 30m",
			cognitiveIntensity: 4,
			emotionalIntensity: 2,
			physicalIntensity: 0,
			scopeId: "work",
			scopeName: "Work",
		});
		expect(data.scopes).toEqual([{ id: "work", name: "Work", archived: false }]);
	});

	it("uses the configured unified capture target", () => {
		expect(captureTargetPath(JSON.stringify({ inboxFile: "Capture.md" }))).toBe("Capture.md");
	});

	it("does not expose a legacy gtd-inbox file as a second inbox", async () => {
		const data = JSON.parse(
			await computeWidgetData({
				files: {
					...files,
					"GTD/Legacy Inbox.md": "---\ngtd-inbox: true\n---\n- [ ] Legacy task\n",
				},
				dataJson: JSON.stringify({ inboxFile: "GTD/Inbox.md" }),
				todayIso: "2026-07-20",
				nowMinutes: 0,
			}),
		) as WidgetData;
		expect(data.inbox.items.map((item) => item.title)).toEqual(["Reconcile invoices"]);
	});

	it("edits/clears all metadata fields in one returned line", () => {
		expect(
			edit("- [ ] Task", {
				durationMinutes: 90,
				cognitiveIntensity: 4,
				emotionalIntensity: 2,
				physicalIntensity: 0,
				scopeId: "work",
			}),
		).toEqual({ ok: true, line: "- [ ] Task ⏱ 90m 🧠 4 💓 2 💪 0 🧭 work" });
		expect(edit("- [ ] Task", { durationMinutes: 13 }).error).toBe("invalid-duration");
		expect(edit("- [ ] Task", { durationMinutes: 2_220 }).error).toBe("invalid-duration");
		expect(edit("- [ ] Task", { durationMinutes: 2_880 })).toEqual({
			ok: true,
			line: "- [ ] Task ⏱ 2880m",
		});
	});
});

const TODAY = "2026-07-20"; // понедельник

/** data.json единой модели: один файл входящих, пространств больше нет. */
const DATA_JSON = JSON.stringify({
	settingsVersion: 2,
	inboxFile: "GTD/Inbox.md",
});

/** Единый инбокс + события (одноразовые и две серии) + обычная заметка с датами. */
function fixtureFiles(): Record<string, string> {
	return {
		"GTD/Inbox.md":
			"---\ngtd-inbox: true\n---\n" +
			"- [ ] Позвонить маме\n" +
			"- [ ] Купить билеты 🆔 abc123 📍 Вокзал\n" +
			"- [ ] Рабочая задача 🧭 work\n" +
			"- [x] Уже сделано\n" +
			"- [ ] С датой уже разобрана 📅 2026-07-25\n",
		"GTD/События.md":
			"---\ngtd-events: true\n---\n" +
			"- [ ] Врач 📅 2026-07-20 09:00-09:30 📍 Поликлиника\n" +
			"- [ ] Дедлайн отчёта 📅 2026-07-20\n" +
			"- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 18:00\n" +
			"- [ ] Йога 🔁 every 2 weeks on monday from 2026-07-13 at 07:00\n",
		"Work/Проект.md":
			"- [ ] Отчёт 📅 2026-07-20 14:00\n" +
			"- [ ] Планёрка 🛫 2026-07-20 11:00\n" +
			"- [ ] Купить подарок 📅 2026-07-20\n" +
			"- [x] Готово 📅 2026-07-20\n" +
			"- [ ] Завтрашняя 📅 2026-07-21\n",
		".gtd-flow/config/scopes.json": JSON.stringify({
			schemaVersion: 1,
			scopes: [{ id: "work", name: "Работа", order: 0, archived: false }],
		}),
	};
}

async function compute(
	over: Partial<{
		files: Record<string, string>;
		dataJson: string | null;
		todayIso: string;
		nowMinutes: number;
		inboxScope: string | null;
		agendaDays: number;
	}> = {},
): Promise<WidgetData> {
	const json = await computeWidgetData({
		files: over.files ?? fixtureFiles(),
		dataJson: over.dataJson === undefined ? DATA_JSON : over.dataJson,
		todayIso: over.todayIso ?? TODAY,
		nowMinutes: over.nowMinutes ?? 8 * 60 + 30,
		inboxScope: over.inboxScope ?? null,
		agendaDays: over.agendaDays,
	});
	return JSON.parse(json) as WidgetData;
}

describe("computeWidgetData — сегодня (глобальный агрегат)", () => {
	it("порядок: all-day (событие→задача) вперёд, затем по времени", async () => {
		const data = await compute();
		expect(data.errors).toEqual([]);
		expect(data.today.items.map((i) => i.title)).toEqual([
			"Дедлайн отчёта", // all-day событие
			"Купить подарок", // all-day задача
			"Врач", // 09:00
			"Планёрка", // 11:00 (🛫)
			"Отчёт", // 14:00
			"Спортзал", // 18:00 (серия every 2 weeks from 07-06)
		]);
	});

	it("одноразовое событие несёт время-интервал, место и файл", async () => {
		const vrach = (await compute()).today.items.find((i) => i.title === "Врач")!;
		expect(vrach.kind).toBe("event");
		expect(vrach.startMinutes).toBe(9 * 60);
		expect(vrach.endMinutes).toBe(9 * 60 + 30);
		expect(vrach.allDay).toBe(false);
		expect(vrach.location).toBe("Поликлиника");
		expect(vrach.file).toBe("GTD/События.md");
	});

	it("задача с 🛫 сегодня размещается по start; выполненные и завтрашние скрыты", async () => {
		const data = await compute();
		const planerka = data.today.items.find((i) => i.title === "Планёрка")!;
		expect(planerka.kind).toBe("task");
		expect(planerka.startMinutes).toBe(11 * 60);
		expect(data.today.items.some((i) => i.title === "Готово")).toBe(false);
		expect(data.today.items.some((i) => i.title === "Завтрашняя")).toBe(false);
	});

	it("серия every 2 weeks: правильная чётность недель (from-якорь)", async () => {
		const todayTitles = (await compute()).today.items.map((i) => i.title);
		expect(todayTitles).toContain("Спортзал"); // 07-06 +14 = 07-20
		expect(todayTitles).not.toContain("Йога"); // 07-13 +14 = 07-27

		const altTitles = (await compute({ todayIso: "2026-07-13" })).today.items.map(
			(i) => i.title,
		);
		expect(altTitles).toContain("Йога"); // якорь 07-13
		expect(altTitles).not.toContain("Спортзал"); // для «Спортзала» это нечётная неделя
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

	it("строки зеркала внешнего календаря помечены external (гейт правки на клиенте)", async () => {
		const withMirror = fixtureFiles();
		withMirror["GTD/Календари/Работа.md"] =
			"---\ngtd-events: true\ngtd-external: true\n---\n" +
			"- [ ] Синк команды 📅 2026-07-20 12:00-12:30\n";
		const data = await compute({ files: withMirror });

		const sync = data.today.items.find((i) => i.title === "Синк команды")!;
		expect(sync.external).toBe(true);
		// обычные строки vault остаются редактируемыми
		expect(data.today.items.find((i) => i.title === "Врач")!.external).toBe(false);
		expect(data.inbox.items.every((i) => i.external === false)).toBe(true);
	});
});

describe("computeWidgetData — единые входящие и фильтр по scope", () => {
	it("без scope — все неразобранные задачи настроенного файла захвата", async () => {
		const data = await compute();
		expect(data.inbox.scope).toBeNull();
		expect(data.inbox.items.map((i) => i.title)).toEqual([
			"Позвонить маме",
			"Купить билеты",
			"Рабочая задача",
		]);
		const bilety = data.inbox.items.find((i) => i.title === "Купить билеты")!;
		expect(bilety.id).toBe("abc123");
		expect(bilety.location).toBe("Вокзал");
		expect(bilety.file).toBe("GTD/Inbox.md");
	});

	it("inboxScope режет ленту по 🧭; неизвестный scope даёт пустую ленту", async () => {
		const work = await compute({ inboxScope: "work" });
		expect(work.inbox.scope).toBe("work");
		expect(work.inbox.items.map((i) => i.title)).toEqual(["Рабочая задача"]);
		const unknown = await compute({ inboxScope: "нет-такого" });
		expect(unknown.inbox.items).toEqual([]);
	});

	it("задачи ОБЫЧНЫХ заметок во входящие не протекают (скоуп входящих)", async () => {
		const data = await compute();
		expect(data.inbox.items.some((i) => i.file === "Work/Проект.md")).toBe(false);
	});

	it("scopes выдаёт каталог для конфигуратора виджета", async () => {
		expect((await compute()).scopes).toEqual([{ id: "work", name: "Работа", archived: false }]);
	});
});

describe("computeWidgetData — дефолты без data.json и изоляция ошибок", () => {
	it("без data.json — фабричный inboxFile, он же и виден во входящих", async () => {
		const data = await compute({ dataJson: null });
		expect(data.errors).toEqual([]);
		expect(data.inbox.items.map((i) => i.title)).toContain("Позвонить маме");
	});

	it("битый файл (не строка) уходит в errors, остальное индексируется", async () => {
		const files = fixtureFiles();
		(files as Record<string, unknown>)["broken.md"] = null; // не строка
		const data = await compute({ files });
		expect(data.errors.some((e) => e.includes("broken.md"))).toBe(true);
		expect(data.inbox.items.length).toBeGreaterThan(0);
		expect(data.today.items.length).toBeGreaterThan(0);
	});

	it("битый data.json — дефолты + error, результат не падает", async () => {
		const data = await compute({ dataJson: "{не json" });
		expect(data.errors.some((e) => e.includes("data.json"))).toBe(true);
		expect(data.today.items.length).toBeGreaterThan(0);
	});
});

describe("computeWidgetData — агенда (agendaDays)", () => {
	it("без agendaDays (или 0) агенда не считается — days пуст", async () => {
		expect((await compute()).agenda.days).toEqual([]);
		expect((await compute({ agendaDays: 0 })).agenda.days).toEqual([]);
	});

	it("agendaDays: дни от todayIso включительно; день 0 == today.items", async () => {
		const data = await compute({ agendaDays: 8 });
		expect(data.errors).toEqual([]);
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
		expect(data.agenda.days[0]!.items.map((i) => i.title)).toEqual(
			data.today.items.map((i) => i.title),
		);
	});

	it("пустые дни включаются с items: [] (Kotlin строит ленту на этом)", async () => {
		const data = await compute({ agendaDays: 8 });
		expect(data.agenda.days.find((d) => d.date === "2026-07-22")!.items).toEqual([]);
	});

	it("серия попадает в свой день по якорю (Йога 07-13 +14 = 07-27)", async () => {
		const d27 = (await compute({ agendaDays: 8 })).agenda.days.find(
			(d) => d.date === "2026-07-27",
		)!;
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

describe("captureTargetPath", () => {
	it("дефолт (null/битый data.json) — фабричный единый файл входящих", () => {
		expect(captureTargetPath(null)).toBe("GTD/Inbox.md");
		expect(captureTargetPath("{не json")).toBe("GTD/Inbox.md");
		expect(captureTargetPath(JSON.stringify({ inboxFile: "   " }))).toBe("GTD/Inbox.md");
	});

	it("настроенный inboxFile — цель записи один в один", () => {
		expect(captureTargetPath(DATA_JSON)).toBe("GTD/Inbox.md");
		expect(captureTargetPath(JSON.stringify({ inboxFile: "Capture.md" }))).toBe("Capture.md");
	});

	// Контракт с плагином: до первого запуска 0.13 в data.json ещё нет inboxFile,
	// и виджет обязан вывести ТОТ ЖЕ путь, что выведет миграция плагина, — иначе
	// захват с телефона уходит мимо входящих (QueryEngine.isInInbox сверяет путь).
	it("не мигрированный data.json — конвенционный <commonRoot>/Входящие.md", () => {
		expect(
			captureTargetPath(
				JSON.stringify({
					commonRoot: "GTD",
					namespaces: [{ name: "Работа", root: "Work" }],
					recurring: { spawnTarget: "GTD/Inbox.md" },
				}),
			),
		).toBe("GTD/Входящие.md");
		expect(captureTargetPath(JSON.stringify({ commonRoot: "" }))).toBe("GTD/Inbox.md");
	});
});

describe("buildCaptureLine", () => {
	it("санитация: схлопывание пробелов и срез набранного префикса", () => {
		expect(buildCaptureLine("многострочный\nввод  с   пробелами")).toBe(
			"- [ ] многострочный ввод с пробелами",
		);
		expect(buildCaptureLine("- [x] уже задача")).toBe("- [ ] уже задача");
	});

	it("пустой текст — ошибка (виджет не пишет пустую строку)", () => {
		expect(() => buildCaptureLine("")).toThrow();
		expect(() => buildCaptureLine("   \n  ")).toThrow();
	});

	it("место дописывается полем 📍; недопустимое место не роняет захват", () => {
		expect(buildCaptureLine("встреча", "офис")).toBe("- [ ] встреча 📍 офис");
		expect(buildCaptureLine("встреча", "офис 📅")).toBe("- [ ] встреча");
	});

	it("todayIso включает NLP; без него — обратная совместимость моста", () => {
		expect(buildCaptureLine("завтра в 15 позвонить маме", null, TODAY)).toBe(
			"- [ ] позвонить маме 📅 2026-07-21 15:00",
		);
		expect(buildCaptureLine("завтра встреча", "офис", TODAY)).toBe(
			"- [ ] встреча 📅 2026-07-21 📍 офис",
		);
		expect(buildCaptureLine("завтра встреча")).toBe("- [ ] завтра встреча");
		expect(buildCaptureLine("завтра встреча", null, "не-дата")).toBe("- [ ] завтра встреча");
		expect(buildCaptureLine('"завтра" встреча', null, TODAY)).toBe("- [ ] завтра встреча");
	});
});

describe("buildEditedLine — задача", () => {
	it("title через setDescription", () => {
		expect(edit("- [ ] Позвонить маме", { title: "Позвонить папе" })).toEqual({
			ok: true,
			line: "- [ ] Позвонить папе",
		});
	});

	it("дата в ПЕРВОЕ имеющееся поле (📅), иначе 🛫, иначе добавляется 📅", () => {
		expect(edit("- [ ] Купить подарок 📅 2026-07-20", { date: "2026-07-25" })).toEqual({
			ok: true,
			line: "- [ ] Купить подарок 📅 2026-07-25",
		});
		expect(edit("- [ ] Планёрка 🛫 2026-07-20 11:00", { date: "2026-07-22" })).toEqual({
			ok: true,
			line: "- [ ] Планёрка 🛫 2026-07-22 11:00",
		});
		expect(edit("- [ ] Позвонить маме", { date: "2026-07-25", timeRange: "09:00" })).toEqual({
			ok: true,
			line: "- [ ] Позвонить маме 📅 2026-07-25 09:00",
		});
	});

	it("time — хвост той же даты; null снимает время, date null — поле целиком", () => {
		expect(edit("- [ ] Отчёт 📅 2026-07-20 14:00", { timeRange: "15:00-16:30" })).toEqual({
			ok: true,
			line: "- [ ] Отчёт 📅 2026-07-20 15:00-16:30",
		});
		expect(edit("- [ ] Отчёт 📅 2026-07-20 14:00", { timeRange: null })).toEqual({
			ok: true,
			line: "- [ ] Отчёт 📅 2026-07-20",
		});
		expect(edit("- [ ] Купить подарок 📅 2026-07-20", { date: null })).toEqual({
			ok: true,
			line: "- [ ] Купить подарок",
		});
	});

	it("место ставится и снимается; ведущий 📍 в title допустим (заголовок, не поле)", () => {
		expect(edit("- [ ] Встреча", { location: "офис" })).toEqual({
			ok: true,
			line: "- [ ] Встреча 📍 офис",
		});
		expect(edit("- [ ] Встреча 📍 офис", { location: null })).toEqual({
			ok: true,
			line: "- [ ] Встреча",
		});
		expect(edit("- [ ] Позвонить маме", { title: "📍 Важная встреча" })).toEqual({
			ok: true,
			line: "- [ ] 📍 Важная встреча",
		});
	});
});

describe("buildEditedLine — одноразовое событие", () => {
	it("совмещённая правка title/📅даты/времени/места", () => {
		expect(
			edit("- [ ] Врач 📅 2026-07-20 09:00-09:30 📍 Поликлиника", {
				title: "Врач-стоматолог",
				date: "2026-07-21",
				timeRange: "10:00",
				location: "Клиника",
			}),
		).toEqual({ ok: true, line: "- [ ] Врач-стоматолог 📅 2026-07-21 10:00 📍 Клиника" });
	});
});

describe("buildEditedLine — серия", () => {
	const SERIES = "- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 18:00";

	it("time внутри правила 🔁 (хвост at), интервал; null снимает хвост", () => {
		expect(edit(SERIES, { timeRange: "19:00-20:30" })).toEqual({
			ok: true,
			line: "- [ ] Спортзал 🔁 every 2 weeks on monday from 2026-07-06 at 19:00-20:30",
		});
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

	it("правка даты серии запрещена; вырожденный интервал — invalid-time-range", () => {
		expect(edit(SERIES, { date: "2026-07-21" })).toEqual({
			ok: false,
			error: "series-date-not-editable",
		});
		expect(edit(SERIES, { date: null })).toEqual({
			ok: false,
			error: "series-date-not-editable",
		});
		expect(edit(SERIES, { timeRange: "20:00-19:00" }).error).toBe("invalid-time-range");
	});

	it("серия «от выполнения» (попала руками) — правку времени отклоняем (§every!)", () => {
		// событий-серий с every! не бывает (создание запрещено), но если строка
		// оказалась в файле — buildEditedLine не должен её «легализовать»
		expect(edit("- [ ] Полив 🔁 every! 3 days", { timeRange: "09:00" }).error).toBe(
			"series-completion-not-allowed",
		);
		// та же семантика в Tasks-синтаксисе (мигрант 0.11.0) — тот же отказ
		expect(edit("- [ ] Полив 🔁 every 3 days when done", { timeRange: "09:00" }).error).toBe(
			"series-completion-not-allowed",
		);
	});
});

// Повторяющаяся ЗАДАЧА (Obsidian Tasks: 🔁 ВМЕСТЕ с полем-датой) — НЕ серия-событие.
// computeWidgetData размещает её placeEvents и отдаёт itemKind='task'; шторка
// показывает поле даты и шлёт date=Set. Правки должны применяться к полю-дате, а
// правило 🔁 — оставаться нетронутым (регресс дефекта: раньше любая правка такой
// строки отвергалась с series-date-not-editable).
describe("buildEditedLine — повторяющаяся задача (🔁 + поле-дата)", () => {
	const RECUR_TASK = "- [ ] Полить цветы 🔁 every 3 days 📅 2026-07-20 09:00";

	it("Tasks-миграция: '🔁 … when done 📅 дата' — задача, дата правится, правило нетронуто", () => {
		// строка мигранта с Tasks: 🔁 несёт «when done», расписание — поле 📅.
		// Классифицируется как задача (есть поле-дата) → дата правится в поле, а
		// сырой текст правила не переписывается (каноникализации в 'every!' нет).
		expect(
			edit("- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-21", {
				date: "2026-07-28",
			}),
		).toEqual({ ok: true, line: "- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-28" });
	});

	it("мигрант Tasks: время и название правятся в поле, «when done» цело", () => {
		const line = "- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-20 09:00";
		expect(edit(line, { timeRange: "10:00" })).toEqual({
			ok: true,
			line: "- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-20 10:00",
		});
		expect(edit(line, { title: "Полить фикус" })).toEqual({
			ok: true,
			line: "- [ ] Полить фикус 🔁 every 3 days when done 📅 2026-07-20 09:00",
		});
	});

	it("наш «every!» с полем-датой правится так же, как мигрант", () => {
		expect(edit("- [ ] Ревью 🔁 every! 3 days ⏳ 2026-07-20", { date: "2026-07-27" })).toEqual({
			ok: true,
			line: "- [ ] Ревью 🔁 every! 3 days ⏳ 2026-07-27",
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
		).toEqual({ ok: true, line: "- [ ] Полить цветы 🔁 every 3 days 📅 2026-07-20 09:00" });
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
	it("не задача — not-a-task; пустой title — empty-title", () => {
		expect(edit("обычный текст", { title: "x" })).toEqual({ ok: false, error: "not-a-task" });
		expect(edit("- [ ] Задача", { title: "   " }).error).toBe("empty-title");
	});

	it("эмодзи поля в title/location запрещены", () => {
		expect(edit("- [ ] Задача", { title: "Купить 📅 хлеб" }).error).toBe("invalid-title");
		expect(edit("- [ ] Задача", { location: "дом 📅" }).error).toBe("invalid-location");
	});

	it("битое время / битая дата / время без даты", () => {
		expect(edit("- [ ] Задача 📅 2026-07-20", { timeRange: "25:00" }).error).toBe(
			"invalid-time-range",
		);
		expect(edit("- [ ] Задача 📅 2026-07-20", { timeRange: "10:00-09:00" }).error).toBe(
			"invalid-time-range",
		);
		expect(edit("- [ ] Задача 📅 2026-07-20", { date: "2026-02-30" }).error).toBe(
			"invalid-date",
		);
		expect(edit("- [ ] Задача", { timeRange: "10:00" }).error).toBe("time-without-date");
	});

	it("результат всегда валидная JSON-строка", () => {
		const raw = buildEditedLine("- [ ] Задача", { title: "Новая" });
		expect(typeof raw).toBe("string");
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});
