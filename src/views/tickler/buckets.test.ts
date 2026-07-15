import { describe, expect, it } from "vitest";
import type { IsoDate } from "../../core/model/Task";
import { makeTask } from "../../stores/testSupport";
import { bucketize } from "./buckets";

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
