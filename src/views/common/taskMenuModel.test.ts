import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import type { DeferPreset } from "../../settings/Settings";
import { makeTask } from "../../stores/testSupport";
import {
	buildMenuModel,
	flattenSubmenu,
	isSubmenuNode,
	type MenuItemModel,
	type MenuModelInput,
	type MenuNode,
	type MenuSubmenuModel,
} from "./taskMenuModel";

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
		inBoard: false,
		hasBoards: false,
		hasProjects: false,
		hasCards: false,
		hasTemplates: false,
		...over,
	};
}

/** Листовые пункты в порядке обхода: верхний уровень + дети подменю. */
function leaves(nodes: MenuNode[]): MenuItemModel[] {
	const out: MenuItemModel[] = [];
	for (const n of nodes) {
		if (isSubmenuNode(n)) out.push(...n.children);
		else out.push(n);
	}
	return out;
}

function ids(nodes: MenuNode[]): string[] {
	return leaves(nodes).map((i) => i.id);
}

function byId(nodes: MenuNode[], id: string): MenuItemModel {
	const found = leaves(nodes).find((i) => i.id === id);
	expect(found, `пункт ${id} должен существовать`).toBeDefined();
	return found!;
}

function submenuById(nodes: MenuNode[], id: string): MenuSubmenuModel {
	const found = nodes.find((n) => isSubmenuNode(n) && n.id === id);
	expect(found, `подменю ${id} должно существовать`).toBeDefined();
	return found as MenuSubmenuModel;
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

	it("«Вернуть во входящие» — верхний уровень, НЕ внутри подменю «Отложить…»", () => {
		const task = makeTask({ filePath: "GTD/Inbox.md", start: "2026-08-01" });
		const items = buildMenuModel(input({ task, inTickler: true }));
		expect(items.some((n) => !isSubmenuNode(n) && n.id === "defer-return")).toBe(true);
		expect(submenuById(items, "defer").children.map((c) => c.id)).not.toContain("defer-return");
	});

	it("вне тикля пункта нет", () => {
		expect(ids(buildMenuModel(input()))).not.toContain("defer-return");
	});
});

describe("buildMenuModel: ветка inBoard (архив)", () => {
	it("на доске для выполненной есть «Архивировать» с action archive", () => {
		const task = makeTask({ filePath: "b.md", statusChar: "x" });
		const items = buildMenuModel(input({ task, inBoard: true }));
		const archive = byId(items, "archive");
		expect(archive.section).toBe("move");
		expect(archive.action).toEqual({ kind: "archive" });
	});

	it("на доске для отменённой (-) тоже есть «Архивировать»", () => {
		const task = makeTask({ filePath: "b.md", statusChar: "-" });
		expect(ids(buildMenuModel(input({ task, inBoard: true })))).toContain("archive");
	});

	it("на доске для активной/в работе карточки пункта нет", () => {
		for (const statusChar of [" ", "/"]) {
			const task = makeTask({ filePath: "b.md", statusChar });
			expect(ids(buildMenuModel(input({ task, inBoard: true })))).not.toContain("archive");
		}
	});

	it("вне доски (inBoard: false) пункта нет даже для выполненной", () => {
		const task = makeTask({ filePath: "b.md", statusChar: "x" });
		expect(ids(buildMenuModel(input({ task, inBoard: false })))).not.toContain("archive");
	});
});

describe("buildMenuModel: статусные переключатели", () => {
	it("статусные пункты НЕ группируются в подменю (верхний уровень)", () => {
		const items = buildMenuModel(input());
		const topIds = items.filter((n) => !isSubmenuNode(n)).map((n) => (n as MenuItemModel).id);
		expect(topIds).toContain("status-done");
		expect(topIds).toContain("status-cancel");
	});

	it("«В работу»/«Вернуть в очередь» убраны из меню (статус — чекбоксом)", () => {
		// ни для одного статуса не всплывают пункты рабочего перехода '/'
		for (const statusChar of [" ", "/", "x", "-"]) {
			const task = makeTask({ filePath: "a.md", statusChar });
			const got = ids(buildMenuModel(input({ task })));
			expect(got).not.toContain("status-doing");
			expect(got).not.toContain("status-pause");
		}
	});

	it("открытая задача: выполнено (с датой) и отменить (с датой), без «в работу»", () => {
		const task = makeTask({ filePath: "a.md", statusChar: " " });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "status-done").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: "x", date: TODAY },
		});
		expect(byId(items, "status-cancel").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: "-", date: TODAY },
		});
		expect(ids(items)).not.toContain("status-reopen");
		expect(ids(items)).not.toContain("status-doing");
	});

	it("выполненная: «Выполнено» и «Открыть заново» отсутствуют (снятие — чекбоксом)", () => {
		const task = makeTask({ filePath: "a.md", statusChar: "x" });
		const got = ids(buildMenuModel(input({ task })));
		expect(got).not.toContain("status-done");
		expect(got).not.toContain("status-reopen");
		// «Отменить» доступна и для выполненной — статус-секция не пустеет
		expect(got).toContain("status-cancel");
	});

	it("в работе '/': трактуется как обычная невыполненная — «Выполнено» + «Отменить»", () => {
		const task = makeTask({ filePath: "a.md", statusChar: "/" });
		const got = ids(buildMenuModel(input({ task })));
		expect(got).toContain("status-done");
		expect(got).toContain("status-cancel");
		expect(got).not.toContain("status-doing");
		expect(got).not.toContain("status-pause");
	});

	it("отменённая '-': «Вернуть из отменённых» вместо «Отменить»", () => {
		const task = makeTask({ filePath: "a.md", statusChar: "-" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "status-uncancel").action).toEqual({
			kind: "intent",
			intent: { type: "set-status", key: task.key, statusChar: " " },
		});
		expect(ids(items)).not.toContain("status-cancel");
		// отменённая не выполнена — «Выполнено» доступно
		expect(ids(items)).toContain("status-done");
	});
});

describe("buildMenuModel: подменю «Приоритет…»", () => {
	it("подменю с 6 уровнями, заголовок и секция priority", () => {
		const sub = submenuById(buildMenuModel(input()), "priority");
		expect(sub.label).toBe("Приоритет…");
		expect(sub.section).toBe("priority");
		expect(sub.children.map((c) => c.id)).toEqual([
			"priority-highest",
			"priority-high",
			"priority-medium",
			"priority-low",
			"priority-lowest",
			"priority-none",
		]);
	});

	it("checked стоит на текущем приоритете внутри детей", () => {
		const task = makeTask({ filePath: "a.md", priority: "high" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "priority-high").checked).toBe(true);
		expect(byId(items, "priority-none").checked).toBe(false);
		expect(byId(items, "priority-lowest").checked).toBe(false);
	});

	it("титулы детей без префикса «Приоритет: » (он появляется при сплющивании)", () => {
		const sub = submenuById(buildMenuModel(input()), "priority");
		for (const c of sub.children) expect(c.title.startsWith("Приоритет")).toBe(false);
	});

	it("дети несут set-priority интенты", () => {
		const task = makeTask({ filePath: "a.md" });
		const items = buildMenuModel(input({ task }));
		expect(byId(items, "priority-high").action).toEqual({
			kind: "intent",
			intent: { type: "set-priority", key: task.key, priority: "high" },
		});
	});
});

describe("buildMenuModel: подменю «Отложить…» и «Запланировать…»", () => {
	it("подменю: пресеты + «Дата…» последним ребёнком", () => {
		const sub = submenuById(buildMenuModel(input()), "defer");
		expect(sub.label).toBe("Отложить…");
		expect(sub.children.map((c) => c.id)).toEqual([
			"defer-preset-0",
			"defer-preset-1",
			"defer-date",
		]);
		expect(sub.children[sub.children.length - 1]!.title).toBe("Дата…");
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

	it("«Запланировать…» — верхнеуровневый интерактивный маркер, «Дата…» — pick-defer", () => {
		const items = buildMenuModel(input());
		expect(items.some((n) => !isSubmenuNode(n) && n.id === "schedule-due")).toBe(true);
		expect(byId(items, "schedule-due").action).toEqual({ kind: "pick-due" });
		expect(byId(items, "defer-date").action).toEqual({ kind: "pick-defer" });
	});

	it("«Запланировать (⏳)…» — верхнеуровневый маркер pick-scheduled рядом с due", () => {
		const items = buildMenuModel(input());
		const scheduled = byId(items, "schedule-scheduled");
		expect(scheduled.section).toBe("schedule");
		expect(scheduled.title).toBe("Запланировать (⏳)…");
		expect(scheduled.action).toEqual({ kind: "pick-scheduled" });
		// верхний уровень (не внутри подменю) и в секции schedule рядом с due
		expect(items.some((n) => !isSubmenuNode(n) && n.id === "schedule-scheduled")).toBe(true);
		const leafIds = ids(items);
		expect(leafIds.indexOf("schedule-scheduled")).toBe(leafIds.indexOf("schedule-due") + 1);
	});
});

describe("flattenSubmenu: плоский фолбэк (мобайл / obsidian < 1.12)", () => {
	it("приоритет: «Приоритет: ⏫ высокий» — как в плоском меню до подменю", () => {
		const task = makeTask({ filePath: "a.md", priority: "high" });
		const flat = flattenSubmenu(submenuById(buildMenuModel(input({ task })), "priority"));
		const high = flat.find((i) => i.id === "priority-high")!;
		expect(high.title).toBe("Приоритет: ⏫ высокий");
		expect(high.checked).toBe(true); // checked/action/id сохраняются
		expect(high.action).toEqual({
			kind: "intent",
			intent: { type: "set-priority", key: task.key, priority: "high" },
		});
	});

	it("отложить: «Отложить: Завтра» и «Отложить: Дата…»", () => {
		const flat = flattenSubmenu(submenuById(buildMenuModel(input()), "defer"));
		expect(flat.map((i) => i.title)).toEqual([
			"Отложить: Завтра",
			"Отложить: Через неделю",
			"Отложить: Дата…",
		]);
	});
});

describe("buildMenuModel: инварианты", () => {
	it("id пунктов (включая узлы подменю и детей) уникальны", () => {
		const nodes = buildMenuModel(
			input({
				hasBoards: true,
				hasProjects: true,
				hasCards: true,
				hasTemplates: true,
				inTickler: true,
			}),
		);
		// все id один раз: узлы верхнего уровня + дети подменю, без пересечений
		const all = nodes.flatMap((n) =>
			isSubmenuNode(n) ? [n.id, ...n.children.map((c) => c.id)] : [n.id],
		);
		expect(new Set(all).size).toBe(all.length);
	});

	it("порядок секций стабилен: status → priority → schedule → defer → move → card → nav", () => {
		// done + inBoard: в наборе присутствует и «Архивировать» (секция move)
		const nodes = buildMenuModel(
			input({
				task: makeTask({ filePath: "b.md", statusChar: "x" }),
				hasBoards: true,
				hasProjects: true,
				hasCards: true,
				hasTemplates: true,
				inBoard: true,
			}),
		);
		expect(ids(nodes)).toContain("archive");
		const order = ["status", "priority", "schedule", "defer", "move", "card", "nav"];
		const seen = nodes.map((n) => order.indexOf(n.section));
		for (let i = 1; i < seen.length; i++) expect(seen[i]! >= seen[i - 1]!).toBe(true);
	});
});
