import { describe, expect, it } from "vitest";
import { addDaysIso, dayOfWeekSun0, endOfWeek, startOfWeek } from "./dates";

describe("addDaysIso", () => {
	it("шагает через границу месяца", () => {
		expect(addDaysIso("2026-07-31", 1)).toBe("2026-08-01");
	});

	it("учитывает високосный февраль", () => {
		expect(addDaysIso("2024-02-28", 1)).toBe("2024-02-29");
		expect(addDaysIso("2026-02-28", 1)).toBe("2026-03-01");
	});

	it("шагает через границу года и назад", () => {
		expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
	});

	it("ноль дней — тождество", () => {
		expect(addDaysIso("2026-07-15", 0)).toBe("2026-07-15");
	});
});

describe("dayOfWeekSun0", () => {
	it("2026-07-15 — среда (3 в нумерации 0=вс)", () => {
		expect(dayOfWeekSun0("2026-07-15")).toBe(3);
	});

	it("2026-07-19 — воскресенье (0)", () => {
		expect(dayOfWeekSun0("2026-07-19")).toBe(0);
	});
});

describe("endOfWeek", () => {
	it("неделя с понедельника кончается воскресеньем", () => {
		expect(endOfWeek("2026-07-15", 1)).toBe("2026-07-19");
	});

	it("неделя с воскресенья кончается субботой", () => {
		expect(endOfWeek("2026-07-15", 0)).toBe("2026-07-18");
	});

	it("последний день недели — сам себе конец", () => {
		expect(endOfWeek("2026-07-19", 1)).toBe("2026-07-19");
		expect(endOfWeek("2026-07-18", 0)).toBe("2026-07-18");
	});

	it("первый день недели — конец через 6 дней", () => {
		expect(endOfWeek("2026-07-13", 1)).toBe("2026-07-19");
	});
});

describe("startOfWeek", () => {
	it("среда откатывается к понедельнику или воскресенью", () => {
		expect(startOfWeek("2026-07-15", 1)).toBe("2026-07-13");
		expect(startOfWeek("2026-07-15", 0)).toBe("2026-07-12");
	});

	it("первый день недели — сам себе начало", () => {
		expect(startOfWeek("2026-07-13", 1)).toBe("2026-07-13");
		expect(startOfWeek("2026-07-12", 0)).toBe("2026-07-12");
	});

	it("переход через границу года", () => {
		expect(startOfWeek("2026-01-01", 1)).toBe("2025-12-29");
	});
});
