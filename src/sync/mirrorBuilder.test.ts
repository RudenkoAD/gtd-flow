import { describe, expect, it } from "vitest";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { buildMirrorFile, externalOccurrenceId } from "./mirrorBuilder";
import type { MirrorOccurrence } from "./icsParse";

function occ(over: Partial<MirrorOccurrence> = {}): MirrorOccurrence {
	return {
		uid: "u1",
		recurrenceKey: "2026-07-06T10:00:00",
		date: "2026-07-06",
		allDay: false,
		startTime: "10:00",
		endTime: "10:30",
		title: "Событие",
		location: null,
		dayIndex: 0,
		dayCount: 1,
		...over,
	};
}

/** Строки-задачи (без frontmatter/заголовка) из текста файла-зеркала. */
function taskLines(text: string): string[] {
	return text.split("\n").filter((l) => l.startsWith("- [ ]"));
}

describe("externalOccurrenceId — детерминированный короткий 🆔", () => {
	it("одинаковый вход → одинаковый id; 10 base36-символов", () => {
		const id = externalOccurrenceId(occ());
		expect(id).toBe(externalOccurrenceId(occ()));
		expect(id).toMatch(/^[0-9a-z]{10}$/);
	});

	it("разные recurrenceKey / день → разные id (суффикс дня у многодневных)", () => {
		expect(externalOccurrenceId(occ({ recurrenceKey: "2026-07-06T10:00:00" }))).not.toBe(
			externalOccurrenceId(occ({ recurrenceKey: "2026-07-13T10:00:00" })),
		);
		// многодневное: суффикс дня разводит id соседних дней одного вхождения
		const d0 = externalOccurrenceId(occ({ dayIndex: 0, dayCount: 3 }));
		const d1 = externalOccurrenceId(occ({ dayIndex: 1, dayCount: 3 }));
		expect(d0).not.toBe(d1);
	});

	it("однодневное (dayCount 1) не зависит от dayIndex (суффикса нет)", () => {
		expect(externalOccurrenceId(occ({ dayIndex: 0, dayCount: 1 }))).toBe(
			externalOccurrenceId(occ({ dayIndex: 5, dayCount: 1 })),
		);
	});
});

describe("buildMirrorFile — идемпотентность и порядок", () => {
	it("два вызова на одном входе → БАЙТ-В-БАЙТ одинаковый файл", () => {
		const input = [
			occ({ date: "2026-07-08", uid: "b" }),
			occ({ date: "2026-07-06", uid: "a" }),
		];
		const a = buildMirrorFile(input, { name: "Работа" });
		const b = buildMirrorFile(input, { name: "Работа" });
		expect(a).toBe(b);
	});

	it("порядок строк стабилен независимо от порядка входа (дата, время, id)", () => {
		const late = occ({ date: "2026-07-08", startTime: "09:00", uid: "late" });
		const earlyAllDay = occ({
			date: "2026-07-06",
			allDay: true,
			startTime: null,
			endTime: null,
			uid: "ad",
		});
		const earlyTimed = occ({ date: "2026-07-06", startTime: "08:00", uid: "t" });
		const forward = buildMirrorFile([late, earlyAllDay, earlyTimed], { name: "X" });
		const reversed = buildMirrorFile([earlyTimed, earlyAllDay, late], { name: "X" });
		expect(forward).toBe(reversed);
		const lines = taskLines(forward);
		// 2026-07-06 all-day (без времени) → первым, затем 08:00, затем 2026-07-08
		expect(lines[0]).toContain("2026-07-06");
		expect(lines[0]).not.toMatch(/\d\d:\d\d/);
		expect(lines[1]).toContain("2026-07-06");
		expect(lines[1]).toContain("08:00");
		expect(lines[2]).toContain("2026-07-08");
	});
});

describe("buildMirrorFile — формат и frontmatter", () => {
	it("frontmatter: gtd-events + gtd-external + gtd-external-name without namespace", () => {
		const text = buildMirrorFile([], { name: "Личный" });
		expect(text).toContain("gtd-events: true");
		expect(text).toContain("gtd-external: true");
		expect(text).toContain('gtd-external-name: "Личный"');
		expect(text).not.toContain("gtd-namespace");
	});

	it("заголовок-предупреждение в теле", () => {
		expect(buildMirrorFile([], { name: "Cal" })).toContain("Зеркало внешнего календаря");
	});

	it("строка со временем round-trip'ит через парсер (container events)", () => {
		const text = buildMirrorFile([occ({ location: "Зал А" })], { name: "X" });
		const line = taskLines(text)[0]!;
		expect(line).toMatch(
			/^- \[ \] Событие 📅 2026-07-06 10:00-10:30 📍 Зал А 🆔 [0-9a-z]{10}$/,
		);
		const t = parseTaskLine(line, {
			filePath: "X/External/X.md",
			lineStart: 0,
			parentLine: null,
			heading: null,
			container: "events",
			projectActive: true,
		})!;
		expect(t.description).toBe("Событие");
		expect(t.due).toBe("2026-07-06");
		expect(t.dueTime).toBe("10:00");
		expect(t.dueTimeEnd).toBe("10:30");
		expect(t.location).toBe("Зал А");
		expect(t.taskId).toMatch(/^[0-9a-z]{10}$/);
	});

	it("all-day строка — без времени", () => {
		const text = buildMirrorFile([occ({ allDay: true, startTime: null, endTime: null })], {
			name: "X",
		});
		const line = taskLines(text)[0]!;
		expect(line).toMatch(/^- \[ \] Событие 📅 2026-07-06 🆔 [0-9a-z]{10}$/);
	});

	it("эмодзи-поле в названии уже вычищено icsParse — но 🆔 всегда добавляется корректно", () => {
		// (icsParse чистит title; здесь проверяем, что пустой title даёт валидную строку)
		const text = buildMirrorFile([occ({ title: "", location: null })], { name: "X" });
		const line = taskLines(text)[0]!;
		const t = parseTaskLine(line, {
			filePath: "f.md",
			lineStart: 0,
			parentLine: null,
			heading: null,
			container: "events",
			projectActive: true,
		})!;
		expect(t).not.toBeNull();
		expect(t.due).toBe("2026-07-06");
	});
});
