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

describe("идентичность и scope v5 (CalDAV)", () => {
	// Фиксированные вхождения для регрессии байт-стабильности ниже.
	const legacyA = occ({ uid: "fixed-uid-A", recurrenceKey: "2026-07-06T10:00:00" });
	const legacyB = occ({
		uid: "fixed-uid-B",
		recurrenceKey: "2026-07-13T09:00:00",
		date: "2026-07-13",
		startTime: "09:00",
		endTime: "09:30",
	});

	it("РЕГРЕССИЯ БАЙТ-СТАБИЛЬНОСТИ: externalOccurrenceId без namespace — те же id, что и до CalDAV (§4.5)", () => {
		// Значения получены прогоном ТЕКУЩЕЙ реализации до добавления namespace.
		// ЭТИ ЛИТЕРАЛЫ НЕЛЬЗЯ МЕНЯТЬ: от них зависит 🆔 каждой уже сохранённой
		// строки-зеркала ICS на дисках пользователей — смена алгоритма-по-умолчанию
		// «перечитала» бы (обесценила) всю историю линковки внешних событий с задачами.
		expect(externalOccurrenceId(legacyA)).toBe("gq38wqkear");
		expect(externalOccurrenceId(legacyB)).toBe("1xx29prqcw");
	});

	it("РЕГРЕССИЯ БАЙТ-СТАБИЛЬНОСТИ: buildMirrorFile без idNamespace/scopeId — байт-в-байт как раньше", () => {
		const text = buildMirrorFile([legacyA, legacyB], { name: "Работа" });
		expect(text).toBe(
			"---\n" +
				"gtd-events: true\n" +
				"gtd-external: true\n" +
				'gtd-external-name: "Работа"\n' +
				"---\n" +
				"%% Зеркало внешнего календаря «Работа». Правки затираются синхронизацией — не редактируйте вручную. %%\n" +
				"\n" +
				"- [ ] Событие 📅 2026-07-06 10:00-10:30 🆔 gq38wqkear\n" +
				"- [ ] Событие 📅 2026-07-13 09:00-09:30 🆔 1xx29prqcw\n",
		);
	});

	it("namespace меняет id: разные namespace → разные id; тот же namespace дважды → тот же id; '' === undefined", () => {
		const withoutNs = externalOccurrenceId(legacyA);
		const nsA = externalOccurrenceId(legacyA, "accA\u0000col1");
		const nsB = externalOccurrenceId(legacyA, "accB\u0000col1");

		expect(nsA).not.toBe(nsB);
		expect(nsA).not.toBe(withoutNs);
		expect(nsB).not.toBe(withoutNs);

		// тот же namespace дважды — идемпотентно
		expect(externalOccurrenceId(legacyA, "accA\u0000col1")).toBe(nsA);

		// пустая строка namespace — legacy-алгоритм (как отсутствие namespace)
		expect(externalOccurrenceId(legacyA, "")).toBe(withoutNs);
	});

	it("один и тот же remote UID в двух коллекциях → разные 🆔 в отрендеренных строках (§4.5)", () => {
		const sameUidOcc = occ({ uid: "shared-remote-uid" });
		const fileA = buildMirrorFile([sameUidOcc], { name: "X", idNamespace: "accA\u0000col1" });
		const fileB = buildMirrorFile([sameUidOcc], { name: "X", idNamespace: "accB\u0000col1" });

		const idOf = (text: string): string => taskLines(text)[0]!.match(/🆔 ([0-9a-z]{10})/)![1]!;
		expect(idOf(fileA)).not.toBe(idOf(fileB));
	});

	it("scopeId сериализуется как «… 🆔 <id> 🧭 <scope>» — 🧭 СТРОГО после 🆔 (переупорядочение переписало бы каждое зеркало)", () => {
		const text = buildMirrorFile([occ()], { name: "X", scopeId: "work" });
		const line = taskLines(text)[0]!;
		expect(line).toMatch(/ 🆔 [0-9a-z]{10} 🧭 work$/);
	});

	it("отсутствующий/null/пустой/пробельный scopeId — 🧭 нигде нет; байт-в-байт как legacy", () => {
		const legacy = buildMirrorFile([occ()], { name: "X" });
		for (const scopeId of [undefined, null, "", "   "]) {
			const text = buildMirrorFile([occ()], { name: "X", scopeId });
			expect(text).not.toContain("🧭");
			expect(text).toBe(legacy);
		}
	});

	it("🆔 и порядок строк не зависят от порядка входа/имени подписки — только от даты/времени/id", () => {
		const a = occ({ uid: "a", date: "2026-07-06", startTime: "08:00" });
		const b = occ({ uid: "b", date: "2026-07-06", startTime: "10:00" });
		const c = occ({ uid: "c", date: "2026-07-08", startTime: "09:00" });

		const forward = buildMirrorFile([a, b, c], { name: "Работа" });
		const shuffledDifferentName = buildMirrorFile([c, a, b], { name: "Личное" });

		const idsOf = (text: string): string[] =>
			taskLines(text).map((l) => l.match(/🆔 ([0-9a-z]{10})/)![1]!);

		expect(idsOf(shuffledDifferentName)).toEqual(idsOf(forward));
	});

	it("buildMirrorFile([]) со scopeId/idNamespace — пустое тело (frontmatter + заголовок + \\n), без токенов scope", () => {
		const text = buildMirrorFile([], {
			name: "X",
			scopeId: "work",
			idNamespace: "accA\u0000col1",
		});
		expect(text).not.toContain("🧭");
		expect(text.endsWith("\n")).toBe(true);
		expect(text).toContain("gtd-events: true");
		expect(text).toContain("Зеркало внешнего календаря");
		expect(taskLines(text)).toEqual([]);
	});
});

describe("gtd-external-source — маркер идентичности caldav-источника (§4.4)", () => {
	// Те же фиксированные вхождения, что и в регрессии байт-стабильности выше.
	const legacyA = occ({ uid: "fixed-uid-A", recurrenceKey: "2026-07-06T10:00:00" });
	const legacyB = occ({
		uid: "fixed-uid-B",
		recurrenceKey: "2026-07-13T09:00:00",
		date: "2026-07-13",
		startTime: "09:00",
		endTime: "09:30",
	});

	it("непустой sourceKey добавляет ОДНУ строку gtd-external-source СРАЗУ ПОСЛЕ gtd-external-id", () => {
		const text = buildMirrorFile([], {
			name: "Работа",
			subscriptionId: "cd-1",
			sourceKey: "abc123",
		});
		const lines = text.split("\n");
		const idIdx = lines.findIndex((l) => l.startsWith("gtd-external-id:"));
		expect(idIdx).toBeGreaterThanOrEqual(0);
		expect(lines[idIdx + 1]).toBe('gtd-external-source: "abc123"');
		// ровно одна строка gtd-external-source во всём файле
		expect(lines.filter((l) => l.startsWith("gtd-external-source:"))).toHaveLength(1);
	});

	it("РЕГРЕССИЯ БАЙТ-СТАБИЛЬНОСТИ: отсутствующий/null/пустой/пробельный sourceKey — байт-в-байт как без него (ICS-зеркала не перечитываются)", () => {
		const legacy = buildMirrorFile([legacyA, legacyB], { name: "Работа" });
		for (const sourceKey of [undefined, null, "", "   "]) {
			const text = buildMirrorFile([legacyA, legacyB], { name: "Работа", sourceKey });
			expect(text).not.toContain("gtd-external-source");
			expect(text).toBe(legacy);
		}
	});

	it("sourceKey экранируется как YAML-строка (кавычки/бэкслеши)", () => {
		const text = buildMirrorFile([], {
			name: "X",
			subscriptionId: "cd-1",
			sourceKey: 'a"b\\c',
		});
		expect(text).toContain('gtd-external-source: "a\\"b\\\\c"');
	});

	it("sourceKey без subscriptionId — не ломает сборку (id-строки нет, source по-прежнему валиден)", () => {
		const text = buildMirrorFile([], { name: "X", sourceKey: "abc123" });
		expect(text).not.toContain("gtd-external-id");
		expect(text).toContain('gtd-external-source: "abc123"');
	});
});
