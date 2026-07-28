/**
 * Golden-строки для resolveLineTransform. Формат полей — Tasks-совместимый:
 * «<эмодзи> <значение>» (см. src/core/parser/emoji.ts). Ассерты — по вхождению
 * токенов, чтобы не фиксировать несущественные детали сериализатора (позицию поля).
 */
import { describe, expect, it } from "vitest";
import type { Intent } from "./Intent";
import { resolveDependsOnTransform, resolveLineTransform } from "./resolveIntent";

describe("resolveLineTransform — однострочные intents", () => {
	it("set-date: добавляет 📅 к строке без даты", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-20" },
			"- [ ] Позвонить маме",
		);
		expect(out).not.toBeNull();
		expect(out).toContain("📅 2026-07-20");
		expect(out).toContain("Позвонить маме");
	});

	it("set-date: заменяет существующую 📅", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-20" },
			"- [ ] Позвонить маме 📅 2026-07-01",
		);
		expect(out).toContain("📅 2026-07-20");
		expect(out).not.toContain("2026-07-01");
	});

	it("set-date: null удаляет поле", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: null },
			"- [ ] Позвонить маме 📅 2026-07-01",
		);
		expect(out).not.toBeNull();
		expect(out).not.toContain("📅");
		expect(out).toContain("Позвонить маме");
	});

	it("set-date: time-строка пишет «📅 дата HH:mm»", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-25", time: "14:30" },
			"- [ ] Врач",
		);
		expect(out).toContain("📅 2026-07-25 14:30");
	});

	it("set-date: time опущен — существующее время сохраняется (drag по дням)", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-26" },
			"- [ ] Врач 📅 2026-07-25 14:30",
		);
		expect(out).toContain("📅 2026-07-26 14:30");
	});

	it("set-date: time = null снимает время, дата остаётся", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-25", time: null },
			"- [ ] Врач 📅 2026-07-25 14:30",
		);
		expect(out).toContain("📅 2026-07-25");
		expect(out).not.toContain("14:30");
	});

	it("set-date: date = null сносит поле вместе со временем", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: null },
			"- [ ] Врач 📅 2026-07-25 14:30",
		);
		expect(out).not.toContain("📅");
		expect(out).not.toContain("14:30");
	});

	it("set-date: time + timeEnd пишут «📅 дата HH:mm-HH:mm»", () => {
		const out = resolveLineTransform(
			{
				type: "set-date",
				key: "k",
				field: "due",
				date: "2026-07-25",
				time: "14:30",
				timeEnd: "16:00",
			},
			"- [ ] Врач",
		);
		expect(out).toContain("📅 2026-07-25 14:30-16:00");
	});

	it("set-date: time и timeEnd опущены — интервал сохраняется (drag по дням)", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-26" },
			"- [ ] Врач 📅 2026-07-25 14:30-16:00",
		);
		expect(out).toContain("📅 2026-07-26 14:30-16:00");
	});

	it("set-date: timeEnd = null снимает конец, время начала остаётся", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-25", timeEnd: null },
			"- [ ] Врач 📅 2026-07-25 14:30-16:00",
		);
		expect(out).toContain("📅 2026-07-25 14:30");
		expect(out).not.toContain("16:00");
	});

	it("set-date: time = null сносит и время, и конец", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-25", time: null },
			"- [ ] Врач 📅 2026-07-25 14:30-16:00",
		);
		expect(out).toContain("📅 2026-07-25");
		expect(out).not.toContain("14:30");
		expect(out).not.toContain("16:00");
	});

	it("set-date: date = null сносит поле вместе с интервалом", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: null },
			"- [ ] Врач 📅 2026-07-25 14:30-16:00",
		);
		expect(out).not.toContain("📅");
		expect(out).not.toContain("14:30");
		expect(out).not.toContain("16:00");
	});

	it("set-text: заменяет описание, поля и ^block-id нетронуты", () => {
		const out = resolveLineTransform(
			{ type: "set-text", key: "k", text: "Новое описание #next" },
			"- [ ] Старое 📅 2026-07-25 14:30 🆔 t1 ^b1",
		);
		expect(out).toBe("- [ ] Новое описание #next 📅 2026-07-25 14:30 🆔 t1 ^b1");
	});

	it("set-text: пустой текст оставляет валидную строку без описания", () => {
		const out = resolveLineTransform(
			{ type: "set-text", key: "k", text: "" },
			"- [ ] Старое 📅 2026-07-25",
		);
		expect(out).toBe("- [ ] 📅 2026-07-25");
	});

	// Регресс из ревью: строка с ВЕДУЩИМ 📍 (токенизатор читает его заголовком
	// описания, не полем). Инлайн-правка с сохранённым ведущим 📍 обязана пройти,
	// а не падать transform-failed — иначе правка молча теряется.
	it("set-text: правка задачи с ведущим 📍 (сохранение 📍) не падает", () => {
		const out = resolveLineTransform(
			{ type: "set-text", key: "k", text: "📍 Погладить собаку" },
			"- [ ] 📍 Погладить кота 📅 2026-07-20",
		);
		expect(out).toBe("- [ ] 📍 Погладить собаку 📅 2026-07-20");
	});

	it("set-text: не ведущий 📍 в новом тексте по-прежнему бросает", () => {
		expect(() =>
			resolveLineTransform(
				{ type: "set-text", key: "k", text: "встреча 📍 кафе" },
				"- [ ] 📍 Погладить кота 📅 2026-07-20",
			),
		).toThrow();
	});

	it("set-status: ' ' → 'x'", () => {
		const out = resolveLineTransform(
			{ type: "set-status", key: "k", statusChar: "x" },
			"- [ ] Позвонить маме",
		);
		expect(out).not.toBeNull();
		expect((out as string).startsWith("- [x]")).toBe(true);
		expect(out).toContain("Позвонить маме");
	});

	it("set-status: с датой пишет ✅", () => {
		const out = resolveLineTransform(
			{ type: "set-status", key: "k", statusChar: "x", date: "2026-07-15" },
			"- [ ] Позвонить маме",
		);
		expect((out as string).startsWith("- [x]")).toBe(true);
		expect(out).toContain("✅ 2026-07-15");
	});

	it("set-status: '-' с датой пишет ❌", () => {
		const out = resolveLineTransform(
			{ type: "set-status", key: "k", statusChar: "-", date: "2026-07-15" },
			"- [ ] Позвонить маме",
		);
		expect((out as string).startsWith("- [-]")).toBe(true);
		expect(out).toContain("❌ 2026-07-15");
	});

	it("set-status: повторное открытие снимает ✅ и ❌", () => {
		const out = resolveLineTransform(
			{ type: "set-status", key: "k", statusChar: " " },
			"- [x] Позвонить маме ✅ 2026-07-10",
		);
		expect((out as string).startsWith("- [ ]")).toBe(true);
		expect(out).not.toContain("✅");
	});

	it("set-priority: добавляет ⏫", () => {
		const out = resolveLineTransform(
			{ type: "set-priority", key: "k", priority: "high" },
			"- [ ] Позвонить маме",
		);
		expect(out).toContain("⏫");
	});

	it("set-location: добавляет 📍 к обычной задаче", () => {
		const out = resolveLineTransform(
			{ type: "set-location", key: "k", location: "Кафе на углу" },
			"- [ ] Созвон с командой",
		);
		expect(out).toBe("- [ ] Созвон с командой 📍 Кафе на углу");
	});

	it("set-location: заменяет существующее место", () => {
		const out = resolveLineTransform(
			{ type: "set-location", key: "k", location: "Офис, 3 этаж" },
			"- [ ] Созвон 📍 Кафе 🆔 e1",
		);
		expect(out).toBe("- [ ] Созвон 📍 Офис, 3 этаж 🆔 e1");
	});

	it("set-location: null снимает поле", () => {
		const out = resolveLineTransform(
			{ type: "set-location", key: "k", location: null },
			"- [ ] Созвон 📍 Кафе 🆔 e1",
		);
		expect(out).toBe("- [ ] Созвон 🆔 e1");
	});

	it("set-location: пустая/пробельная строка = снять поле (как null)", () => {
		expect(
			resolveLineTransform(
				{ type: "set-location", key: "k", location: "   " },
				"- [ ] Созвон 📍 Кафе",
			),
		).toBe("- [ ] Созвон");
		// места не было — снятие тождественно исходной строке (no-op в WritebackService)
		expect(
			resolveLineTransform({ type: "set-location", key: "k", location: "" }, "- [ ] Созвон"),
		).toBe("- [ ] Созвон");
	});

	it("defer: пишет 🛫", () => {
		const out = resolveLineTransform(
			{ type: "defer", key: "k", until: "2026-08-01" },
			"- [ ] Позвонить маме",
		);
		expect(out).toContain("🛫 2026-08-01");
	});

	it("defer + clearDue: 🛫 ставится, 📅 (со временем) снимается одной трансформацией", () => {
		const out = resolveLineTransform(
			{ type: "defer", key: "k", until: "2026-08-01", clearDue: true },
			"- [ ] Позвонить маме 📅 2026-07-20 14:30 #tag",
		);
		expect(out).toContain("🛫 2026-08-01");
		expect(out).not.toContain("📅");
		expect(out).not.toContain("14:30");
		expect(out).toContain("#tag");
	});

	it("defer без clearDue: 📅 не трогаем (конфликт не подтверждён)", () => {
		const out = resolveLineTransform(
			{ type: "defer", key: "k", until: "2026-08-01" },
			"- [ ] Позвонить маме 📅 2026-07-20",
		);
		expect(out).toContain("📅 2026-07-20");
	});

	it("set-date due + clearStart: 📅 ставится, 🛫 снимается одной трансформацией", () => {
		const out = resolveLineTransform(
			{ type: "set-date", key: "k", field: "due", date: "2026-07-20", clearStart: true },
			"- [ ] Позвонить маме 🛫 2026-09-01",
		);
		expect(out).toContain("📅 2026-07-20");
		expect(out).not.toContain("🛫");
	});

	it("set-date scheduled + clearStart: флаг игнорируется (политика только для 📅)", () => {
		const out = resolveLineTransform(
			{
				type: "set-date",
				key: "k",
				field: "scheduled",
				date: "2026-07-20",
				clearStart: true,
			},
			"- [ ] Позвонить маме 🛫 2026-09-01",
		);
		expect(out).toContain("🛫 2026-09-01");
	});

	it("set-id: пишет 🆔", () => {
		const out = resolveLineTransform(
			{ type: "set-id", key: "k", taskId: "abc123" },
			"- [ ] Позвонить маме",
		);
		expect(out).toContain("🆔 abc123");
	});

	it("advance-cursor: сдвигает 🔜 на строке шаблона", () => {
		const out = resolveLineTransform(
			{ type: "advance-cursor", templateId: "rev-prio", date: "2026-08-31" },
			"- [ ] Ревью приоритетов 🔁 every month on the last day 🆔 rev-prio 🔜 2026-07-31",
		);
		expect(out).toContain("🔜 2026-08-31");
		expect(out).not.toContain("2026-07-31");
		expect(out).toContain("🔁 every month on the last day");
	});

	it("move-column: снимает старый тег колонки, добавляет новый", () => {
		const out = resolveLineTransform(
			{
				type: "move-column",
				key: "k",
				fromTag: "#kanban/work/todo",
				toTag: "#kanban/work/doing",
			},
			"- [ ] Задача #kanban/work/todo",
		);
		expect(out).toContain("#kanban/work/doing");
		expect(out).not.toContain("#kanban/work/todo");
	});

	it("move-column: статус карточки НЕ трогается (раунд 3 — развязка со статусом)", () => {
		// перенос выполненной карточки меняет только теги, чекбокс остаётся [x]
		const out = resolveLineTransform(
			{
				type: "move-column",
				key: "k",
				fromTag: "#kanban/work/todo",
				toTag: "#kanban/work/doing",
			},
			"- [x] Починить баг #kanban/work/todo 🆔 t1 ✅ 2026-07-10",
		);
		expect((out as string).startsWith("- [x]")).toBe(true);
		expect(out).toContain("✅ 2026-07-10"); // дата выполнения не снимается
		expect(out).toContain("#kanban/work/doing");
		expect(out).not.toContain("#kanban/work/todo");
	});

	it("move-column: fromTags снимает несколько тегов колонок разом (архив)", () => {
		const out = resolveLineTransform(
			{
				type: "move-column",
				key: "k",
				fromTag: null,
				toTag: null,
				fromTags: ["#kanban/work/done", "#kanban/home/todo"],
			},
			"- [x] Готово #kanban/work/done #kanban/home/todo 🆔 t1 ✅ 2026-07-10",
		);
		expect(out).not.toContain("#kanban/work/done");
		expect(out).not.toContain("#kanban/home/todo");
		expect((out as string).startsWith("- [x]")).toBe(true); // статус нетронут
	});
});

describe("resolveLineTransform — многострочные/многофайловые intents ⇒ null", () => {
	const cases: Intent[] = [
		{ type: "reorder", boardPath: "GTD/Board.md", column: "todo", orderedKeys: [] },
		{ type: "spawn-instances", file: "GTD/Inbox.md", lines: ["- [ ] копия"] },
		{ type: "delete-line", key: "k" },
		{
			type: "add-node",
			projectPath: "Projects/Кухня.md",
			line: "- [ ] Новая 🆔 n1",
			taskId: "n1",
			position: { x: 0, y: 0 },
		},
		{ type: "connect-edge", projectPath: "Projects/Кухня.md", sourceId: "a", targetId: "b" },
		{ type: "disconnect-edge", projectPath: "Projects/Кухня.md", sourceId: "a", targetId: "b" },
		{ type: "delete-node", projectPath: "Projects/Кухня.md", taskId: "a" },
		{ type: "move-node", projectPath: "Projects/Кухня.md", positions: { a: { x: 1, y: 2 } } },
		{ type: "set-project-status", projectPath: "Projects/Кухня.md", status: "on-hold" },
		{ type: "move-line", key: "k", toFile: "Projects/Кухня.md" },
	];

	for (const intent of cases) {
		it(`${intent.type} ⇒ null`, () => {
			expect(resolveLineTransform(intent, "- [ ] Задача")).toBeNull();
		});
	}
});

describe("resolveDependsOnTransform", () => {
	it("применяет посчитанный сервисом список ⛔ (через запятую, без пробелов)", () => {
		const out = resolveDependsOnTransform("- [ ] Заказать материалы ⛔ a1", ["a1", "b2"]);
		expect(out).toContain("⛔ a1,b2");
	});

	it("пустой список снимает ⛔", () => {
		const out = resolveDependsOnTransform("- [ ] Заказать материалы ⛔ a1", []);
		expect(out).not.toContain("⛔");
		expect(out).toContain("Заказать материалы");
	});
});
