import { describe, expect, it } from "vitest";
import type { IsoDate } from "../../core/model/Task";
import { makeTask } from "../../stores/testSupport";
import { bucketDeferDate, bucketize } from "./buckets";

function deferred(start: IsoDate, line = 0) {
	return makeTask({ filePath: "GTD/Inbox.md", lineStart: line, start });
}

// 2026-07-15 — среда; неделя с пн: 13–19 июля, с вс: 12–18 июля.
const TODAY = "2026-07-15";

describe("bucketize", () => {
	it("завтра / эта неделя / позже при неделе с понедельника", () => {
		const t16 = deferred("2026-07-16", 1);
		const t17 = deferred("2026-07-17", 2);
		const t19 = deferred("2026-07-19", 3);
		const t20 = deferred("2026-07-20", 4);
		const b = bucketize([t16, t17, t19, t20], TODAY, 1);
		expect(b.tomorrow).toEqual([t16]);
		expect(b.thisWeek).toEqual([t17, t19]);
		expect(b.later).toEqual([t20]);
	});

	it("граница недели зависит от firstDayOfWeek", () => {
		const t18 = deferred("2026-07-18", 1);
		const t19 = deferred("2026-07-19", 2);
		// неделя с воскресенья кончается субботой 18-го: 19-е — уже «Позже»
		const b = bucketize([t18, t19], TODAY, 0);
		expect(b.thisWeek).toEqual([t18]);
		expect(b.later).toEqual([t19]);
	});

	it("сегодня — последний день недели: завтра остаётся «Завтра», неделя пуста", () => {
		const sunday = "2026-07-19";
		const t20 = deferred("2026-07-20", 1);
		const t21 = deferred("2026-07-21", 2);
		const b = bucketize([t20, t21], sunday, 1);
		expect(b.tomorrow).toEqual([t20]);
		expect(b.thisWeek).toEqual([]);
		expect(b.later).toEqual([t21]);
	});

	it("завтра через границу месяца", () => {
		const t = deferred("2026-08-01", 1);
		const b = bucketize([t], "2026-07-31", 1);
		expect(b.tomorrow).toEqual([t]);
	});

	it("порядок сортировки по start сохраняется внутри бакета", () => {
		const a = deferred("2026-07-17", 1);
		const b1 = deferred("2026-07-18", 2);
		const c = deferred("2026-07-18", 3);
		const res = bucketize([a, b1, c], TODAY, 1);
		expect(res.thisWeek).toEqual([a, b1, c]);
	});

	it("робастность: start == null уходит в «Позже», не роняя вид", () => {
		const broken = makeTask({ filePath: "a.md", start: null });
		expect(bucketize([broken], TODAY, 1).later).toEqual([broken]);
	});
});

describe("bucketDeferDate — дата 🛫 при drop на бакет", () => {
	it("Завтра — today+1", () => {
		expect(bucketDeferDate("tomorrow", TODAY, 1)).toBe("2026-07-16");
	});

	it("Эта неделя — конец недели по firstDayOfWeek", () => {
		expect(bucketDeferDate("thisWeek", TODAY, 1)).toBe("2026-07-19");
		expect(bucketDeferDate("thisWeek", TODAY, 0)).toBe("2026-07-18");
	});

	it("Эта неделя в последний день недели — поднимается до завтра", () => {
		// иначе defer на today не отложил бы задачу вовсе (§1: start > today)
		expect(bucketDeferDate("thisWeek", "2026-07-19", 1)).toBe("2026-07-20");
	});

	it("Позже — today+30", () => {
		expect(bucketDeferDate("later", TODAY, 1)).toBe("2026-08-14");
	});

	it("drop-дата попадает в свой же бакет (согласованность с bucketize)", () => {
		for (const id of ["tomorrow", "later"] as const) {
			const t = makeTask({ filePath: "a.md", start: bucketDeferDate(id, TODAY, 1) });
			expect(bucketize([t], TODAY, 1)[id]).toEqual([t]);
		}
		const w = makeTask({ filePath: "a.md", start: bucketDeferDate("thisWeek", TODAY, 1) });
		expect(bucketize([w], TODAY, 1).thisWeek).toEqual([w]);
	});

	// Предзаполнение пикера при дропе (drop → pickDate(initial = bucketDeferDate)):
	// инвариант, гарантирующий, что карточка после дропа не «исчезает», — дата
	// строго в будущем, иначе defer не отложил бы задачу (§1: in tickler требует
	// start > today) и она пропала бы из всех бакетов.
	describe("предзаполнение пикера строго в будущем при любом дне недели", () => {
		const days: IsoDate[] = [
			"2026-07-13", // пн — начало недели
			"2026-07-15", // ср
			"2026-07-18", // сб — предпоследний день недели с пн
			"2026-07-19", // вс — последний день недели с пн
			"2026-07-31", // граница месяца
		];
		for (const fdow of [0, 1] as const) {
			for (const today of days) {
				for (const id of ["tomorrow", "thisWeek", "later"] as const) {
					it(`${id} @ ${today} (fdow=${fdow}) > today`, () => {
						expect(bucketDeferDate(id, today, fdow) > today).toBe(true);
					});
				}
			}
		}
	});
});
