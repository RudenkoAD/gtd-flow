/**
 * Тесты распознавания русских дат/времени в быстром вводе (parseNlDate).
 * «Сегодня» — всегда параметр (детерминизм). Ориентиры недели 2026:
 * 07-20 пн, 07-22 ср, 07-24 пт, 07-26 вс.
 */
import { describe, expect, it } from "vitest";
import { parseNlDate } from "./nlDate";

const WED = "2026-07-22"; // среда
const FRI = "2026-07-24"; // пятница
const SEP = "2026-09-01"; // для «15 августа» в прошлом → следующий год

describe("parseNlDate — относительные даты", () => {
	it("«сегодня»", () => {
		expect(parseNlDate("сегодня купить хлеб", WED)).toEqual({
			title: "купить хлеб",
			date: "2026-07-22",
			time: null,
		});
	});

	it("«завтра» в начале", () => {
		expect(parseNlDate("завтра позвонить маме", WED)).toEqual({
			title: "позвонить маме",
			date: "2026-07-23",
			time: null,
		});
	});

	it("«завтра» в конце", () => {
		expect(parseNlDate("позвонить маме завтра", WED)).toEqual({
			title: "позвонить маме",
			date: "2026-07-23",
			time: null,
		});
	});

	it("«завтра» в СЕРЕДИНЕ не трогаем (null, текст не меняется)", () => {
		expect(parseNlDate("спланировать завтра поездку", WED)).toBeNull();
	});

	it("«послезавтра»", () => {
		expect(parseNlDate("послезавтра отчёт", WED)).toEqual({
			title: "отчёт",
			date: "2026-07-24",
			time: null,
		});
	});

	it("заглавные буквы распознаются", () => {
		expect(parseNlDate("Завтра позвонить", WED)).toEqual({
			title: "позвонить",
			date: "2026-07-23",
			time: null,
		});
	});
});

describe("parseNlDate — «через N …»", () => {
	it("«через 3 дня»", () => {
		expect(parseNlDate("через 3 дня сдать отчёт", WED)).toEqual({
			title: "сдать отчёт",
			date: "2026-07-25",
			time: null,
		});
	});

	it("«через день» = +1", () => {
		expect(parseNlDate("через день напомнить", WED)?.date).toBe("2026-07-23");
	});

	it("«через неделю» = +7", () => {
		expect(parseNlDate("через неделю ревью", WED)?.date).toBe("2026-07-29");
	});

	it("«через 2 недели» = +14", () => {
		expect(parseNlDate("через 2 недели отпуск", WED)?.date).toBe("2026-08-05");
	});

	it("«через» без единицы — не дата", () => {
		expect(parseNlDate("передать через курьера", WED)).toBeNull();
	});
});

describe("parseNlDate — дни недели", () => {
	it("«в понедельник» — ближайший будущий", () => {
		expect(parseNlDate("в понедельник встреча", WED)?.date).toBe("2026-07-27");
	});

	it("«в пт» при сегодня=пт → следующая неделя (+7)", () => {
		expect(parseNlDate("в пт релиз", FRI)?.date).toBe("2026-07-31");
	});

	it("«во вторник» (предлог «во»)", () => {
		expect(parseNlDate("во вторник созвон", WED)?.date).toBe("2026-07-28");
	});

	it("«в следующий вторник» = +7 к ближайшему", () => {
		expect(parseNlDate("в следующий вторник созвон", WED)?.date).toBe("2026-08-04");
	});

	it("«в среду» при сегодня=ср → следующая среда", () => {
		expect(parseNlDate("в среду планёрка", WED)?.date).toBe("2026-07-29");
	});
});

describe("parseNlDate — календарные даты", () => {
	it("«15 августа» (месяц в родительном)", () => {
		expect(parseNlDate("15 августа поездка", WED)?.date).toBe("2026-08-15");
	});

	it("«15 августа» уже прошло → следующий год", () => {
		expect(parseNlDate("15 августа поездка", SEP)?.date).toBe("2027-08-15");
	});

	it("«15.08» — ближайшая будущая", () => {
		expect(parseNlDate("оплатить 15.08", WED)?.date).toBe("2026-08-15");
	});

	it("«15.08.2026» — явный год", () => {
		expect(parseNlDate("оплатить 15.08.2026", WED)?.date).toBe("2026-08-15");
	});

	it("голое число датой НЕ считается", () => {
		expect(parseNlDate("15 яблок купить", WED)).toBeNull();
		expect(parseNlDate("купить 15 яблок", WED)).toBeNull();
	});

	it("календарно-битая дата не распознаётся", () => {
		expect(parseNlDate("32.08 дедлайн", WED)).toBeNull();
		expect(parseNlDate("15.13 дедлайн", WED)).toBeNull();
	});
});

describe("parseNlDate — время", () => {
	it("«в 15» → 15:00 (соло-время → сегодня)", () => {
		expect(parseNlDate("позвонить в 15", WED)).toEqual({
			title: "позвонить",
			date: "2026-07-22",
			time: "15:00",
		});
	});

	it("«в 15:30»", () => {
		expect(parseNlDate("позвонить в 15:30", WED)?.time).toBe("15:30");
	});

	it("«в 9 утра» = 09:00", () => {
		expect(parseNlDate("зарядка в 9 утра", WED)?.time).toBe("09:00");
	});

	it("«в 9 вечера» = 21:00", () => {
		expect(parseNlDate("позвонить в 9 вечера", WED)).toEqual({
			title: "позвонить",
			date: "2026-07-22",
			time: "21:00",
		});
	});

	it("«в 3 дня» = 15:00 (часть суток «дня» = PM)", () => {
		expect(parseNlDate("встреча в 3 дня", WED)?.time).toBe("15:00");
	});

	it("«с 14 до 16» = интервал", () => {
		expect(parseNlDate("с 14 до 16 совещание", WED)).toEqual({
			title: "совещание",
			date: "2026-07-22",
			time: "14:00-16:00",
		});
	});

	it("«с 14:30 до 16:00»", () => {
		expect(parseNlDate("совещание с 14:30 до 16:00", WED)?.time).toBe("14:30-16:00");
	});

	it("вырожденный интервал (конец ≤ начала) не распознаётся", () => {
		expect(parseNlDate("с 16 до 14 бред", WED)).toBeNull();
	});

	it("невалидный час не распознаётся", () => {
		expect(parseNlDate("позвонить в 25", WED)).toBeNull();
	});

	it("время в СЕРЕДИНЕ не трогаем", () => {
		expect(parseNlDate("купить в 15 молоко", WED)).toBeNull();
	});
});

describe("parseNlDate — дата + время вместе", () => {
	it("«завтра в 15 позвонить маме» (начало)", () => {
		expect(parseNlDate("завтра в 15 позвонить маме", WED)).toEqual({
			title: "позвонить маме",
			date: "2026-07-23",
			time: "15:00",
		});
	});

	it("«позвонить маме завтра в 15» (конец)", () => {
		expect(parseNlDate("позвонить маме завтра в 15", WED)).toEqual({
			title: "позвонить маме",
			date: "2026-07-23",
			time: "15:00",
		});
	});

	it("«15 августа в 9 утра …»", () => {
		expect(parseNlDate("15 августа в 9 утра рейс", WED)).toEqual({
			title: "рейс",
			date: "2026-08-15",
			time: "09:00",
		});
	});
});

describe("parseNlDate — дата+время без описания → null (FIX-12)", () => {
	it("«завтра в 15» без текста → null (не title «завтра», не дата «сегодня»)", () => {
		expect(parseNlDate("завтра в 15", WED)).toBeNull();
	});

	it("«послезавтра в 9 утра» без текста → null", () => {
		expect(parseNlDate("послезавтра в 9 утра", WED)).toBeNull();
	});

	it("«завтра в 15 позвонить маме» — с описанием работает как раньше", () => {
		expect(parseNlDate("завтра в 15 позвонить маме", WED)).toEqual({
			title: "позвонить маме",
			date: "2026-07-23",
			time: "15:00",
		});
	});
});

describe("parseNlDate — «12 утра/дня/ночи» (FIX-13)", () => {
	it("«12 утра» = 12:00 (полдень, коллоквиально)", () => {
		expect(parseNlDate("позвонить завтра в 12 утра", WED)?.time).toBe("12:00");
	});

	it("«12 дня» = 12:00 (полдень)", () => {
		expect(parseNlDate("позвонить завтра в 12 дня", WED)?.time).toBe("12:00");
	});

	it("«12 ночи» = 00:00 (полночь)", () => {
		expect(parseNlDate("позвонить завтра в 12 ночи", WED)?.time).toBe("00:00");
	});
});

describe("parseNlDate — escape кавычками", () => {
	it('«"завтра"» — кавычки сняты, дата НЕ распознана', () => {
		expect(parseNlDate('"завтра" позвонить', WED)).toEqual({
			title: "завтра позвонить",
			date: null,
			time: null,
		});
	});

	it("escape в середине", () => {
		expect(parseNlDate('купить "завтра" молоко', WED)).toEqual({
			title: "купить завтра молоко",
			date: null,
			time: null,
		});
	});

	it("ёлочки «…» тоже escape", () => {
		expect(parseNlDate("«завтра» позвонить", WED)).toEqual({
			title: "завтра позвонить",
			date: null,
			time: null,
		});
	});

	it('многотокенный escape «"через неделю"»', () => {
		expect(parseNlDate('напомнить "через неделю"', WED)).toEqual({
			title: "напомнить через неделю",
			date: null,
			time: null,
		});
	});

	it("кавычки вокруг НЕдатного слова не трогаем (null)", () => {
		expect(parseNlDate('купить "молоко"', WED)).toBeNull();
	});

	it("escape не мешает распознать реальную дату рядом", () => {
		expect(parseNlDate('"послезавтра" купить завтра', WED)).toEqual({
			title: "послезавтра купить",
			date: "2026-07-23",
			time: null,
		});
	});
});

describe("parseNlDate — границы и защита", () => {
	it("выражение без title (весь текст) → null, не съедаем всё", () => {
		expect(parseNlDate("завтра", WED)).toBeNull();
		expect(parseNlDate("в 15", WED)).toBeNull();
		expect(parseNlDate("с 14 до 16", WED)).toBeNull();
	});

	it("нет выражения → null (текст не меняется)", () => {
		expect(parseNlDate("купить молоко и хлеб", WED)).toBeNull();
		expect(parseNlDate("", WED)).toBeNull();
	});

	it("невалидный today → null", () => {
		expect(parseNlDate("завтра дело", "не-дата")).toBeNull();
	});

	it("лишние пробелы вокруг вырезанного выражения схлопнуты", () => {
		expect(parseNlDate("завтра   позвонить    маме", WED)?.title).toBe("позвонить маме");
	});
});
