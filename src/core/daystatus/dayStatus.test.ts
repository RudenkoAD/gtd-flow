import { describe, expect, it } from "vitest";
import {
	buildDayStatusModel,
	clearSingleDayBody,
	normalizeStatusDefs,
	parseAssignmentLine,
	parseAssignments,
	removeSingleForDate,
	setRangeBody,
	setSingleDayBody,
	statusForDate,
	withEditedBody,
	type DayStatusModel,
} from "./dayStatus";

describe("normalizeStatusDefs", () => {
	it("объект имя→цвет; мусор отброшен", () => {
		const m = normalizeStatusDefs({ работаю: "#4c8bf5", "": "#000", учусь: "", выходной: "#4caf50" });
		expect([...m]).toEqual([
			["работаю", "#4c8bf5"],
			["выходной", "#4caf50"],
		]);
	});
	it("не-объект → пустая карта", () => {
		expect(normalizeStatusDefs(null).size).toBe(0);
		expect(normalizeStatusDefs("x").size).toBe(0);
		expect(normalizeStatusDefs(["a"]).size).toBe(0);
	});
});

describe("parseAssignmentLine", () => {
	it("одиночная дата", () => {
		expect(parseAssignmentLine("2026-07-20: работаю")).toEqual({
			kind: "single",
			date: "2026-07-20",
			status: "работаю",
		});
	});
	it("диапазон; перевёрнутый нормализуется", () => {
		expect(parseAssignmentLine("2026-08-10..2026-08-01: в командировке")).toEqual({
			kind: "range",
			from: "2026-08-01",
			to: "2026-08-10",
			status: "в командировке",
		});
	});
	it("правило повторения; статус из нескольких слов", () => {
		const a = parseAssignmentLine("every week on saturday,sunday: выходной день");
		expect(a?.kind).toBe("recurring");
		expect(a?.status).toBe("выходной день");
	});
	it("последнее двоеточие — разделитель: время в правиле не ломает разбор", () => {
		const a = parseAssignmentLine("every day at 19:00: вечер");
		expect(a?.kind).toBe("recurring");
		expect(a?.status).toBe("вечер");
	});
	it("пустые/заголовки/без двоеточия/пустой статус → null", () => {
		expect(parseAssignmentLine("")).toBeNull();
		expect(parseAssignmentLine("## Назначения")).toBeNull();
		expect(parseAssignmentLine("просто текст")).toBeNull();
		expect(parseAssignmentLine("2026-07-20:   ")).toBeNull();
		expect(parseAssignmentLine("2026-13-40: x")).toBeNull(); // невалидная дата
	});
});

describe("statusForDate", () => {
	const model: DayStatusModel = buildDayStatusModel(
		{ работаю: "#4c8bf5", выходной: "#4caf50", призрак: "" },
		[
			"every week on saturday,sunday: выходной",
			"2026-07-25: работаю", // суббота — переопределяет правило (стоит позже)
			"2026-08-01..2026-08-03: работаю",
			"2026-09-09: призрак", // статус без валидного цвета
		].join("\n"),
	);

	it("правило повторения красит субботу/воскресенье", () => {
		expect(statusForDate(model, "2026-07-26")).toEqual({ name: "выходной", color: "#4caf50" });
	});
	it("одиночная дата позже правила — побеждает", () => {
		expect(statusForDate(model, "2026-07-25")).toEqual({ name: "работаю", color: "#4c8bf5" });
	});
	it("диапазон включительно с обоих концов", () => {
		expect(statusForDate(model, "2026-08-01")?.name).toBe("работаю");
		expect(statusForDate(model, "2026-08-03")?.name).toBe("работаю");
		expect(statusForDate(model, "2026-08-04")).toBeNull();
	});
	it("статус без цвета — пропускается (день не покрашен)", () => {
		expect(statusForDate(model, "2026-09-09")).toBeNull();
	});
	it("непокрашенный день → null", () => {
		expect(statusForDate(model, "2026-07-22")).toBeNull();
	});
});

describe("writeback тела", () => {
	it("setSingleDayBody дедуплицирует прежнюю метку той же даты", () => {
		let body = "2026-07-20: работаю\n";
		body = setSingleDayBody(body, "2026-07-20", "выходной");
		expect(parseAssignments(body).filter((a) => a.kind === "single")).toHaveLength(1);
		expect(body.trim()).toBe("2026-07-20: выходной");
	});
	it("setSingleDayBody в пустом теле", () => {
		expect(setSingleDayBody("", "2026-07-20", "работаю")).toBe("2026-07-20: работаю\n");
	});
	it("clearSingleDayBody снимает одиночную метку даты, прочее сохраняет", () => {
		const body = "every week on saturday,sunday: выходной\n2026-07-20: работаю\n";
		const out = clearSingleDayBody(body, "2026-07-20");
		expect(out).toBe("every week on saturday,sunday: выходной\n");
	});
	it("setRangeBody дописывает нормализованный диапазон", () => {
		expect(setRangeBody("", "2026-08-10", "2026-08-01", "отпуск")).toBe(
			"2026-08-01..2026-08-10: отпуск\n",
		);
	});
	it("removeSingleForDate не трогает диапазоны/правила", () => {
		const body = "2026-07-20..2026-07-22: x\nevery monday: y\n2026-07-20: z";
		expect(removeSingleForDate(body, "2026-07-20")).toBe(
			"2026-07-20..2026-07-22: x\nevery monday: y",
		);
	});
});

describe("withEditedBody", () => {
	it("сохраняет frontmatter, правит только тело", () => {
		const content = '---\ngtd-day-status: true\nstatuses:\n  работаю: "#4c8bf5"\n---\n2026-07-20: работаю\n';
		const out = withEditedBody(content, (b) => setSingleDayBody(b, "2026-07-21", "работаю"));
		expect(out.startsWith('---\ngtd-day-status: true\nstatuses:\n  работаю: "#4c8bf5"\n---\n')).toBe(
			true,
		);
		expect(out).toContain("2026-07-21: работаю");
		expect(out).toContain("2026-07-20: работаю");
	});
	it("без frontmatter — правит весь контент как тело", () => {
		expect(withEditedBody("", (b) => setSingleDayBody(b, "2026-07-20", "работаю"))).toBe(
			"2026-07-20: работаю\n",
		);
	});
	it("frontmatter без завершающего перевода строки — разделитель добавляется", () => {
		const out = withEditedBody("---\ngtd-day-status: true\n---", (b) =>
			setSingleDayBody(b, "2026-07-20", "работаю"),
		);
		expect(out).toBe("---\ngtd-day-status: true\n---\n2026-07-20: работаю\n");
	});
});
