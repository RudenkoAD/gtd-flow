import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_READONLY_REASON } from "../services/WritebackService";
import { loadSettings } from "./config";
import { FsVault } from "./fsVault";
import {
	addEvent,
	addTask,
	deleteTask,
	gtdOverview,
	listBoards,
	listEvents,
	listTasks,
	moveCard,
	updateTask,
} from "./handlers";
import { openSession, type GtdSession } from "./session";
import { FIXTURE_FILES, FIXTURE_TODAY, makeVault, readVaultFile, removeVault } from "./testVault";

/** Открыть сессию на текущем состоянии vault'а (свежий скан). */
async function session(root: string, genId?: () => string): Promise<GtdSession> {
	const vault = new FsVault(root);
	const settings = await loadSettings(root);
	return openSession({ vault, settings, today: FIXTURE_TODAY, genId });
}

describe("MCP handlers", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeVault(FIXTURE_FILES);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	// --- gtd_overview ---

	it("gtd_overview: пространства и счётчики", async () => {
		const s = await session(root);
		const ov = gtdOverview(s) as any;
		expect(ov.activeNamespace).toBe("Жизнь");
		const spaceNames = ov.spaces.map((x: any) => x.name).sort();
		expect(spaceNames).toEqual(["Жизнь", "Общее", "Работа"]);
		const zhizn = ov.spaces.find((x: any) => x.name === "Жизнь");
		expect(zhizn.root).toBe("Жизнь");
		expect(zhizn.projects).toBe(1);
		expect(zhizn.events).toBe(2); // серия «Йога» + одноразовый «День рождения»
		expect(zhizn.tickler).toBe(1); // «Записаться к врачу» 🛫 в будущем
		const rabota = ov.spaces.find((x: any) => x.name === "Работа");
		expect(rabota.boards).toBe(1);
	});

	// --- list_tasks ---

	it("list_tasks inbox: активное пространство по умолчанию (Жизнь)", async () => {
		const s = await session(root);
		const res = listTasks(s, { view: "inbox" }) as any;
		expect(res.namespace).toBe("Жизнь");
		const descs = res.tasks.map((t: any) => t.description);
		expect(descs).toContain("Позвонить маме");
		expect(descs).not.toContain("Записаться к врачу"); // это отложенная (tickler)
	});

	it("list_tasks inbox: Общее (задача с 📅 не во входящих)", async () => {
		const s = await session(root);
		const res = listTasks(s, { namespace: "Общее", view: "inbox" }) as any;
		const descs = res.tasks.map((t: any) => t.description).sort();
		expect(descs).toEqual(["Задача с айди", "Общая задача без даты"]);
		// id задачи с 🆔 возвращается как сам 🆔
		const withId = res.tasks.find((t: any) => t.description === "Задача с айди");
		expect(withId.id).toBe("aaa111");
	});

	it("list_tasks board: карточки по колонкам", async () => {
		const s = await session(root);
		const res = listTasks(s, { namespace: "Работа", view: "board", board: "Спринт" }) as any;
		// описание карточки сохраняет #kanban-тег (парсер держит теги в тексте) — матчим по префиксу
		const cardA = res.tasks.find((t: any) => t.description.startsWith("Задача A"));
		const cardB = res.tasks.find((t: any) => t.description.startsWith("Задача B"));
		expect(cardA.column).toBe("Очередь");
		expect(cardB.column).toBe("В работе");
	});

	it("list_tasks project: члены проекта, include_done", async () => {
		const s = await session(root);
		const open = listTasks(s, {
			namespace: "Жизнь",
			view: "project",
			project: "Ремонт кухни",
		}) as any;
		expect(open.tasks.map((t: any) => t.description)).toEqual(["Выбрать плитку"]);
		const withDone = listTasks(s, {
			namespace: "Жизнь",
			view: "project",
			project: "Ремонт кухни",
			include_done: true,
		}) as any;
		expect(withDone.tasks.map((t: any) => t.description).sort()).toEqual([
			"Выбрать плитку",
			"Замерить стены",
		]);
	});

	it("list_tasks: неизвестное пространство → внятная ошибка", async () => {
		const s = await session(root);
		expect(() => listTasks(s, { namespace: "Нет" })).toThrow(/unknown namespace/);
	});

	// --- add_task ---

	it("add_task: создаёт файл входящих пространства и дописывает задачу", async () => {
		const s = await session(root);
		const res = (await addTask(s, {
			text: "Новая рабочая задача",
			namespace: "Работа",
			due: "2026-07-30 09:15",
		})) as any;
		expect(res.ok).toBe(true);
		expect(res.file).toBe("Работа/Входящие.md");
		const content = await readVaultFile(root, "Работа/Входящие.md");
		expect(content).toContain("gtd-inbox: true");
		expect(content).toContain("- [ ] Новая рабочая задача 📅 2026-07-30 09:15");

		// свежая сессия видит задачу в пространстве Работа (во «Входящие» она не
		// попадает — у неё есть 📅, а задача с датой считается уже разобранной)
		const s2 = await session(root);
		const list = listTasks(s2, { namespace: "Работа", view: "all" }) as any;
		expect(list.tasks.map((t: any) => t.description)).toContain("Новая рабочая задача");
	});

	it("add_task: без даты попадает во входящие пространства", async () => {
		const s = await session(root);
		await addTask(s, { text: "Прочитать почту", namespace: "Работа" });
		const s2 = await session(root);
		const list = listTasks(s2, { namespace: "Работа", view: "inbox" }) as any;
		expect(list.tasks.map((t: any) => t.description)).toContain("Прочитать почту");
	});

	it("add_task: пустой текст → ошибка", async () => {
		const s = await session(root);
		await expect(addTask(s, { text: "   " })).rejects.toThrow(/empty task text/);
	});

	// --- update_task ---

	it("update_task: пометить done по 🆔 (✅ сегодня)", async () => {
		const s = await session(root);
		const res = (await updateTask(s, { id: "aaa111", done: true })) as any;
		expect(res.ok).toBe(true);
		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toMatch(/- \[x\] Задача с айди 🆔 aaa111 ✅ 2026-07-19/);
	});

	it("update_task: правка текста, даты и приоритета по content-key", async () => {
		const s = await session(root);
		// найдём content-key задачи без 🆔
		const inbox = listTasks(s, { namespace: "Общее", view: "inbox" }) as any;
		const target = inbox.tasks.find((t: any) => t.description === "Общая задача без даты");
		const key = target.id as string;
		expect(key).toContain("#"); // content-key

		const res = (await updateTask(s, {
			id: key,
			text: "Разобранная задача",
			scheduled: "2026-07-22",
			priority: "high",
		})) as any;
		expect(res.ok).toBe(true);
		expect(res.failed).toHaveLength(0);
		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("Разобранная задача");
		expect(content).toContain("⏳ 2026-07-22");
		expect(content).toContain("⏫"); // high priority emoji
	});

	it("update_task: снятие даты (null)", async () => {
		const s = await session(root);
		// «Купить молоко» 📅 2026-07-20 — снимаем due
		const list = listTasks(s, { namespace: "Общее", view: "all", include_done: true }) as any;
		const milk = list.tasks.find((t: any) => t.description === "Купить молоко");
		const res = (await updateTask(s, { id: milk.id, due: null })) as any;
		expect(res.ok).toBe(true);
		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("- [ ] Купить молоко");
		expect(content).not.toContain("📅 2026-07-20");
	});

	it("update_task: неизвестный id → ошибка", async () => {
		const s = await session(root);
		await expect(updateTask(s, { id: "zzz999", done: true })).rejects.toThrow(/no task found/);
	});

	it("update_task: комбинированная правка id-less при autoInjectId:false — всё применено атомарно", async () => {
		// сценарий ревью: text меняет content-key; раньше без якоря 🆔 scheduled+
		// priority падали line-not-found (частичное применение). Теперь весь пакет
		// применяется ОДНОЙ записью (dispatchMany): content-key меняется только
		// после неё, поэтому принудительный якорь-🆔 больше не нужен вовсе —
		// autoInjectId:false честно оставляет строку без 🆔.
		const noAutoRoot = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": JSON.stringify({
				commonRoot: "GTD",
				eventsFile: "GTD/Events.md",
				autoInjectId: false,
				namespaces: [],
				activeNamespace: "Общее",
			}),
			"GTD/Inbox.md": `---\ngtd-inbox: true\n---\n- [ ] Разобрать бумаги\n`,
		});
		try {
			const s = await session(noAutoRoot);
			const inbox = listTasks(s, { namespace: "Общее", view: "inbox" }) as any;
			const target = inbox.tasks.find((t: any) => t.description === "Разобрать бумаги");
			const key = target.id as string;
			expect(key).toContain("#"); // content-key: задача без 🆔

			const res = (await updateTask(s, {
				id: key,
				text: "Разобрать бумаги в архив",
				scheduled: "2026-07-25",
				priority: "high",
			})) as any;
			expect(res.ok).toBe(true);
			expect(res.failed).toHaveLength(0);
			expect(res.applied).toEqual(expect.arrayContaining(["text", "scheduled", "priority"]));

			const content = await readVaultFile(noAutoRoot, "GTD/Inbox.md");
			expect(content).toContain("Разобрать бумаги в архив");
			expect(content).toContain("⏳ 2026-07-25");
			expect(content).toContain("⏫"); // high
			expect(content).not.toContain("🆔"); // атомарной записи якорь не нужен
		} finally {
			await removeVault(noAutoRoot);
		}
	});

	it("update_task: мультиполе применяется ОДНОЙ записью файла (атомарность)", async () => {
		const s = await session(root);
		// счётчик фактических записей через обёртку processFile
		let writes = 0;
		const origProcessFile = s.vault.processFile.bind(s.vault);
		s.vault.processFile = async (path: string, tf: (c: string) => string | null) => {
			let wrote = false;
			const ok = await origProcessFile(path, (c) => {
				const next = tf(c);
				if (next !== null && next !== c) wrote = true;
				return next;
			});
			if (wrote) writes++;
			return ok;
		};

		const res = (await updateTask(s, {
			id: "aaa111",
			text: "Задача с айди и датой",
			due: "2026-07-30",
			location: "Офис",
		})) as any;
		expect(res.ok).toBe(true);
		expect(res.applied).toEqual(["text", "due", "location"]);
		expect(writes).toBe(1); // все три поля — одна запись

		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("Задача с айди и датой");
		expect(content).toContain("📅 2026-07-30");
		expect(content).toContain("📍 Офис");
	});

	it("update_task: сбой одной операции — файл не тронут, все ops failed (всё-или-ничего)", async () => {
		const s = await session(root);
		const before = await readVaultFile(root, "GTD/Inbox.md");

		// локация с эмодзи поля — setValueField бросит на этапе трансформа
		const res = (await updateTask(s, {
			id: "aaa111",
			text: "Не должно примениться",
			location: "📅 мусор",
		})) as any;
		expect(res.ok).toBe(false);
		expect(res.applied).toEqual([]);
		expect(res.failed.map((f: any) => f.op).sort()).toEqual(["location", "text"]);
		const locFail = res.failed.find((f: any) => f.op === "location");
		expect(locFail.reason).toBe("transform-failed"); // виновник — исходная причина
		const textFail = res.failed.find((f: any) => f.op === "text");
		expect(textFail.reason).toMatch(/atomic batch aborted by 'location'/);

		const after = await readVaultFile(root, "GTD/Inbox.md");
		expect(after).toBe(before); // ноль записей
	});

	it("update_task: location задаёт 📍 через интент ядра", async () => {
		const s = await session(root);
		const res = (await updateTask(s, { id: "aaa111", location: "Дом" })) as any;
		expect(res.ok).toBe(true);
		expect(res.applied).toEqual(["location"]);
		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("- [ ] Задача с айди 🆔 aaa111 📍 Дом");
	});

	it("update_task: location null и пустая строка снимают 📍", async () => {
		const s = await session(root);
		await updateTask(s, { id: "aaa111", location: "Дом" });

		// null снимает поле
		let s2 = await session(root);
		let res = (await updateTask(s2, { id: "aaa111", location: null })) as any;
		expect(res.ok).toBe(true);
		expect(res.applied).toEqual(["location:clear"]);
		let content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("- [ ] Задача с айди 🆔 aaa111");
		expect(content).not.toContain("📍");

		// пустая/пробельная строка эквивалентна null
		await updateTask(await session(root), { id: "aaa111", location: "Офис" });
		s2 = await session(root);
		res = (await updateTask(s2, { id: "aaa111", location: "   " })) as any;
		expect(res.ok).toBe(true);
		expect(res.applied).toEqual(["location:clear"]);
		content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).not.toContain("📍");
	});

	it("update_task: location в комбинированной правке id-less задачи (autoInjectId по умолчанию)", async () => {
		const s = await session(root);
		const inbox = listTasks(s, { namespace: "Общее", view: "inbox" }) as any;
		const target = inbox.tasks.find((t: any) => t.description === "Общая задача без даты");
		const res = (await updateTask(s, {
			id: target.id,
			text: "Задача с местом",
			location: "Кафе на углу",
		})) as any;
		expect(res.ok).toBe(true);
		expect(res.failed).toHaveLength(0);
		expect(res.applied).toEqual(expect.arrayContaining(["text", "location"]));
		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("Задача с местом");
		expect(content).toContain("📍 Кафе на углу");
	});

	// --- delete_task ---

	it("delete_task: удаляет строку задачи", async () => {
		const s = await session(root);
		const res = (await deleteTask(s, { id: "proj01" })) as any;
		expect(res.ok).toBe(true);
		const content = await readVaultFile(root, "Жизнь/Проекты/Ремонт.md");
		expect(content).not.toContain("Выбрать плитку");
		expect(content).toContain("Замерить стены"); // соседняя цела
	});

	// --- move_card ---

	it("move_card: переносит карточку в другую колонку", async () => {
		const s = await session(root);
		const res = (await moveCard(s, { board: "Спринт", id: "card01", column: "Готово" })) as any;
		expect(res.ok).toBe(true);
		const content = await readVaultFile(root, "Работа/Доски/Спринт.md");
		expect(content).toContain("#kanban/sprint/done");
		expect(content).not.toMatch(/Задача A[^\n]*#kanban\/sprint\/todo/);

		const s2 = await session(root);
		const boards = listBoards(s2, { namespace: "Работа" }) as any;
		const sprint = boards.boards.find((b: any) => b.id === "sprint");
		const done = sprint.columns.find((c: any) => c.id === "done");
		expect(done.count).toBe(1);
	});

	it("move_card: неизвестная колонка → ошибка со списком", async () => {
		const s = await session(root);
		await expect(moveCard(s, { board: "Спринт", id: "card01", column: "Нет" })).rejects.toThrow(
			/column 'Нет' not found/,
		);
	});

	// --- list_events ---

	it("list_events: разворачивает серии и одноразовые в диапазоне", async () => {
		const s = await session(root);
		const res = listEvents(s, {
			from: "2026-07-20",
			to: "2026-07-31",
			namespace: "Жизнь",
		}) as any;
		// одноразовое «День рождения» на своей дате
		const bday = res.events.find((e: any) => e.title === "День рождения");
		expect(bday).toBeDefined();
		expect(bday.date).toBe("2026-07-25");
		expect(bday.kind).toBe("single");
		// серия «Йога» — с временем 08:00, вхождения по понедельникам
		const yoga = res.events.filter((e: any) => e.title === "Йога");
		expect(yoga.length).toBeGreaterThanOrEqual(1);
		expect(yoga[0].time).toBe("08:00");
		expect(yoga[0].kind).toBe("series");
	});

	// --- add_event ---

	it("add_event: одноразовое с временем и местом", async () => {
		const s = await session(root);
		const res = (await addEvent(s, {
			name: "Встреча",
			namespace: "Жизнь",
			date: "2026-07-28",
			time: "15:00-16:00",
			location: "Офис",
		})) as any;
		expect(res.ok).toBe(true);
		expect(res.file).toBe("Жизнь/События.md");
		const content = await readVaultFile(root, "Жизнь/События.md");
		expect(content).toContain("- [ ] Встреча 📅 2026-07-28 15:00-16:00 📍 Офис");

		const s2 = await session(root);
		const ev = listEvents(s2, {
			from: "2026-07-28",
			to: "2026-07-28",
			namespace: "Жизнь",
		}) as any;
		const meeting = ev.events.find((e: any) => e.title === "Встреча");
		expect(meeting.time).toBe("15:00");
		expect(meeting.timeEnd).toBe("16:00");
		expect(meeting.location).toBe("Офис");
	});

	it("add_event: серия по грамматике", async () => {
		const s = await session(root);
		const res = (await addEvent(s, {
			name: "Планёрка",
			namespace: "Работа",
			rule: "every weekday at 10:00",
		})) as any;
		expect(res.ok).toBe(true);
		expect(res.file).toBe("Работа/События.md");
		const content = await readVaultFile(root, "Работа/События.md");
		expect(content).toContain("gtd-events: true");
		expect(content).toContain("🔁 every weekday at 10:00");
	});

	it("add_event: без date и rule → ошибка", async () => {
		const s = await session(root);
		await expect(addEvent(s, { name: "X", namespace: "Жизнь" })).rejects.toThrow(
			/either 'rule' .* or 'date'/,
		);
	});

	it("add_event: rule + time — время вплавляется в правило хвостом 'at'", async () => {
		const s = await session(root);
		const res = (await addEvent(s, {
			name: "Созвон",
			namespace: "Работа",
			rule: "every tuesday",
			time: "19:00",
		})) as any;
		expect(res.ok).toBe(true);
		const content = await readVaultFile(root, "Работа/События.md");
		expect(content).toContain("🔁 every tuesday at 19:00");
	});

	it("add_event: 'saturday' в правиле не принимается за клаузу 'at'", async () => {
		// \bat\b не должен цепляться за 'at' внутри слова saturday
		const s = await session(root);
		const res = (await addEvent(s, {
			name: "Матч",
			namespace: "Работа",
			rule: "every saturday",
			time: "12:00",
		})) as any;
		expect(res.ok).toBe(true);
		const content = await readVaultFile(root, "Работа/События.md");
		expect(content).toContain("🔁 every saturday at 12:00");
	});

	it("add_event: rule уже с 'at' + отдельный time → ошибка", async () => {
		const s = await session(root);
		await expect(
			addEvent(s, {
				name: "X",
				namespace: "Работа",
				rule: "every tuesday at 18:00",
				time: "19:00",
			}),
		).rejects.toThrow(/already sets a time/);
	});

	it("add_event: date и rule вместе → ошибка (двусмысленно)", async () => {
		const s = await session(root);
		await expect(
			addEvent(s, {
				name: "X",
				namespace: "Работа",
				date: "2026-07-28",
				rule: "every tuesday",
			}),
		).rejects.toThrow(/mutually exclusive/);
	});

	// --- list_boards ---

	it("list_boards: доски со счётчиками карточек", async () => {
		const s = await session(root);
		const res = listBoards(s, { namespace: "Работа" }) as any;
		expect(res.count).toBe(1);
		const sprint = res.boards[0];
		expect(sprint.id).toBe("sprint");
		expect(sprint.total).toBe(2);
		const todo = sprint.columns.find((c: any) => c.id === "todo");
		expect(todo.count).toBe(1);
	});
});

// --- FIX-1: MCP не должен мутировать read-only зеркала внешних календарей ---

const EXT_FILES: Record<string, string> = {
	".obsidian/plugins/gtd-flow/data.json": JSON.stringify({
		commonRoot: "GTD",
		eventsFile: "GTD/Events.md",
		autoInjectId: true,
		namespaces: [{ name: "Работа", root: "Работа" }],
		activeNamespace: "Общее",
	}),
	// обычный файл — для «ленивой» проверки, что не-external пишутся как раньше
	"GTD/Inbox.md": `---\ngtd-inbox: true\n---\n- [ ] Обычная задача 🆔 norm1\n`,
	// зеркало внешнего календаря: gtd-events + gtd-external, событие с 🆔
	"GTD/External/Google-abc123.md": `---\ngtd-events: true\ngtd-external: true\n---\n- [ ] Внешняя встреча 📅 2026-07-25 🆔 extmir1\n`,
	// доска — цель move_card
	"Работа/Доски/Спринт.md": `---\ngtd-board: true\nid: sprint\nname: Спринт\ncolumns:\n  - {id: todo, name: Очередь, match: "#kanban/sprint/todo"}\n  - {id: done, name: Готово, match: "#kanban/sprint/done"}\n---\n- [ ] Задача A #kanban/sprint/todo 🆔 card01\n`,
};

const MIRROR_PATH = "GTD/External/Google-abc123.md";

describe("MCP read-only защита зеркал внешних календарей (FIX-1)", () => {
	let root: string;
	beforeEach(async () => {
		root = await makeVault(EXT_FILES);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	it("update_task по 🆔 из зеркала → отказ read-only, файл не тронут", async () => {
		const s = await session(root);
		const before = await readVaultFile(root, MIRROR_PATH);
		const res = (await updateTask(s, { id: "extmir1", done: true })) as any;
		expect(res.ok).toBe(false);
		expect(res.failed.some((f: any) => f.reason === EXTERNAL_READONLY_REASON)).toBe(true);
		expect(await readVaultFile(root, MIRROR_PATH)).toBe(before); // ноль записей
	});

	it("delete_task по 🆔 из зеркала → ошибка read-only", async () => {
		const s = await session(root);
		await expect(deleteTask(s, { id: "extmir1" })).rejects.toThrow(EXTERNAL_READONLY_REASON);
		expect(await readVaultFile(root, MIRROR_PATH)).toContain("extmir1"); // строка на месте
	});

	it("move_card карточки из зеркала → ошибка read-only", async () => {
		const s = await session(root);
		await expect(
			moveCard(s, { board: "Спринт", id: "extmir1", column: "done" }),
		).rejects.toThrow(EXTERNAL_READONLY_REASON);
	});

	it("обычный (не-external) файл пишется как раньше — защита не задевает", async () => {
		const s = await session(root);
		const res = (await updateTask(s, { id: "norm1", done: true })) as any;
		expect(res.ok).toBe(true);
		expect(await readVaultFile(root, "GTD/Inbox.md")).toMatch(
			/- \[x\] Обычная задача 🆔 norm1 ✅/,
		);
	});
});
