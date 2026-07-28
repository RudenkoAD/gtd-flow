import { describe, expect, it } from "vitest";
import type { Intent } from "../core/intents/Intent";
import type { Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { computeKey } from "../core/parser/taskKey";
import { FakeFeed } from "../stores/testSupport";
import { EXTERNAL_READONLY_REASON, WritebackService, type WritePort } from "./WritebackService";

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

/**
 * Индексирует содержимое как настоящий IndexerService: парс построчно + то же
 * назначение occurrenceIndex дублям без 🆔 (хвост #n в key и одноимённое поле).
 * Нужен для тестов адресации: детерминизм дублей завязан именно на occurrenceIndex.
 */
function indexContent(feed: FakeFeed, path: string, content: string): void {
	const lines = content.split("\n");
	const parsed: Task[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = parseTaskLine(lines[i]!, {
			filePath: path,
			lineStart: i,
			parentLine: null,
			heading: null,
			container: "plain",
			projectActive: true,
		});
		if (t !== null) parsed.push(t);
	}
	const seen = new Map<string, number>();
	const withOcc = parsed.map((t) => {
		if (t.taskId !== null) return t;
		const n = seen.get(t.key) ?? 0;
		seen.set(t.key, n + 1);
		return { ...t, key: n === 0 ? t.key : computeKey(t, n), occurrenceIndex: n };
	});
	feed.replaceFile(path, withOcc);
}

/** Задача файла с данным occurrenceIndex (id-less дубль). */
function dupByOccurrence(feed: FakeFeed, path: string, occ: number): Task {
	const t = feed
		.getIndex()
		.fileTasks(path)
		.find((x) => x.occurrenceIndex === occ);
	if (t === undefined) throw new Error(`нет дубля с occurrenceIndex=${occ}`);
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

		const res = await svc.dispatch({
			type: "set-date",
			key: task.key,
			field: "due",
			date: "2026-08-01",
		});

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
		const stored5 = feed
			.getIndex()
			.fileTasks(INBOX)
			.find((t) => t.lineStart === 5)!;
		// строка удалена выше — второй дубль съехал с 5-й на 4-ю
		port.files.set(INBOX, "- [ ] дубль\nзаметка\nзаметка\nзаметка\n- [ ] дубль\n");

		const res = await svc.dispatch({
			type: "set-date",
			key: stored5.key,
			field: "due",
			date: "2026-08-01",
		});

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

		const res = await svc.dispatch({
			type: "set-date",
			key: task.key,
			field: "due",
			date: "2026-08-01",
		});

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
		const res = await svc.dispatch({
			type: "set-date",
			key: "нет такого",
			field: "due",
			date: "2026-08-01",
		});
		expect(res).toEqual({ ok: false, reason: "task-not-found" });
		expect(port.calls).toBe(0);
	});
});

describe("WritebackService: протухший индекс при двойниках (content-key)", () => {
	/** Индекс знает ДВЕ id-less строки-двойника; в файле одна уже получила 🆔. */
	function staleTwinSetup(over: HarnessOptions = {}) {
		const h = makeSvc(over);
		const t0 = parseLine(INBOX, "- [ ] позвонить маме", 0);
		const t1 = parseLine(INBOX, "- [ ] позвонить маме", 1);
		h.feed.replaceFile(INBOX, [t0, t1]);
		const stored0 = h.feed
			.getIndex()
			.fileTasks(INBOX)
			.find((t) => t.lineStart === 0)!;
		return { ...h, stored0 };
	}

	it("ленивый 🆔 у цели в окне дебаунса: правка НЕ уходит в строку-двойник (stale-index)", async () => {
		const { port, svc, stored0 } = staleTwinSetup({ autoInjectId: false });
		// строка 0 уже несёт 🆔 (структурная правка другого диспетчера до реиндекса):
		// id-less кандидат в файле остался один — и это ЧУЖАЯ задача (строка 1)
		port.files.set(INBOX, "- [ ] позвонить маме 🆔 aa1 🛫 2026-07-20\n- [ ] позвонить маме\n");

		const res = await svc.dispatch({
			type: "set-status",
			key: stored0.key,
			statusChar: "x",
			date: "2026-07-15",
		});

		expect(res).toEqual({ ok: false, reason: "stale-index" });
		expect(port.writes).toHaveLength(0); // двойник не отмечен «сделанным»
	});

	it("память вписанных 🆔: следующая правка тем же ключом адресуется по id, а не по content-key", async () => {
		const { port, svc, stored0 } = staleTwinSetup({ genId: () => "aa1" });
		port.files.set(INBOX, "- [ ] позвонить маме\n- [ ] позвонить маме\n");

		const defer = await svc.dispatch({ type: "defer", key: stored0.key, until: "2026-07-20" });
		expect(defer).toEqual({ ok: true });
		// индекс НЕ пересобран (дебаунс) — чек-офф тем же ключом идёт по памяти 🆔
		const res = await svc.dispatch({
			type: "set-status",
			key: stored0.key,
			statusChar: "x",
			date: "2026-07-15",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe(
			"- [x] позвонить маме 🆔 aa1 🛫 2026-07-20 ✅ 2026-07-15\n- [ ] позвонить маме\n",
		);
	});

	it("set-id запоминается: карточка привязывается к СВОЕЙ строке, а не к двойнику", async () => {
		const { port, svc, stored0 } = staleTwinSetup();
		port.files.set(INBOX, "- [ ] позвонить маме\n- [ ] позвонить маме\n");

		const setId = await svc.dispatch({ type: "set-id", key: stored0.key, taskId: "card1" });
		expect(setId).toEqual({ ok: true });
		const res = await svc.dispatch({
			type: "set-date",
			key: stored0.key,
			field: "due",
			date: "2026-08-01",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe(
			"- [ ] позвонить маме 🆔 card1 📅 2026-08-01\n- [ ] позвонить маме\n",
		);
	});

	it("move-line при протухшем индексе (двойник уже с 🆔) — fail-closed без записей", async () => {
		const { port, svc, stored0 } = staleTwinSetup({ genId: () => "mv1" });
		port.files.set(INBOX, "- [ ] позвонить маме 🆔 zz9\n- [ ] позвонить маме\n");
		port.files.set("GTD/Project.md", "");

		const res = await svc.dispatch({
			type: "move-line",
			key: stored0.key,
			toFile: "GTD/Project.md",
		});

		expect(res).toEqual({ ok: false, reason: "stale-index" });
		expect(port.writes).toHaveLength(0); // чужой двойник не уехал в другой файл
	});

	it("move-line по памяти 🆔: переносится именно строка с вписанным id", async () => {
		const { port, svc, stored0 } = staleTwinSetup({ genId: () => "aa1" });
		port.files.set(INBOX, "- [ ] позвонить маме\n- [ ] позвонить маме\n");
		port.files.set("GTD/Project.md", "");

		await svc.dispatch({ type: "defer", key: stored0.key, until: "2026-07-20" }); // впишет 🆔 aa1
		const res = await svc.dispatch({
			type: "move-line",
			key: stored0.key,
			toFile: "GTD/Project.md",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] позвонить маме\n"); // двойник остался
		expect(port.files.get("GTD/Project.md")).toBe(
			"- [ ] позвонить маме 🆔 aa1 🛫 2026-07-20\n",
		);
	});
});

describe("WritebackService: ленивый 🆔", () => {
	it("структурная правка вставляет 🆔 и правку одной записью", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "aa1" });
		const task = parseLine(INBOX, "- [ ] новая задача", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] новая задача\n");

		const res = await svc.dispatch({
			type: "set-date",
			key: task.key,
			field: "due",
			date: "2026-08-01",
		});

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

		const res = await svc.dispatch({
			type: "set-date",
			key: task.key,
			field: "due",
			date: "2026-08-01",
		});

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

		const res = await svc.dispatch({
			type: "advance-cursor",
			templateId: "tpl1",
			date: "2026-08-31",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(REC)).toBe("- [ ] ревью 🔁 every month 🆔 tpl1 🔜 2026-08-31\n");
	});

	it("fail-closed при дублях templateId", async () => {
		const { port, feed, svc } = makeSvc();
		feed.replaceFile("a.md", [parseLine("a.md", "- [ ] ш 🆔 tpl1 🔜 2026-07-31", 0)]);
		feed.replaceFile("b.md", [parseLine("b.md", "- [ ] ш 🆔 tpl1 🔜 2026-07-31", 0)]);

		const res = await svc.dispatch({
			type: "advance-cursor",
			templateId: "tpl1",
			date: "2026-08-31",
		});

		expect(res).toEqual({ ok: false, reason: "duplicate-id" });
		expect(port.calls).toBe(0);
	});
});

describe("WritebackService: move-line", () => {
	const TARGET = "GTD/Project.md";

	it("same-file отклоняется до любых записей", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "mv1" });
		const task = parseLine(INBOX, "- [ ] остаётся на месте", 0);
		feed.replaceFile(INBOX, [task]);
		const original = "- [ ] остаётся на месте\n";
		port.files.set(INBOX, original);

		const res = await svc.dispatch({ type: "move-line", key: task.key, toFile: INBOX });

		expect(res).toEqual({ ok: false, reason: "same-file" });
		expect(port.files.get(INBOX)).toBe(original);
		expect(port.calls).toBe(0);
		expect(port.writes).toHaveLength(0);
	});

	it("лексический alias того же файла отклоняется до любых записей", async () => {
		const path = "GTD/Note.md";
		const { port, feed, svc } = makeSvc();
		const task = parseLine(path, "- [ ] не удалить 🆔 same1", 0);
		feed.replaceFile(path, [task]);
		const original = "- [ ] не удалить 🆔 same1\n";
		port.files.set(path, original);

		const res = await svc.dispatch({
			type: "move-line",
			key: task.key,
			toFile: "GTD/folder/../Note.md",
		});

		expect(res).toEqual({ ok: false, reason: "same-file" });
		expect(port.files.get(path)).toBe(original);
		expect(port.calls).toBe(0);
		expect(port.writes).toHaveLength(0);
	});

	it("цель, выходящая выше корня vault, отклоняется до записи", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] не вынести 🆔 safe1", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] не вынести 🆔 safe1\n");

		expect(
			await svc.dispatch({ type: "move-line", key: task.key, toFile: "../outside.md" }),
		).toEqual({ ok: false, reason: "invalid-target-path" });
		expect(port.calls).toBe(0);
	});

	it("чужой носитель того же 🆔 в цели — conflict без изменений источника", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] исходная 🆔 shared", 0);
		feed.replaceFile(INBOX, [task]);
		const source = "- [ ] исходная 🆔 shared\n";
		const target = "- [ ] совершенно другая 🆔 shared\n";
		port.files.set(INBOX, source);
		port.files.set(TARGET, target);

		const res = await svc.dispatch({ type: "move-line", key: task.key, toFile: TARGET });

		expect(res).toEqual({ ok: false, reason: "duplicate-id-conflict" });
		expect(port.files.get(INBOX)).toBe(source);
		expect(port.files.get(TARGET)).toBe(target);
		expect(port.writes).toHaveLength(0);
	});

	it("точно совпавшая строка в цели — идемпотентный retry и удаление источника", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] переезд 🆔 retry1", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] переезд 🆔 retry1\n");
		port.files.set(TARGET, "- [ ] переезд 🆔 retry1\n");

		const res = await svc.dispatch({ type: "move-line", key: task.key, toFile: TARGET });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("");
		expect(port.files.get(TARGET)).toBe("- [ ] переезд 🆔 retry1\n");
	});

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
		// вызовы: 1 — локализация, 2 — preflight цели, 3 — append, 4 — delete; валим delete
		port.failOnCall = 4;

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

describe("WritebackService: explicit stable ids", () => {
	it("ensureTaskId вписывает якорь при autoInjectId=false и помнит его до реиндекса", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false, genId: () => "stable1" });
		const task = parseLine(INBOX, "- [ ] составная операция", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] составная операция\n");

		const result = await svc.ensureTaskId(task.key);

		expect(result).toEqual({ ok: true, taskId: "stable1" });
		expect(port.files.get(INBOX)).toBe("- [ ] составная операция 🆔 stable1\n");
		expect(svc.knownTaskId(task.key)).toBe("stable1");
	});
});

describe("WritebackService: сохранность содержимого", () => {
	it("CRLF-файл: правка не корёжит \\r\\n и вставляет поле перед \\r", async () => {
		const { port, feed, svc } = makeSvc();
		const path = "crlf.md";
		const task = parseLine(path, "- [ ] цель 🆔 c1", 1);
		feed.replaceFile(path, [task]);
		port.files.set(path, "- [ ] один\r\n- [ ] цель 🆔 c1\r\nхвост\r\n");

		const res = await svc.dispatch({
			type: "set-date",
			key: task.key,
			field: "due",
			date: "2026-09-01",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(path)).toBe(
			"- [ ] один\r\n- [ ] цель 🆔 c1 📅 2026-09-01\r\nхвост\r\n",
		);
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

		const res = await svc.dispatch({
			type: "set-date",
			key: task.key,
			field: "due",
			date: "2026-13-05",
		});

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
		const storedFirst = feed
			.getIndex()
			.fileTasks(INBOX)
			.find((t) => t.lineStart === 0)!;
		port.files.set(INBOX, "- [ ] копия 🆔 dup1\nтекст\n- [x] копия 🆔 dup1 ✅ 2026-07-15\n");

		const res = await svc.dispatch({ type: "delete-line", key: storedFirst.key });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("текст\n- [x] копия 🆔 dup1 ✅ 2026-07-15\n");
	});

	it("сдвиг строк после первого удаления: протухшая подсказка НЕ роняет под нож изменённого кипера", async () => {
		const { port, feed, svc } = makeSvc();
		// три носителя одного 🆔: две пристин-копии и изменённый пользователем кипер
		const p0 = parseLine(INBOX, "- [ ] копия 🆔 dup2", 0);
		const p1 = parseLine(INBOX, "- [ ] копия 🆔 dup2", 1);
		const keeper = parseLine(INBOX, "- [x] копия 🆔 dup2 ✅ 2026-07-15", 2);
		feed.replaceFile(INBOX, [p0, p1, keeper]);
		const stored = feed.getIndex().fileTasks(INBOX);
		const k0 = stored.find((t) => t.lineStart === 0)!;
		const k1 = stored.find((t) => t.lineStart === 1)!;
		port.files.set(
			INBOX,
			"- [ ] копия 🆔 dup2\n- [ ] копия 🆔 dup2\n- [x] копия 🆔 dup2 ✅ 2026-07-15\n",
		);

		const first = await svc.dispatch({ type: "delete-line", key: k0.key });
		// индекс НЕ пересобран: у второй жертвы подсказка lineStart=1 теперь
		// указывает на кипера, съехавшего со строки 2 на строку 1
		const second = await svc.dispatch({ type: "delete-line", key: k1.key });

		expect(first).toEqual({ ok: true });
		expect(second).toEqual({ ok: true });
		// работа пользователя цела — удалены обе пристин-копии
		expect(port.files.get(INBOX)).toBe("- [x] копия 🆔 dup2 ✅ 2026-07-15\n");
	});

	it("текст строки разошёлся со знанием индекса → line-not-found (правку пользователя не удаляем)", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] копия 🆔 edited1", 0);
		feed.replaceFile(INBOX, [victim]);
		// пользователь успел дописать текст между сборкой индекса и записью
		port.files.set(INBOX, "- [ ] копия 🆔 edited1 и созвон\n");

		const res = await svc.dispatch({ type: "delete-line", key: victim.key });

		expect(res).toEqual({ ok: false, reason: "line-not-found" });
		expect(port.writes).toHaveLength(0);
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

describe("WritebackService: set-text (фидбек-раунд 1)", () => {
	it("правит описание, лениво вписывает 🆔 (смена content-key!) и сохраняет поля", async () => {
		const { port, svc, feed } = makeSvc({ genId: () => "tx1" });
		const line = "- [ ] старый текст #tag 📅 2026-07-25 14:30";
		port.files.set(INBOX, line + "\n");
		feed.replaceFile(INBOX, [parseLine(INBOX, line, 0)]);
		const key = feed.getIndex().fileTasks(INBOX)[0]!.key;

		const res = await svc.dispatch({ type: "set-text", key, text: "новый текст" });

		expect(res).toEqual({ ok: true });
		const written = port.files.get(INBOX)!;
		expect(written).toContain("новый текст");
		expect(written).not.toContain("старый текст");
		expect(written).toContain("🆔 tx1"); // structural: без id задача потеряла бы адресуемость
		expect(written).toContain("📅 2026-07-25 14:30"); // поля (и время) нетронуты
	});

	// Регресс из ревью: задача с ВЕДУЩИМ 📍 (токенизатор читает его заголовком
	// описания). Раньше setDescription отвергал ЛЮБОЙ 📍 в новом тексте → set-text
	// падал transform-failed и правка молча терялась. Сохранение ведущего 📍 при
	// переименовании обязано записаться.
	it("правит описание задачи с ведущим 📍 (сохранение 📍) — правка не теряется", async () => {
		const { port, svc, feed } = makeSvc({ genId: () => "tx2" });
		const line = "- [ ] 📍 Погладить кота 📅 2026-07-20";
		port.files.set(INBOX, line + "\n");
		feed.replaceFile(INBOX, [parseLine(INBOX, line, 0)]);
		const key = feed.getIndex().fileTasks(INBOX)[0]!.key;

		const res = await svc.dispatch({ type: "set-text", key, text: "📍 Погладить собаку" });

		expect(res).toEqual({ ok: true });
		const written = port.files.get(INBOX)!;
		expect(written).toContain("📍 Погладить собаку");
		expect(written).not.toContain("Погладить кота");
		expect(written).toContain("📅 2026-07-20"); // поле-дата нетронуто
	});
});

describe("WritebackService: set-location", () => {
	it("пишет 📍 у обычной задачи БЕЗ ленивого 🆔 (не структурная, content-key стабилен)", async () => {
		const { port, svc, feed } = makeSvc({ genId: () => "loc1" });
		const line = "- [ ] Купить хлеб";
		port.files.set(INBOX, line + "\n");
		feed.replaceFile(INBOX, [parseLine(INBOX, line, 0)]);
		const key = feed.getIndex().fileTasks(INBOX)[0]!.key;

		const res = await svc.dispatch({ type: "set-location", key, location: "Пятёрочка" });

		expect(res).toEqual({ ok: true });
		// 📍 не меняет content-key ⇒ 🆔 не вписывается (в отличие от set-text/set-date)
		expect(port.files.get(INBOX)).toBe("- [ ] Купить хлеб 📍 Пятёрочка\n");
	});

	it("снятие места: null убирает 📍", async () => {
		const { port, svc, feed } = makeSvc({ autoInjectId: false });
		const line = "- [ ] Созвон 📍 Кафе 🆔 e1";
		port.files.set(INBOX, line + "\n");
		feed.replaceFile(INBOX, [parseLine(INBOX, line, 0)]);
		const key = feed.getIndex().fileTasks(INBOX)[0]!.key;

		const res = await svc.dispatch({ type: "set-location", key, location: null });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] Созвон 🆔 e1\n");
	});

	it("пустой сабмит без существующего места — no-op без записи (ok)", async () => {
		const { port, svc, feed } = makeSvc({ autoInjectId: false });
		const line = "- [ ] Созвон 🆔 e1";
		port.files.set(INBOX, line + "\n");
		feed.replaceFile(INBOX, [parseLine(INBOX, line, 0)]);
		const key = feed.getIndex().fileTasks(INBOX)[0]!.key;

		const res = await svc.dispatch({ type: "set-location", key, location: null });

		expect(res).toEqual({ ok: true });
		expect(port.writes).toHaveLength(0); // строка не изменилась — записи нет
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
			expect(await svc.dispatch(intent)).toEqual({
				ok: false,
				reason: "not-implemented-stage",
			});
		}
		expect(port.calls).toBe(0);
	});
});

describe("WritebackService: детерминизм дублей по occurrenceIndex (баг перетаскивания)", () => {
	it("правка ВТОРОЙ из двух одинаковых меняет именно вторую", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		const content = "- [ ] дубль\n- [ ] дубль\n";
		port.files.set(INBOX, content);
		indexContent(feed, INBOX, content);

		const res = await svc.dispatch({
			type: "set-date",
			key: dupByOccurrence(feed, INBOX, 1).key,
			field: "due",
			date: "2026-08-01",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] дубль\n- [ ] дубль 📅 2026-08-01\n");
	});

	it("правка ПЕРВОЙ из двух одинаковых меняет именно первую", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		const content = "- [ ] дубль\n- [ ] дубль\n";
		port.files.set(INBOX, content);
		indexContent(feed, INBOX, content);

		const res = await svc.dispatch({
			type: "set-date",
			key: dupByOccurrence(feed, INBOX, 0).key,
			field: "due",
			date: "2026-08-01",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] дубль 📅 2026-08-01\n- [ ] дубль\n");
	});

	it("строки съехали вниз (вставка выше): occurrenceIndex адресует верно, где lineStart промахнулся бы", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		// индекс собран, когда дубли стояли на строках 0 и 1
		indexContent(feed, INBOX, "- [ ] дубль\n- [ ] дубль\n");
		const second = dupByOccurrence(feed, INBOX, 1); // occurrenceIndex 1, lineStart 1
		// файл уехал: три строки вставлены сверху, оба дубля теперь на 3 и 4 —
		// подсказка lineStart=1 ближе к ПЕРВОМУ дублю (строка 3), но править надо второй
		port.files.set(INBOX, "шапка\nшапка\nшапка\n- [ ] дубль\n- [ ] дубль\n");

		const res = await svc.dispatch({ type: "set-priority", key: second.key, priority: "high" });

		expect(res).toEqual({ ok: true });
		// ⏫ ушёл на ВТОРОЙ дубль (строка 4), первый (строка 3) нетронут
		expect(port.files.get(INBOX)).toBe("шапка\nшапка\nшапка\n- [ ] дубль\n- [ ] дубль ⏫\n");
	});

	it("правка ВТОРОЙ из ТРЁХ одинаковых (set-status) — ровно средняя из хвоста", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		const content = "- [ ] дубль\n- [ ] дубль\n- [ ] дубль\n";
		port.files.set(INBOX, content);
		indexContent(feed, INBOX, content);

		const res = await svc.dispatch({
			type: "set-status",
			key: dupByOccurrence(feed, INBOX, 1).key,
			statusChar: "x",
			date: "2026-07-15",
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] дубль\n- [x] дубль ✅ 2026-07-15\n- [ ] дубль\n");
	});

	it("перенос ВТОРОЙ из двух одинаковых в другой файл (move-line) уносит именно вторую", async () => {
		const TARGET = "GTD/Project.md";
		const { port, feed, svc } = makeSvc({ genId: () => "mv1" });
		const content = "- [ ] дубль\n- [ ] дубль\n";
		port.files.set(INBOX, content);
		port.files.set(TARGET, "");
		indexContent(feed, INBOX, content);

		const res = await svc.dispatch({
			type: "move-line",
			key: dupByOccurrence(feed, INBOX, 1).key,
			toFile: TARGET,
		});

		expect(res).toEqual({ ok: true });
		// в источнике осталась ПЕРВАЯ, вторая уехала (получив 🆔 при переносе)
		expect(port.files.get(INBOX)).toBe("- [ ] дубль\n");
		expect(port.files.get(TARGET)).toBe("- [ ] дубль 🆔 mv1\n");
	});

	it("рассинхрон: вторая строка изменена пользователем — правка не бьёт по первой (fail-closed)", async () => {
		const { port, feed, svc } = makeSvc({ autoInjectId: false });
		indexContent(feed, INBOX, "- [ ] дубль\n- [ ] дубль\n");
		const second = dupByOccurrence(feed, INBOX, 1);
		// пользователь дописал вторую строку — двойников в файле уже не два, а один
		port.files.set(INBOX, "- [ ] дубль\n- [ ] дубль и ещё дело\n");

		const res = await svc.dispatch({
			type: "set-date",
			key: second.key,
			field: "due",
			date: "2026-08-01",
		});

		expect(res).toEqual({ ok: false, reason: "stale-index" });
		expect(port.writes).toHaveLength(0); // первый дубль не тронут
	});
});

describe("WritebackService: delete-line withChildren (пункт «Удалить»)", () => {
	it("удаляет задачу вместе с вложенным блоком (строки с бо́льшим отступом)", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] родитель 🆔 p1", 0);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(
			INBOX,
			"- [ ] родитель 🆔 p1\n    заметка под задачей\n    - [ ] подпункт\n- [ ] сосед\n",
		);

		const res = await svc.dispatch({
			type: "delete-line",
			key: victim.key,
			withChildren: true,
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] сосед\n");
	});

	it("останавливается на сиблинге (отступ ≤ родителя) — его блок не трогает", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] родитель 🆔 p1", 0);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(
			INBOX,
			"- [ ] родитель 🆔 p1\n    ребёнок родителя\n- [ ] сиблинг\n    ребёнок сиблинга\n",
		);

		const res = await svc.dispatch({
			type: "delete-line",
			key: victim.key,
			withChildren: true,
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] сиблинг\n    ребёнок сиблинга\n");
	});

	it("пустая строка завершает блок (консервативно): ребёнок за пустой строкой остаётся сиротой", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] родитель 🆔 p1", 0);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(INBOX, "- [ ] родитель 🆔 p1\n\n    осиротевший ребёнок\n");

		const res = await svc.dispatch({
			type: "delete-line",
			key: victim.key,
			withChildren: true,
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("\n    осиротевший ребёнок\n");
	});

	it("без withChildren удаляет ровно одну строку (дедуп-семантика не изменилась)", async () => {
		const { port, feed, svc } = makeSvc();
		const victim = parseLine(INBOX, "- [ ] родитель 🆔 p1", 0);
		feed.replaceFile(INBOX, [victim]);
		port.files.set(INBOX, "- [ ] родитель 🆔 p1\n    ребёнок\n");

		const res = await svc.dispatch({ type: "delete-line", key: victim.key });

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("    ребёнок\n"); // ребёнок осиротел — минимум по умолчанию
	});

	it("детерминизм: «Удалить» ВТОРОЙ из двух одинаковых убирает вторую с её детьми", async () => {
		const { port, feed, svc } = makeSvc();
		const content = "- [ ] дубль\n    ребёнок первого\n- [ ] дубль\n    ребёнок второго\n";
		port.files.set(INBOX, content);
		indexContent(feed, INBOX, content);

		const res = await svc.dispatch({
			type: "delete-line",
			key: dupByOccurrence(feed, INBOX, 1).key,
			withChildren: true,
		});

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe("- [ ] дубль\n    ребёнок первого\n");
	});
});

describe("WritebackService: dispatchMany (атомарный пакет одной строки)", () => {
	it("несколько полей — одна запись processFile, все правки в строке", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] задача 🆔 abc", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] задача 🆔 abc\n");

		const res = await svc.dispatchMany([
			{ type: "set-text", key: task.key, text: "переименована" },
			{ type: "set-date", key: task.key, field: "due", date: "2026-08-01" },
			{ type: "set-priority", key: task.key, priority: "high" },
		]);

		expect(res).toEqual({ ok: true });
		expect(port.calls).toBe(1); // единственный processFile на весь пакет
		expect(port.writes).toHaveLength(1);
		const line = port.files.get(INBOX)!;
		expect(line).toContain("переименована");
		expect(line).toContain("📅 2026-08-01");
		expect(line).toContain("⏫");
	});

	it("id-less задача: text+date+location одной записью, ленивый 🆔 один на пакет", async () => {
		const { port, feed, svc } = makeSvc({ genId: () => "fresh1" });
		const content = "- [ ] без айди\n";
		port.files.set(INBOX, content);
		indexContent(feed, INBOX, content);
		const task = feed.getIndex().fileTasks(INBOX)[0]!;

		const res = await svc.dispatchMany([
			{ type: "set-text", key: task.key, text: "новый текст" },
			{ type: "set-date", key: task.key, field: "scheduled", date: "2026-08-02" },
			{ type: "set-location", key: task.key, location: "Дом" },
		]);

		expect(res).toEqual({ ok: true });
		expect(port.calls).toBe(1);
		const line = port.files.get(INBOX)!;
		expect(line).toContain("новый текст");
		expect(line).toContain("⏳ 2026-08-02");
		expect(line).toContain("📍 Дом");
		expect(line).toContain("🆔 fresh1"); // ровно один ленивый якорь
		expect(line.match(/🆔/g)).toHaveLength(1);
	});

	it("всё-или-ничего: сбой одного трансформа — файл не тронут, opIndex указывает виновника", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] задача 🆔 abc", 0);
		feed.replaceFile(INBOX, [task]);
		const original = "- [ ] задача 🆔 abc\n";
		port.files.set(INBOX, original);

		const res = await svc.dispatchMany([
			{ type: "set-text", key: task.key, text: "переименована" },
			// невалидная локация (эмодзи поля) — setValueField бросит
			{ type: "set-location", key: task.key, location: "📅 мусор" },
		]);

		expect(res).toEqual({ ok: false, reason: "transform-failed", opIndex: 1 });
		expect(port.files.get(INBOX)).toBe(original); // ноль записей
		expect(port.writes).toHaveLength(0);
	});

	it("строка не найдена — ничего не записано, opIndex = -1", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] задача 🆔 abc", 0);
		feed.replaceFile(INBOX, [task]);
		// внешняя правка: строка исчезла из файла до диспатча
		port.files.set(INBOX, "- [ ] совсем другая строка\n");

		const res = await svc.dispatchMany([
			{ type: "set-text", key: task.key, text: "x" },
			{ type: "set-priority", key: task.key, priority: "low" },
		]);

		expect(res).toEqual({ ok: false, reason: "line-not-found", opIndex: -1 });
		expect(port.writes).toHaveLength(0);
	});

	it("пакет из одного интента эквивалентен dispatch (поведение не изменилось)", async () => {
		const { port, feed, svc } = makeSvc();
		const task = parseLine(INBOX, "- [ ] одиночка 🆔 solo", 0);
		feed.replaceFile(INBOX, [task]);
		port.files.set(INBOX, "- [ ] одиночка 🆔 solo\n");

		const res = await svc.dispatchMany([
			{ type: "set-date", key: task.key, field: "due", date: "2026-09-01" },
		]);

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toContain("📅 2026-09-01");
	});

	it("интенты разных задач в одном пакете — отказ без записи", async () => {
		const { port, feed, svc } = makeSvc();
		const a = parseLine(INBOX, "- [ ] а 🆔 aa1", 0);
		const b = parseLine(INBOX, "- [ ] б 🆔 bb1", 1);
		feed.replaceFile(INBOX, [a, b]);
		port.files.set(INBOX, "- [ ] а 🆔 aa1\n- [ ] б 🆔 bb1\n");

		const res = await svc.dispatchMany([
			{ type: "set-priority", key: a.key, priority: "high" },
			{ type: "set-priority", key: b.key, priority: "low" },
		]);

		expect(res).toEqual({ ok: false, reason: "batch-not-single-line", opIndex: 1 });
		expect(port.writes).toHaveLength(0);
	});
});

describe("WritebackService: read-only защита зеркал внешних календарей", () => {
	const MIRROR = "GTD/External/Google.md";

	/** Сервис, где MIRROR помечен read-only (как gtd-external файл). */
	function makeGuarded() {
		const port = new FakePort();
		const feed = new FakeFeed();
		const svc = new WritebackService({
			write: port,
			feed,
			autoInjectId: true,
			readOnlyFile: (path) => path === MIRROR,
		});
		return { port, feed, svc };
	}

	it("правка строки в файле-зеркале отклоняется, файл не трогается", async () => {
		const { port, feed, svc } = makeGuarded();
		const ev = parseLine(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1", 0);
		feed.replaceFile(MIRROR, [ev]);
		port.files.set(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1\n");

		const res = await svc.dispatch({
			type: "set-date",
			key: ev.key,
			field: "due",
			date: "2026-08-01",
		});

		expect(res).toEqual({ ok: false, reason: EXTERNAL_READONLY_REASON });
		expect(port.calls).toBe(0); // до processFile даже не дошли
		expect(port.writes).toHaveLength(0);
	});

	it("удаление строки зеркала отклоняется", async () => {
		const { port, feed, svc } = makeGuarded();
		const ev = parseLine(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1", 0);
		feed.replaceFile(MIRROR, [ev]);
		port.files.set(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1\n");

		const res = await svc.dispatch({ type: "delete-line", key: ev.key });
		expect(res).toEqual({ ok: false, reason: EXTERNAL_READONLY_REASON });
		expect(port.calls).toBe(0);
	});

	it("move-line отклоняется и когда цель — зеркало, и когда источник — зеркало", async () => {
		const { port, feed, svc } = makeGuarded();
		// источник — обычный файл, цель — зеркало
		const t = parseLine(INBOX, "- [ ] Задача 🆔 t1", 0);
		const ev = parseLine(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1", 0);
		feed.replaceFile(INBOX, [t]);
		feed.replaceFile(MIRROR, [ev]);
		port.files.set(INBOX, "- [ ] Задача 🆔 t1\n");
		port.files.set(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1\n");

		const intoMirror = await svc.dispatch({ type: "move-line", key: t.key, toFile: MIRROR });
		expect(intoMirror).toEqual({ ok: false, reason: EXTERNAL_READONLY_REASON });

		const outOfMirror = await svc.dispatch({ type: "move-line", key: ev.key, toFile: INBOX });
		expect(outOfMirror).toEqual({ ok: false, reason: EXTERNAL_READONLY_REASON });
		expect(port.writes).toHaveLength(0);
	});

	it("правки обычных файлов не затронуты защитой", async () => {
		const { port, feed, svc } = makeGuarded();
		const t = parseLine(INBOX, "- [ ] Задача 🆔 t1", 0);
		feed.replaceFile(INBOX, [t]);
		port.files.set(INBOX, "- [ ] Задача 🆔 t1\n");

		const res = await svc.dispatch({ type: "set-priority", key: t.key, priority: "high" });
		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toContain("⏫");
	});

	// FIX-1: file-адресуемые интенты, направленные в зеркало, тоже отклоняются
	it("spawn-instances в файл-зеркало отклоняется (file-адресуемый интент)", async () => {
		const { port, svc } = makeGuarded();
		port.files.set(MIRROR, "- [ ] Внешнее 📅 2026-07-06 🆔 ext1\n");
		const res = await svc.dispatch({
			type: "spawn-instances",
			file: MIRROR,
			lines: ["- [ ] копия"],
		});
		expect(res).toEqual({ ok: false, reason: EXTERNAL_READONLY_REASON });
		expect(port.calls).toBe(0); // до processFile не дошли
	});

	it("интент проекта (set-project-status), нацеленный в зеркало, отклоняется", async () => {
		const { svc } = makeGuarded();
		const res = await svc.dispatch({
			type: "set-project-status",
			projectPath: MIRROR,
			status: "archived",
		});
		expect(res).toEqual({ ok: false, reason: EXTERNAL_READONLY_REASON });
	});

	it("file-адресуемый интент в ОБЫЧНЫЙ файл гардом не блокируется", async () => {
		const { svc } = makeGuarded();
		const res = await svc.dispatch({
			type: "spawn-instances",
			file: INBOX,
			lines: ["- [ ] копия"],
		});
		// не read-only: гард пропускает; дальше — штатный этап реализации
		expect(res).toEqual({ ok: false, reason: "not-implemented-stage" });
	});
});
