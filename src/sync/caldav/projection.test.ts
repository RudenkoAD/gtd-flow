import { describe, expect, it } from "vitest";
import { BUSY_TITLE, projectOccurrences } from "./projection";
import type { MirrorOccurrence } from "../icsParse";

function occ(over: Partial<MirrorOccurrence> = {}): MirrorOccurrence {
	return {
		uid: "u1",
		recurrenceKey: "2026-07-06T10:00:00",
		date: "2026-07-06",
		allDay: false,
		startTime: "10:00",
		endTime: "10:30",
		title: "Совещание",
		location: "Переговорная 3",
		dayIndex: 0,
		dayCount: 1,
		...over,
	};
}

describe("projectOccurrences — details", () => {
	it("оставляет только название/место; поля идентичности и времени не меняются", () => {
		const input = occ({
			uid: "u42",
			recurrenceKey: "2026-07-06T10:00:00",
			date: "2026-07-06",
			allDay: false,
			startTime: "10:00",
			endTime: "10:30",
			title: "Совещание",
			location: "Переговорная 3",
			dayIndex: 2,
			dayCount: 3,
		});
		const [result] = projectOccurrences([input], "details");

		expect(result!.title).toBe("Совещание");
		expect(result!.location).toBe("Переговорная 3");

		expect(result!.uid).toBe(input.uid);
		expect(result!.recurrenceKey).toBe(input.recurrenceKey);
		expect(result!.date).toBe(input.date);
		expect(result!.allDay).toBe(input.allDay);
		expect(result!.startTime).toBe(input.startTime);
		expect(result!.endTime).toBe(input.endTime);
		expect(result!.dayIndex).toBe(input.dayIndex);
		expect(result!.dayCount).toBe(input.dayCount);
	});
});

describe("projectOccurrences — busy", () => {
	it("заменяет название на generic-заголовок и обнуляет место у КАЖДОГО вхождения", () => {
		const input = [
			occ({ uid: "a", title: "Совещание", location: "Переговорная 3" }),
			occ({ uid: "b", title: "", location: null }),
			occ({ uid: "c", title: "1:1 c ivan.petrov@corp.example", location: "Zoom" }),
		];
		const result = projectOccurrences(input, "busy");

		for (const occRes of result) {
			expect(occRes.title).toBe(BUSY_TITLE);
			expect(occRes.location).toBeNull();
		}
		// идентичность/время не тронуты
		expect(result.map((r) => r.uid)).toEqual(["a", "b", "c"]);
		expect(result.map((r) => r.date)).toEqual(input.map((i) => i.date));
	});
});

describe("projectOccurrences — details: санация SUMMARY/LOCATION", () => {
	it("вырезает URL из названия", () => {
		const [result] = projectOccurrences(
			[occ({ title: "Standup https://meet.example/room?id=7 call", location: null })],
			"details",
		);
		expect(result!.title).not.toContain("https://");
		expect(result!.title).not.toContain("meet.example");
		expect(result!.title).toBe("Standup call");
	});

	it("вырезает mailto: из названия", () => {
		const [result] = projectOccurrences(
			[occ({ title: "Encontro mailto:boss@corp.example hoje", location: null })],
			"details",
		);
		expect(result!.title).not.toContain("mailto:");
		expect(result!.title).not.toContain("boss@corp.example");
		expect(result!.title).toBe("Encontro hoje");
	});

	it("вырезает email-подобный токен из названия", () => {
		const [result] = projectOccurrences(
			[occ({ title: "1:1 c ivan.petrov@corp.example", location: null })],
			"details",
		);
		expect(result!.title).not.toContain("@");
		expect(result!.title).toBe("1:1 c");
	});

	it("вырезает '#' из названия — без инъекции тега Obsidian", () => {
		const [result] = projectOccurrences(
			[occ({ title: "Sprint #alpha review", location: null })],
			"details",
		);
		expect(result!.title).not.toContain("#");
		expect(result!.title).toBe("Sprint alpha review");
	});

	it("LOCATION проходит ту же санацию, что и SUMMARY", () => {
		const [result] = projectOccurrences(
			[occ({ title: "Sync", location: "Room 5 https://maps.example/x #building" })],
			"details",
		);
		expect(result!.location).not.toContain("https://");
		expect(result!.location).not.toContain("#");
		expect(result!.location).toBe("Room 5 building");
	});

	it("схлопывает пробелы в один и обрезает края", () => {
		const [result] = projectOccurrences(
			[
				occ({
					title: "  Standup   call  ",
					location: "  Room   5  ",
				}),
			],
			"details",
		);
		expect(result!.title).toBe("Standup call");
		expect(result!.location).toBe("Room 5");
	});
});

describe("projectOccurrences — details: опустевшее после санации поле", () => {
	it("название, ставшее пустым после санации → generic-заголовок", () => {
		const [result] = projectOccurrences(
			[occ({ title: "https://only-a-link.example/x", location: null })],
			"details",
		);
		expect(result!.title).toBe(BUSY_TITLE);
	});

	it("место, ставшее пустым после санации → null", () => {
		const [result] = projectOccurrences(
			[occ({ title: "Sync", location: "https://only-a-loc.example/y" })],
			"details",
		);
		expect(result!.location).toBeNull();
	});
});

describe("projectOccurrences — детерминированность", () => {
	it("два прогона на одном входе дают глубоко равные результаты; вход не мутируется", () => {
		const input = [
			occ({ uid: "a", title: "Standup https://meet.example/x call" }),
			occ({ uid: "b", title: "", location: null }),
		];
		const snapshot = JSON.parse(JSON.stringify(input)) as unknown;

		const first = projectOccurrences(input, "details");
		const second = projectOccurrences(input, "details");

		expect(first).toEqual(second);
		expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
	});
});

describe("projectOccurrences — Zoom-подобный продюсер", () => {
	it("сохраняет текст названия, вырезая ссылку конференции целиком", () => {
		const [result] = projectOccurrences(
			[
				occ({
					title: "Планёрка (Zoom: https://zoom.example/j/123?pwd=abc)",
					location: null,
				}),
			],
			"details",
		);
		expect(result!.title).toContain("Планёрка");
		expect(result!.title).not.toContain("zoom.example");
		expect(result!.title).not.toContain("pwd");
	});
});
