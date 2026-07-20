/**
 * Тесты виджет-ядра: агрегат «сегодня» (события ∪ задачи), входящие по
 * пространствам, быстрый захват и цель записи, дефолты без data.json, изоляция
 * ошибок. Все входные времена — из аргументов (todayIso/nowMinutes), поэтому
 * ассерты детерминированы.
 */
import { describe, expect, it } from "vitest";
import {
	buildCaptureLine,
	captureTargetPath,
	computeWidgetData,
	type WidgetData,
} from "./widgetCore";

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
	}> = {},
): Promise<WidgetData> {
	const json = await computeWidgetData({
		files: over.files ?? fixtureFiles(),
		dataJson: over.dataJson === undefined ? DATA_JSON : over.dataJson,
		todayIso: over.todayIso ?? TODAY,
		nowMinutes: over.nowMinutes ?? 8 * 60 + 30,
		inboxNamespace: over.inboxNamespace ?? null,
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
