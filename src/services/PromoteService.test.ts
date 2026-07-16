import { describe, expect, it } from "vitest";
import { isInInbox, type QueryContext } from "../core/query/QueryEngine";
import { defaultInboxConfig } from "../core/query/querySpec";
import type { ContainerKind, IsoDate, Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { FakeFeed } from "../stores/testSupport";
import { PromoteService } from "./PromoteService";
import { WritebackService, type WritePort } from "./WritebackService";

// --- фейки: тот же порт, что в RecurrenceService.test.ts ---

class FakePort implements WritePort {
	readonly files = new Map<string, string>();
	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		const content = this.files.get(path);
		if (content === undefined) return false;
		const next = transform(content);
		if (next === null || next === content) return false;
		this.files.set(path, next);
		return true;
	}
}

const INBOX = "GTD/Входящие.md";
const TODAY: IsoDate = "2026-07-15";

function parseFile(path: string, content: string, container: ContainerKind): Task[] {
	const out: Task[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = parseTaskLine(lines[i]!, {
			filePath: path,
			lineStart: i,
			parentLine: null,
			heading: null,
			container,
			projectActive: true,
		});
		if (t !== null) out.push(t);
	}
	return out;
}

interface HarnessOptions {
	promoteTo?: "origin" | "inbox";
	includePlain?: boolean;
	today?: IsoDate;
	/** Последний обработанный день; null — проходов не было (усыновление).
	 *  Дефолт "2026-06-30": окно (30.06, today] покрывает фикстуры с 🛫 01.07+. */
	lastRun?: IsoDate | null;
}

function makeHarness(files: Record<string, { content: string; container: ContainerKind }>, over: HarnessOptions = {}) {
	const port = new FakePort();
	const feed = new FakeFeed(over.today ?? TODAY);
	const containers = new Map<string, ContainerKind>();
	for (const [path, f] of Object.entries(files)) {
		port.files.set(path, f.content);
		containers.set(path, f.container);
	}
	// целевой inbox-файл существует как gtd-inbox (перенос требует его наличия)
	if (!port.files.has(INBOX)) port.files.set(INBOX, "");
	containers.set(INBOX, "inbox");

	let idSeq = 0;
	const dispatcher = new WritebackService({
		write: port,
		feed,
		autoInjectId: true,
		genId: () => `id${++idSeq}`,
	});
	const state = {
		promoteTo: over.promoteTo ?? ("inbox" as const),
		includePlain: over.includePlain ?? false,
		lastRun: over.lastRun !== undefined ? over.lastRun : ("2026-06-30" as IsoDate | null),
	};
	const svc = new PromoteService({
		feed,
		dispatcher,
		todayIso: () => feed.today(),
		indexReady: () => true,
		settings: () => ({ promoteTo: state.promoteTo, includePlain: state.includePlain }),
		inboxTargetFor: () => INBOX,
		ensureInboxFile: async (path) => {
			if (!port.files.has(path)) port.files.set(path, "");
			return true;
		},
		lastRun: () => state.lastRun,
		setLastRun: async (day) => {
			state.lastRun = day;
		},
	});
	/** Перечитать все файлы порта в индекс (эмуляция реиндекса). */
	const sync = (): void => {
		for (const [path, content] of port.files) {
			feed.replaceFile(path, parseFile(path, content, containers.get(path) ?? "plain"));
		}
	};
	sync();
	return { port, feed, svc, state, sync };
}

/** Собрать все строки-задачи файла (для проверок содержимого). */
function lines(port: FakePort, path: string): string[] {
	return (port.files.get(path) ?? "").split("\n").filter((l) => l.trim() !== "");
}

describe("PromoteService — всплытие во входящие (promoteTo=inbox)", () => {
	it("первый проход (lastRun=null) усыновляет день БЕЗ обработки бэклога", async () => {
		const h = makeHarness(
			{ "Notes/a.md": { content: "- [ ] давно наступила 🛫 2026-07-10 🆔 aaa", container: "plain" } },
			{ lastRun: null },
		);
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(0);
		expect(h.port.files.get("Notes/a.md")).toContain("🛫 2026-07-10"); // бэклог не тронут
		expect(h.state.lastRun).toBe(TODAY); // день усыновлён
	});

	it("день уже обработан (lastRun == today) — no-op", async () => {
		const h = makeHarness(
			{ "Notes/a.md": { content: "- [ ] задача 🛫 2026-07-15 🆔 aaa", container: "plain" } },
			{ lastRun: TODAY },
		);
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(0);
		expect(h.port.files.get("Notes/a.md")).toContain("🛫 2026-07-15");
	});

	it("origin продвигает lastRun: позднее включение inbox не сметает origin-период", async () => {
		const h = makeHarness(
			{ "Notes/a.md": { content: "- [ ] задача 🛫 2026-07-10 🆔 aaa", container: "plain" } },
			{ promoteTo: "origin" },
		);
		await h.svc.runPass();
		expect(h.state.lastRun).toBe(TODAY);
		h.state.promoteTo = "inbox";
		const rep = await h.svc.runPass(); // тот же день — уже обработан
		expect(rep.promoted).toBe(0);
		expect(h.port.files.get("Notes/a.md")).toContain("🛫 2026-07-10");
	});

	it("origin: чистое всплытие, ноль записей", async () => {
		const h = makeHarness(
			{ "Notes/a.md": { content: "- [ ] plain задача 🛫 2026-07-10 🆔 aaa", container: "plain" } },
			{ promoteTo: "origin" },
		);
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(0);
		expect(h.port.files.get("Notes/a.md")).toContain("🛫 2026-07-10"); // не тронуто
		expect(lines(h.port, INBOX)).toEqual([]);
	});

	it("board: снимает 🛫 и тег колонки, переносит строку в inbox-файл", async () => {
		const h = makeHarness({
			"Boards/Work.md": {
				content: "- [ ] задача A 🛫 2026-07-10 #kanban/work/todo 🆔 aaa",
				container: "board",
			},
		});
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(1);
		expect(rep.moved).toBe(1);
		// ушла из файла доски
		expect(lines(h.port, "Boards/Work.md")).toEqual([]);
		// пришла в inbox БЕЗ 🛫 и БЕЗ тега колонки
		const inbox = lines(h.port, INBOX);
		expect(inbox).toHaveLength(1);
		expect(inbox[0]).toContain("задача A");
		expect(inbox[0]).toContain("🆔 aaa");
		expect(inbox[0]).not.toContain("🛫");
		expect(inbox[0]).not.toContain("#kanban/");

		// закрываем петлю: перенесённая задача реально попадает во «Входящие»
		h.sync();
		const moved = [...h.feed.getIndex().all()].find((t) => t.taskId === "aaa")!;
		expect(moved.filePath).toBe(INBOX);
		expect(isInInbox(moved, ctx(h.feed.today()))).toBe(true);
	});

	it("plain при includePlain=false: переносит в inbox-файл", async () => {
		const h = makeHarness(
			{ "Notes/a.md": { content: "- [ ] plain задача 🛫 2026-07-01 🆔 bbb", container: "plain" } },
			{ includePlain: false },
		);
		const rep = await h.svc.runPass();
		expect(rep.moved).toBe(1);
		expect(lines(h.port, "Notes/a.md")).toEqual([]);
		expect(lines(h.port, INBOX)[0]).toContain("plain задача");
	});

	it("plain при includePlain=true: снимает 🛫 на месте, без переноса", async () => {
		const h = makeHarness(
			{ "Notes/a.md": { content: "- [ ] plain задача 🛫 2026-07-01 🆔 ccc", container: "plain" } },
			{ includePlain: true },
		);
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(1);
		expect(rep.moved).toBe(0);
		expect(lines(h.port, INBOX)).toEqual([]); // не переносили
		const line = lines(h.port, "Notes/a.md")[0]!;
		expect(line).toContain("plain задача");
		expect(line).not.toContain("🛫"); // 🛫 снят
	});

	it("inbox-файл: снимает 🛫 и тег колонки на месте", async () => {
		const h = makeHarness({
			"GTD/Входящие.md": {
				content: "- [ ] уже во входящих 🛫 2026-07-10 #kanban/b/c 🆔 ddd",
				container: "inbox",
			},
		});
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(1);
		expect(rep.moved).toBe(0);
		const line = lines(h.port, INBOX)[0]!;
		expect(line).not.toContain("🛫");
		expect(line).not.toContain("#kanban/");
	});

	it("будущая 🛫 — не трогается", async () => {
		const h = makeHarness({
			"Notes/a.md": { content: "- [ ] будущая 🛫 2026-08-30 🆔 eee", container: "plain" },
		});
		const rep = await h.svc.runPass();
		expect(rep.promoted).toBe(0);
		expect(h.port.files.get("Notes/a.md")).toContain("🛫 2026-08-30");
	});

	it("идемпотентно: повторный проход (устаревший индекс) не плодит дублей", async () => {
		const h = makeHarness({
			"Boards/Work.md": {
				content: "- [ ] задача A 🛫 2026-07-10 #kanban/work/todo 🆔 aaa",
				container: "board",
			},
		});
		await h.svc.runPass();
		// второй проход БЕЗ реиндекса: индекс ещё показывает задачу в исходном файле
		const rep2 = await h.svc.runPass();
		expect(rep2.promoted).toBe(0); // строка уже перенесена — line-not-found, ноль записей
		expect(lines(h.port, INBOX)).toHaveLength(1); // ровно одна копия

		// а после реиндекса задача (уже без 🛫) вовсе не кандидат
		h.sync();
		const rep3 = await h.svc.runPass();
		expect(rep3.promoted).toBe(0);
		expect(lines(h.port, INBOX)).toHaveLength(1);
	});

	it("id-less задача: перенос вписывает 🆔 сам", async () => {
		const h = makeHarness({
			"Notes/a.md": { content: "- [ ] без идентификатора 🛫 2026-07-01", container: "plain" },
		});
		const rep = await h.svc.runPass();
		expect(rep.moved).toBe(1);
		expect(lines(h.port, "Notes/a.md")).toEqual([]);
		const inbox = lines(h.port, INBOX)[0]!;
		expect(inbox).toContain("без идентификатора");
		expect(inbox).toMatch(/🆔 id\d+/); // move-line обязан адресовать строку
	});
});

/** QueryContext входящих для проверки isInInbox (скоуп по умолчанию). */
function ctx(today: IsoDate): QueryContext {
	return {
		tasks: [],
		today,
		resolveDep: () => [],
		settingsBits: defaultInboxConfig(undefined, false),
	};
}
