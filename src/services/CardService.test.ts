import { describe, expect, it } from "vitest";
import type { Intent } from "../core/intents/Intent";
import type { ContainerKind, Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { FakeFeed } from "../stores/testSupport";
import { CardService } from "./CardService";
import {
	WritebackService,
	type IntentDispatcher,
	type IntentResult,
	type WritePort,
} from "./WritebackService";

// --- фейки: как в WritebackService.test.ts / RecurrenceService.test.ts ---

class FakePort implements WritePort {
	readonly files = new Map<string, string>();
	/** Фактические записи (изменившие содержимое). */
	readonly writes: Array<{ path: string; content: string }> = [];

	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		const content = this.files.get(path);
		if (content === undefined) return false;
		const next = transform(content);
		if (next === null || next === content) return false;
		this.files.set(path, next);
		this.writes.push({ path, content: next });
		return true;
	}
}

/** Обёртка диспетчера: записывает intents, делегируя реальному WritebackService. */
class RecordingDispatcher implements IntentDispatcher {
	readonly intents: Intent[] = [];
	constructor(private readonly inner: IntentDispatcher) {}
	async dispatch(intent: Intent): Promise<IntentResult> {
		this.intents.push(intent);
		return this.inner.dispatch(intent);
	}
}

const INBOX = "GTD/Inbox.md";

function parseFile(path: string, content: string, container: ContainerKind): Task[] {
	const lines = content.split("\n");
	const out: Task[] = [];
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

/**
 * Фейковый findCardFile: скан frontmatter файлов порта (мимика
 * MetadataAdapter.findByFrontmatterValue, включая детерминированный выбор
 * лексикографически наименьшего пути при дублях).
 */
function findCardIn(files: ReadonlyMap<string, string>, taskId: string): string | null {
	let best: string | null = null;
	for (const [path, content] of files) {
		const m = /^---\n([\s\S]*?)\n---/.exec(content);
		if (m === null) continue;
		const line = m[1]!.split("\n").find((l) => l.startsWith("gtd-card-of:"));
		if (line === undefined) continue;
		const raw = line.slice("gtd-card-of:".length).trim();
		const val: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw;
		if (String(val) === taskId && (best === null || path < best)) best = path;
	}
	return best;
}

interface HarnessOptions {
	cardsFolder?: string;
	cardLinkInLine?: boolean;
	genId?: () => string;
}

function makeHarness(over: HarnessOptions = {}) {
	const port = new FakePort();
	const feed = new FakeFeed();
	const dispatcher = new RecordingDispatcher(
		new WritebackService({ write: port, feed, autoInjectId: false }),
	);
	const opened: string[] = [];
	const ensured: string[] = [];
	const svc = new CardService({
		feed,
		write: port,
		dispatcher,
		ensureFile: async (path) => {
			ensured.push(path);
			if (!port.files.has(path)) port.files.set(path, "");
		},
		settings: () => ({
			cardsFolder: over.cardsFolder ?? "GTD/Cards",
			cardLinkInLine: over.cardLinkInLine ?? true,
		}),
		...(over.genId !== undefined ? { genId: over.genId } : {}),
		openFile: async (path) => {
			opened.push(path);
		},
		findCardFile: (taskId) => findCardIn(port.files, taskId),
	});
	/** Эмуляция индексатора: перечитать файл порта в индекс. */
	const sync = (path: string, container: ContainerKind = "plain") => {
		feed.replaceFile(path, parseFile(path, port.files.get(path) ?? "", container));
	};
	return { port, feed, dispatcher, svc, opened, ensured, sync };
}

// ---------------------------------------------------------------------------
// cardPathOf / progressOf
// ---------------------------------------------------------------------------

describe("CardService: cardPathOf / progressOf", () => {
	it("null-id → null (задача без 🆔 карточки не имеет)", () => {
		const { svc } = makeHarness();
		expect(svc.cardPathOf(null)).toBeNull();
		expect(svc.progressOf(null)).toBeNull();
	});

	it("карточки нет → null", () => {
		const { svc } = makeHarness();
		expect(svc.cardPathOf("nope")).toBeNull();
		expect(svc.progressOf("nope")).toBeNull();
	});

	it("прогресс чек-строк карточки: done = x/X, total = все", () => {
		const { port, svc, sync } = makeHarness();
		const CARD = "GTD/Cards/abc План.md";
		port.files.set(
			CARD,
			'---\ngtd-card-of: "abc"\n---\n\n# План\n\n- [x] Шаг 1\n- [ ] Шаг 2\n- [/] Шаг 3\n',
		);
		sync(CARD, "card");

		expect(svc.cardPathOf("abc")).toBe(CARD);
		expect(svc.progressOf("abc")).toEqual({ done: 1, total: 3 });
	});

	it("карточка без чек-строк (индексу не видна) → {0, 0}", () => {
		const { port, svc } = makeHarness();
		port.files.set("GTD/Cards/x.md", '---\ngtd-card-of: "x1"\n---\n\n# Пусто\n');
		// файл в индекс не попадал вовсе — byFile пуст
		expect(svc.progressOf("x1")).toEqual({ done: 0, total: 0 });
	});
});

// ---------------------------------------------------------------------------
// openOrCreate
// ---------------------------------------------------------------------------

describe("CardService: openOrCreate — создание", () => {
	it("создаёт файл с frontmatter, заголовком и заготовкой чеклиста; открывает его", async () => {
		const { port, svc, sync, opened } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);

		const res = await svc.openOrCreate("id:m3q9z4");

		const path = "GTD/Cards/m3q9z4 Собрать сметы.md";
		expect(res).toEqual({ ok: true, path });
		expect(port.files.get(path)).toBe(
			'---\ngtd-card-of: "m3q9z4"\n---\n\n# Собрать сметы\n\n- [ ] \n',
		);
		expect(opened).toEqual([path]);
	});

	it("cardLinkInLine: [[ссылка]] дописывается в строку задачи перед первым эмодзи-полем", async () => {
		const { port, svc, sync } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 📅 2026-07-20 🆔 m3q9z4\n");
		sync(INBOX);

		await svc.openOrCreate("id:m3q9z4");

		expect(port.files.get(INBOX)).toBe(
			"- [ ] Собрать сметы [[m3q9z4 Собрать сметы]] 📅 2026-07-20 🆔 m3q9z4\n",
		);
	});

	it("cardLinkInLine=false: строка задачи не тронута", async () => {
		const { port, svc, sync } = makeHarness({ cardLinkInLine: false });
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);

		const res = await svc.openOrCreate("id:m3q9z4");

		expect(res.ok).toBe(true);
		expect(port.files.get(INBOX)).toBe("- [ ] Собрать сметы 🆔 m3q9z4\n");
	});

	it("имя файла санитизировано (запрещённые символы Windows/Obsidian вычищены)", async () => {
		const { svc, port, sync } = makeHarness();
		port.files.set(INBOX, "- [ ] Спека: график/план? 🆔 wild\n");
		sync(INBOX);

		const res = await svc.openOrCreate("id:wild");

		expect(res.path).toBe("GTD/Cards/wild Спека график план.md");
		expect(port.files.has("GTD/Cards/wild Спека график план.md")).toBe(true);
	});

	it("неизвестный ключ → task-not-found, ноль записей", async () => {
		const { svc, port } = makeHarness();
		const res = await svc.openOrCreate("id:nope");
		expect(res).toEqual({ ok: false, reason: "task-not-found" });
		expect(port.writes).toEqual([]);
	});

	it("посторонний файл под именем карточки не перезаписывается", async () => {
		const { port, svc, sync, opened } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);
		const path = "GTD/Cards/m3q9z4 Собрать сметы.md";
		port.files.set(path, "чужая заметка\n");

		const res = await svc.openOrCreate("id:m3q9z4");

		expect(res.ok).toBe(true);
		expect(port.files.get(path)).toBe("чужая заметка\n"); // содержимое не тронуто
		expect(opened).toEqual([path]);
	});
});

describe("CardService: openOrCreate — ленивый 🆔", () => {
	it("id генерируется заранее и уходит в set-id intent; файл называется этим id", async () => {
		const { port, feed, dispatcher, svc, sync } = makeHarness({ genId: () => "gen001" });
		port.files.set(INBOX, "- [ ] Позвонить в банк\n");
		sync(INBOX);
		const key = [...feed.getIndex().all()].find(
			(t) => t.description === "Позвонить в банк",
		)!.key;

		const res = await svc.openOrCreate(key);

		expect(res.ok).toBe(true);
		expect(res.path).toBe("GTD/Cards/gen001 Позвонить в банк.md");
		expect(dispatcher.intents).toContainEqual({ type: "set-id", key, taskId: "gen001" });
		// 🆔 вписан в строку ДО ссылки; ссылка — перед первым эмодзи-полем
		expect(port.files.get(INBOX)).toBe(
			"- [ ] Позвонить в банк [[gen001 Позвонить в банк]] 🆔 gen001\n",
		);
		expect(port.files.get("GTD/Cards/gen001 Позвонить в банк.md")).toBe(
			'---\ngtd-card-of: "gen001"\n---\n\n# Позвонить в банк\n\n- [ ] \n',
		);
	});

	it("задача с существующим 🆔 не получает set-id", async () => {
		const { port, dispatcher, svc, sync } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);

		await svc.openOrCreate("id:m3q9z4");

		expect(dispatcher.intents.filter((i) => i.type === "set-id")).toEqual([]);
	});

	it("генератор выдаёт только занятые id → id-collision, ноль записей", async () => {
		const { port, feed, svc, sync } = makeHarness({ genId: () => "taken1" });
		port.files.set(INBOX, "- [ ] Без id\n- [ ] Занято 🆔 taken1\n");
		sync(INBOX);
		const key = [...feed.getIndex().all()].find((t) => t.description === "Без id")!.key;

		const res = await svc.openOrCreate(key);

		expect(res).toEqual({ ok: false, reason: "id-collision" });
		expect(port.writes).toEqual([]);
	});
});

describe("CardService: openOrCreate — идемпотентность", () => {
	it("повторный вызов не создаёт второй файл и не дублирует ссылку", async () => {
		const { port, svc, sync, ensured, opened } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);

		const first = await svc.openOrCreate("id:m3q9z4");
		sync(INBOX); // индекс догнал правку строки (ссылка в описании)
		const second = await svc.openOrCreate("id:m3q9z4");

		expect(second).toEqual(first);
		expect(ensured).toHaveLength(1); // второй вызов файл не создавал
		expect(opened).toHaveLength(2); // но открыл карточку снова
		const inbox = port.files.get(INBOX)!;
		expect(inbox.split("[[")).toHaveLength(2); // ровно одна ссылка
		expect([...port.files.keys()].filter((p) => p.startsWith("GTD/Cards/"))).toHaveLength(1);
	});

	it("повтор без sync индекса (дебаунс не догнал) — тоже без дублей", async () => {
		const { port, svc, sync } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);

		await svc.openOrCreate("id:m3q9z4");
		await svc.openOrCreate("id:m3q9z4"); // задача в индексе всё ещё со старой rawLine

		expect(port.files.get(INBOX)!.split("[[")).toHaveLength(2);
		expect([...port.files.keys()].filter((p) => p.startsWith("GTD/Cards/"))).toHaveLength(1);
	});

	it("переименованная пользователем карточка находится по frontmatter, ссылка — на новое имя", async () => {
		const { port, svc, sync, ensured } = makeHarness();
		port.files.set(INBOX, "- [ ] Собрать сметы 🆔 m3q9z4\n");
		sync(INBOX);
		// карточка уже существует под произвольным именем
		port.files.set("GTD/Cards/Переименованная.md", '---\ngtd-card-of: "m3q9z4"\n---\n\n# X\n');

		const res = await svc.openOrCreate("id:m3q9z4");

		expect(res).toEqual({ ok: true, path: "GTD/Cards/Переименованная.md" });
		expect(ensured).toEqual([]); // ничего не создавалось
		expect(port.files.get(INBOX)).toBe("- [ ] Собрать сметы [[Переименованная]] 🆔 m3q9z4\n");
	});
});
