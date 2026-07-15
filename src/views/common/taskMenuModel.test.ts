import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import type { DeferPreset } from "../../settings/Settings";
import { makeTask } from "../../stores/testSupport";
import { buildMenuModel, type MenuItemModel, type MenuModelInput } from "./taskMenuModel";

const TODAY = "2026-07-15";

const PRESETS: DeferPreset[] = [
	{ label: "Завтра", offsetDays: 1 },
	{ label: "Через неделю", offsetDays: 7 },
];

function input(over: Partial<MenuModelInput> & { task?: Task } = {}): MenuModelInput {
	return {
		task: over.task ?? makeTask({ filePath: "GTD/Inbox.md" }),
		today: TODAY,
		deferPresets: PRESETS,
		inTickler: false,
		hasBoards: false,
		hasProjects: false,
		hasCards: false,
		hasTemplates: false,
		...over,
	};
}

function ids(items: MenuItemModel[]): string[] {
	return items.map((i) => i.id);
}

function byId(items: MenuItemModel[], id: string): MenuItemModel {
	const found = items.find((i) => i.id === id);
	expect(found, `пункт ${id} должен существовать`).toBeDefined();
	return found!;
}

describe("buildMenuModel: секции от портов", () => {
	it("без портов: нет колонок/проектов/шаблонов/карточки, база на месте", () => {
		const items = buildMenuModel(input());
		const got = ids(items);
		expect(got).not.toContain("move-column");
		expect(got).not.toContain("move-project");
		expect(got).not.toContain("move-template");
		expect(got).not.toContain("card-open");
		// база паритета: статус, приоритет, запланировать, отложить, файл
		expect(got).toContain("status-done");
		expect(got).toContain("priority-high");
		expect(got).toContain("schedule-due");
		expect(got).toContain("defer-date");
		expect(got).toContain("open-file");
	});

	it("все порты: полный набор перемещений и карточка", () => {
		const items = buildMenuModel(
			input({ hasBoards: true, hasProjects: true, hasCards: true, hasTemplates: true }),
		);
		const got = ids(items);
		expect(got).toContain("move-column");
		expect(got).toContain("move-project");
		expect(got).toContain("move-template");
		expect(got).toContain("card-open");
		expect(byId(items, "move-column").action).toEqual({ kind: "pick-column" });
		expect(byId(items, "move-project").action).toEqual({ kind: "pick-project" });
		expect(byId(items, "move-template").action).toEqual({ kind: "make-template" });
		expect(byId(items, "card-open").action).toEqual({ kind: "open-card" });
	});

	it("частичные порты: только доски", () => {
		const got = ids(buildMenuModel(input({ hasBoards: true })));
		expect(got).toContain("move-column");
		expect(got).not.toContain("move-project");
		expect(got).not.toContain("move-template");
	});
});

describe("buildMenuModel: ветка inTickler", () => {
	it("в тикле есть «Вернуть во входящие» — снять 🛫", () => {
		const task = makeTask({ filePath: "GTD/Inbox.md", start: "2026-08-01" });
		const items = buildMenuModel(input({ task, inTickler: true }));
		const ret = byId(items, "defer-return");
		expect(ret.section).toBe("defer");
		expect(ret.action).toEqual({
			kind: "intent",
			intent: { type: "set-date", key: task.key, field: "start", date: null },
		});
	});

	it("вне тикля пункта нет", () => {
		expect(ids(buildMenuModel(input()))).not.toContain("defer-return");
	});
});

describe("buildMenuModel: статусные переключатели", () => {
	it("открытая задача: выполнено (с датой), в работу, отменить (с датой)", () => {
		const task = makeTask({ filePath: "a.md", statusChar: " " });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "status-done").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: "x", date: TODAY },
		});
		expect(byId(items, "status-doing").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: "/" },
		});
		expect(byId(items, "status-cancel").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: "-", date: TODAY },
		});
		expect(ids(items)).not.toContain("status-reopen");
	});

	it("выполненная: «Открыть заново» вместо «Выполнено»", () => {
		const task = makeTask({ filePath: "a.md", statusChar: "x" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "status-reopen").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: " " },
		});
		expect(ids(items)).not.toContain("status-done");
	});

	it("в работе '/': «Вернуть в очередь»", () => {
		const task = makeTask({ filePath: "a.md", statusChar: "/" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "status-pause").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: " " },
		});
		expect(ids(items)).not.toContain("status-doing");
	});

	it("отменённая '-': «Вернуть из отменённых»", () => {
		const task = makeTask({ filePath: "a.md", statusChar: "-" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "status-uncancel").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: " " },
		});
		expect(ids(items)).not.toContain("status-cancel");
	});
});

describe("buildMenuModel: приоритет и отложить", () => {
	it("checked стоит на текущем приоритете", () => {
		const task = makeTask({ filePath: "a.md", priority: "high" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "priority-high").checked).toBe(true);
		expect(byId(items, "priority-none").checked).toBe(false);
		expect(byId(items, "priority-lowest").checked).toBe(false);
	});

	it("пресеты отложки разворачиваются в абсолютные даты от today", () => {
		const task = makeTask({ filePath: "a.md" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "defer-preset-0").action).toEqual({
			kind: "intent",
			intent: { type: "defer", key: task.key, until: "2026-07-16" },
		});
		expect(byId(items, "defer-preset-1").action).toEqual({
			kind: "intent",
			intent: { type: "defer", key: task.key, until: "2026-07-22" },
		});
	});

	it("«Запланировать…» и «Отложить: дата…» — интерактивные маркеры", () => {
		const items = buildMenuModel(input());
		expect(byId(items, "schedule-due").action).toEqual({ kind: "pick-due" });
		expect(byId(items, "defer-date").action).toEqual({ kind: "pick-defer" });
	});
});

describe("buildMenuModel: инварианты", () => {
	it("id пунктов уникальны", () => {
		const items = buildMenuModel(
			input({ hasBoards: true, hasProjects: true, hasCards: true, hasTemplates: true, inTickler: true }),
		);
		const got = ids(items);
		expect(new Set(got).size).toBe(got.length);
	});

	it("порядок секций стабилен: status → priority → schedule → defer → move → card → nav", () => {
		const items = buildMenuModel(
			input({ hasBoards: true, hasProjects: true, hasCards: true, hasTemplates: true }),
		);
		const order = ["status", "priority", "schedule", "defer", "move", "card", "nav"];
		const seen = items.map((i) => order.indexOf(i.section));
		for (let i = 1; i < seen.length; i++) expect(seen[i]! >= seen[i - 1]!).toBe(true);
	});
});
