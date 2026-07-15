import { describe, expect, it } from "vitest";
import type { Intent } from "../core/intents/Intent";
import type { Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { FakeFeed } from "../stores/testSupport";
import { WritebackService, type WritePort } from "./WritebackService";

// --- фейковый порт записи поверх in-memory Map ---

class FakePort implements WritePort {
	readonly files = new Map<string, string>();
	/** Фактические записи (изменившие содержимое). */
	readonly writes: Array<{ path: string; content: string }> = [];
	/** Все вызовы processFile (включая read-only). */
	calls = 0;
	/** Номер вызова processFile, который «падает» (эмуляция сбоя); 0 — никогда. */
	failOnCall = 0;

	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		this.calls++;
		if (this.calls === this.failOnCall) throw new Error("эмулированный сбой записи");
		const content = this.files.get(path);
		if (content === undefined) return false; // файла нет — transform не зовём (как VaultAdapter)
		const next = transform(content);
		if (next === null || next === content) return false;
		this.files.set(path, next);
		this.writes.push({ path, content: next });
		return true;
	}
}

function parseLine(path: string, line: string, lineNo = 0): Task {
	const t = parseTaskLine(line, {
		filePath: path,
		lineStart: lineNo,
		parentLine: null,
		heading: null,
		container: "plain",
		projectActive: true,
	});
	if (t === null) throw new Error(`не задача: ${line}`);
	return t;
}

interface HarnessOptions {
	autoInjectId?: boolean;
	genId?: () => string;
}

function makeSvc(over: HarnessOptions = {}) {
	const port = new FakePort();
	const feed = new FakeFeed();
	const svc = new WritebackService({
		write: port,
		feed,
		autoInjectId: over.autoInjectId ?? true,
		genId: over.genId,
	});
	return { port, feed, svc };
}

const INBOX = "GTD/Inbox.md";

describe("WritebackService: локализация строки", () => {
	it("находит строку по 🆔 при сдвинутых строках, не цепляя двойника по описанию", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] позвонить в банк 🆔 abc", 0);
		feed.replaceFile(INBOX, [task]);
		// файл ушёл вперёд: подсказка lineStart=0 устарела, на строке 1 — двойник без 🆔
		port.files.set(
			INBOX,
			"текст\n- [ ] позвонить в банк\nещё текст\n- [ ] позвонить в банк 🆔 abc\n",
		);

		const res = await svc.dispatch({ type: "set-date", key: task.key, field: "due", date: "2026-08-01" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe(
			"текст\n- [ ] позвонить в банк\nещё текст\n- [ ] позвонить в банк 🆔 abc 📅 2026-08-01\n",
		);
	});

	it("content-key fallback выбирает кандидата, ближайшего к advisory lineStart", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		const t0 = parseLine(INBOX, "- [ ] дубль", 0);
		const t5 = parseLine(INBOX, "- [ ] дубль", 5);
		feed.replaceFile(INBOX, [t0, t5]); // индекс уникализирует второй ключ сам
		const stored5 = feed.getIndex().fileTasks(INBOX).find((t) => t.lineStart === 5)!;
		// строка удалена выше — второй дубль съехал с 5-й на 4-ю
		port.files.set(INBOX, "- [ ] дубль\nзаметка\nзаметка\nзаметка\n- [ ] дубль\n");

		const res = await svc.dispatch({ type: "set-date", key: stored5.key, field: "due", date: "2026-08-01" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe(
			"- [ ] дубль\nзаметка\nзаметка\nзаметка\n- [ ] дубль 📅 2026-08-01\n",
		);
	});

	it("content-key не захватывает строку с чужим 🆔", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		const task = parseLine(INBOX, "- [ ] дубль", 0);
		feed.replaceFile(INBOX, [task]);
		// единственная строка с тем же описанием несёт 🆔 — она принадлежит id-ключу
		port.files.set(INBOX, "- [ ] дубль 🆔 zzz\n");

		const res = await svc.dispatch({ type: "set-date", key: task.key, field: "due", date: "2026-08-01" });

		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(port.files.get(INBOX)).toBe("- [ ] дубль 🆔 zzz\n");
	});

	it("line-not-found после удаления строки: ноль записей", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] пропала", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "просто текст\n");

		const res = await svc.dispatch({ type: "set-status", key: task.key, statusChar: "x" });

		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(port.writes).toHaveLength(0);
	});

	it("file-not-found, если файла задачи больше нет", async () => {
		const { feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] где-то", 0);
		feed.replaceFile(INBOX, [task]);

		const res = await svc.dispatch({ type: "set-status", key: task.key, statusChar: "x" });

		expect(res).toEqual({ ok: false, reason: "file-not-found" });
	});

	it("task-not-found при неизвестном key: порт не трогаем", async () => {
		const { port, svc } = makeSvc();
		const res = await svc.dispatch({ type: "set-date", key: "нет такого", field: "due", date: "2026-08-01" });
		expect(res).toEqual({ ok: false, reason: "task-not-found" });
		expect(port.calls).toBe(0);
	});
});

describe("WritebackService: ленивый 🆔", () => {
	it("структурная правка вставляет 🆔 и правку одной записью", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "aa1" });
		const task = parseLine(INBOX, "- [ ] новая задача", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] новая задача\n");

		const res = await svc.dispatch({ type: "set-date", key: task.key, field: "due", date: "2026-08-01" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] новая задача 🆔 aa1 📅 2026-08-01\n");
		expect(port.writes).toHaveLength(1); // 🆔 и 📅 — в одной записи
	});

	it("set-status НЕ вставляет 🆔", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "aa1" });
		const task = parseLine(INBOX, "- [ ] чек", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] чек\n");

		const res = await svc.dispatch({
			type: "set-status",
			key: task.key,
			statusChar: "x",
			date: "2026-07-15",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [x] чек ✅ 2026-07-15\n");
	});

	it("autoInjectId=false — структурная правка без 🆔", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false, genId: () => "aa1" });
		const task = parseLine(INBOX, "- [ ] без айди", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] без айди\n");

		const res = await svc.dispatch({ type: "defer", key: task.key, until: "2026-09-01" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] без айди 🛫 2026-09-01\n");
	});

	it("коллизия genId: занятый в индексе id пропускается", async () => {
		let n = 0;
		const ids = ["aa1", "bb2"];
		const { port, feed, svc } = makeSvc({ genId: () => ids[n++ % ids.length]! });
		feed.replaceFile("other.md", [parseLine("other.md", "- [ ] занято 🆔 aa1", 0)]);
		const task = parseLine(INBOX, "- [ ] свежая", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] свежая\n");

		const res = await svc.dispatch({ type: "set-priority", key: task.key, priority: "high" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toContain("🆔 bb2");
	});

	it("генератор зациклился на занятом id → id-collision, ноль записей", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "aa1" });
		feed.replaceFile("other.md", [parseLine("other.md", "- [ ] занято 🆔 aa1", 0)]);
		const task = parseLine(INBOX, "- [ ] свежая", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] свежая\n");

		const res = await svc.dispatch({ type: "set-date", key: task.key, field: "due", date: "2026-08-01" });

		expect(res).toEqual({ ok: false, reason: "id-collision" });
		expect(port.writes).toHaveLength(0);
	});
});

describe("WritebackService: advance-cursor", () => {
	const REC = "GTD/Recurring.md";

	it("двигает 🔜 на строке шаблона по templateId", async () => {
		const { port, feed, svc } = makeSvc();
		const line = "- [ ] ревью 🔁 every month 🆔 tpl1 🔜 2026-07-31";
		feed.replaceFile(REC, [parseLine(REC, line, 0)]);
		port.files.set(REC, `${line}\n`);

		const res = await svc.dispatch({ type: "advance-cursor", templateId: "tpl1", date: "2026-08-31" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(REC)).toBe("- [ ] ревью 🔁 every month 🆔 tpl1 🔜 2026-08-31\n");
	});

	it("fail-closed при дублях templateId", async () => {
		const { port, feed, svc } = makeSvc();
		feed.replaceFile("a.md", [parseLine("a.md", "- [ ] ш 🆔 tpl1 🔜 2026-07-31", 0)]);
		feed.replaceFile("b.md", [parseLine("b.md", "- [ ] ш 🆔 tpl1 🔜 2026-07-31", 0)]);

		const res = await svc.dispatch({ type: "advance-cursor", templateId: "tpl1", date: "2026-08-31" });

		expect(res).toEqual({ ok: false, reason: "duplicate-id" });
		expect(port.calls).toBe(0);
	});
});

describe("WritebackService: move-line", () => {
	const TARGET = "GTD/Project.md";

	it("append в цель → delete из источника; ленивый 🆔 перед append", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "mv1" });
		const task = parseLine(INBOX, "- [ ] входящая", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] входящая\n- [ ] остаётся\n");
		port.files.set(TARGET, "- [ ] существующая\n");

		const res = await svc.dispatch({ type: "move-line", key: task.key, toFile: TARGET });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] остаётся\n");
		expect(port.files.get(TARGET)).toBe("- [ ] существующая\n- [ ] входящая 🆔 mv1\n");
		expect(port.writes).toHaveLength(3); // 🆔 в источник, append, delete
	});

	it("задача с 🆔 переносится за две записи; пустая цель получает строку без пустых хвостов", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] переезд 🆔 mvX", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] переезд 🆔 mvX\n");
		port.files.set(TARGET, "");

		const res = await svc.dispatch({ type: "move-line", key: task.key, toFile: TARGET });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("");
		expect(port.files.get(TARGET)).toBe("- [ ] переезд 🆔 mvX\n");
		expect(port.writes).toHaveLength(2); // без инъекции: append + delete
	});

	it("сбой второй записи оставляет дубль 🆔 (виден линтом), повторный dispatch сходится", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] переезд 🆔 mvX", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] переезд 🆔 mvX\n");
		port.files.set(TARGET, "");
		// вызовы: 1 — локализация (read-only), 2 — append, 3 — delete; валим delete
		port.failOnCall = 3;

		const first = await svc.dispatch({ type: "move-line", key: task.key, toFile: TARGET });

		expect(first.ok).toBe(false);
		// дубль: оба файла несут один 🆔 — потери строки нет
		expect(port.files.get(INBOX)).toContain("🆔 mvX");
		expect(port.files.get(TARGET)).toContain("🆔 mvX");

		// повтор: append пропущен (🆔 уже в цели), delete добивает источник
		port.failOnCall = 0;
		const second = await svc.dispatch({ type: "move-line", key: task.key, toFile: TARGET });

		expect(second).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("");
		expect(port.files.get(TARGET)).toBe("- [ ] переезд 🆔 mvX\n");
		// строка в цели ровно одна
		expect(port.files.get(TARGET)!.split("mvX")).toHaveLength(2);
	});

	it("цель отсутствует → file-not-found, источник с 🆔 не изменён", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] переезд 🆔 mvX", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] переезд 🆔 mvX\n");

		const res = await svc.dispatch({ type: "move-line", key: task.key, toFile: "нет.md" });

		expect(res).toEqual({ ok: false, reason: "file-not-found" });
		expect(port.files.get(INBOX)).toBe("- [ ] переезд 🆔 mvX\n");
	});
});

describe("WritebackService: сохранность содержимого", () => {
	it("CRLF-файл: правка не корёжит \\r\\n и вставляет поле перед \\r", async () => {
		const { port, feed, svc } = makeSvc();
		const path = "crlf.md";
		const task = parseLine(path, "- [ ] цель 🆔 c1", 1);
		feed.replaceFile(path, [task]);
		port.files.set(path, "- [ ] один\r\n- [ ] цель 🆔 c1\r\nхвост\r\n");

		const res = await svc.dispatch({ type: "set-date", key: task.key, field: "due", date: "2026-09-01" });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(path)).toBe("- [ ] один\r\n- [ ] цель 🆔 c1 📅 2026-09-01\r\nхвост\r\n");
	});

	it("no-op трансформ — успех без записи (идемпотентность)", async () => {
		const { port, feed, svc } = makeSvc();
		const line = "- [x] сделано 🆔 dd1 ✅ 2026-07-01";
		const task = parseLine(INBOX, line, 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, `${line}\n`);

		const res = await svc.dispatch({
			type: "set-status",
			key: task.key,
			statusChar: "x",
			date: "2026-07-01",
		});

		expect(res).toEqual({ ok: true });
		expect(port.writes).toHaveLength(0);
	});

	it("невалидный трансформ (кривая дата) → transform-failed без записи", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] дата 🆔 e1", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] дата 🆔 e1\n");

		const res = await svc.dispatch({ type: "set-date", key: task.key, field: "due", date: "2026-13-05" });

		expect(res).toEqual({ ok: false, reason: "transform-failed" });
		expect(port.writes).toHaveLength(0);
	});
});

describe("WritebackService: delete-line", () => {
	it("удаляет ровно строку с 🆔 (вместе с '\\n'), соседей не трогает", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] копия 🧬 tpl 🆔 tpl-20260715", 1);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(INBOX, "- [ ] первая\n- [ ] копия 🧬 tpl 🆔 tpl-20260715\n- [ ] третья\n");

		const res = await svc.dispatch({ type: "delete-line", key: victim.key });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] первая\n- [ ] третья\n");
	});

	it("при дублях 🆔 в одном файле удаляется носитель, ближайший к advisory lineStart", async () => {
		const { port, feed, svc } = makeSvc();
		const first = parseLine(INBOX, "- [ ] копия 🆔 dup1", 0);
		const second = parseLine(INBOX, "- [x] копия 🆔 dup1 ✅ 2026-07-15", 2);
		feed.replaceFile(INBOX, [first, second]);
		// хранимый ключ второго носителя уникализирован индексом — берём его оттуда
		const storedFirst = feed.getIndex().fileTasks(INBOX).find((t) => t.lineStart === 0)!;
		port.files.set(INBOX, "- [ ] копия 🆔 dup1\nтекст\n- [x] копия 🆔 dup1 ✅ 2026-07-15\n");

		const res = await svc.dispatch({ type: "delete-line", key: storedFirst.key });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("текст\n- [x] копия 🆔 dup1 ✅ 2026-07-15\n");
	});

	it("строка уже исчезла → line-not-found, ноль записей", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] копия 🆔 gone1", 0);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(INBOX, "просто текст\n");

		const res = await svc.dispatch({ type: "delete-line", key: victim.key });

		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(port.writes).toHaveLength(0);
	});

	it("повторный dispatch идемпотентен: вторая попытка {ok:false,'line-not-found'}", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] копия 🆔 twice1", 0);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(INBOX, "- [ ] копия 🆔 twice1\n- [ ] сосед\n");

		const first = await svc.dispatch({ type: "delete-line", key: victim.key });
		const second = await svc.dispatch({ type: "delete-line", key: victim.key });

		expect(first).toEqual({ ok: true });
		// это штатный исход для дедупа: строки уже нет, файл не тронут повторно
		expect(second).toEqual({ ok: false, reason: "line-not-found" });
		expect(port.files.get(INBOX)).toBe("- [ ] сосед\n");
		expect(port.writes).toHaveLength(1);
	});

	it("task-not-found при неизвестном key: порт не трогаем", async () => {
		const { port, svc } = makeSvc();
		const res = await svc.dispatch({ type: "delete-line", key: "нет такого" });
		expect(res).toEqual({ ok: false, reason: "task-not-found" });
		expect(port.calls).toBe(0);
	});
});

describe("WritebackService: непокрытые этапы", () => {
	it("spawn-instances/reorder/графовые → not-implemented-stage", async () => {
		const { port, svc } = makeSvc();
		const intents: Intent[] = [
			{ type: "spawn-instances", file: "x.md", lines: ["- [ ] a"] },
			{ type: "reorder", boardPath: "b.md", column: "c", orderedKeys: [] },
			{ type: "connect-edge", projectPath: "p.md", sourceId: "a", targetId: "b" },
			{ type: "move-node", projectPath: "p.md", positions: {} },
		];
		for (const intent of intents) {
			expect(await svc.dispatch(intent)).toEqual({ ok: false, reason: "not-implemented-stage" });
		}
		expect(port.calls).toBe(0);
	});
});
