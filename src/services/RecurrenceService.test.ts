import { describe, expect, it } from "vitest";
import type { Intent } from "../core/intents/Intent";
import type { ContainerKind, IsoDate, Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { FakeFeed } from "../stores/testSupport";
import { RecurrenceService } from "./RecurrenceService";
import {
	WritebackService,
	type IntentDispatcher,
	type IntentResult,
	type WritePort,
} from "./WritebackService";

// --- фейки: как в WritebackService.test.ts ---

class FakePort implements WritePort {
	readonly files = new Map<string, string>();
	/** Фактические записи (изменившие содержимое). */
	readonly writes: Array<{ path: string; content: string }> = [];
	calls = 0;
	/** Номер вызова processFile, который «падает»; 0 — никогда. */
	failOnCall = 0;

	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		this.calls++;
		if (this.calls === this.failOnCall) throw new Error("эмулированный сбой записи");
		const content = this.files.get(path);
		if (content === undefined) return false;
		const next = transform(content);
		if (next === null || next === content) return false;
		this.files.set(path, next);
		this.writes.push({ path, content: next });
		return true;
	}
}

/** Обёртка диспетчера для краш-эмуляции: advance-cursor «отказывает» по флагу. */
class FailingCursorDispatcher implements IntentDispatcher {
	failCursor = false;
	constructor(private readonly inner: IntentDispatcher) {}
	async dispatch(intent: Intent): Promise<IntentResult> {
		if (this.failCursor && intent.type === "advance-cursor") {
			return { ok: false, reason: "эмулированный отказ курсора" };
		}
		return this.inner.dispatch(intent);
	}
}

const REC = "GTD/Recurring.md";
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

interface HarnessOptions {
	today?: IsoDate;
	catchUp?: "latest" | "all" | "none";
	catchUpCap?: number;
	indexReady?: boolean;
	/** Детерминированный генератор 🆔 для ленивой инъекции в шаблон без него. */
	genId?: () => string;
}

/** Обвязка: реальный WritebackService как диспетчер поверх общего FakePort. */
function makeHarness(over: HarnessOptions = {}) {
	const port = new FakePort();
	const feed = new FakeFeed();
	const writeback = new WritebackService({ write: port, feed, autoInjectId: false });
	const dispatcher = new FailingCursorDispatcher(writeback);
	const state = {
		today: over.today ?? ("2026-07-15" as IsoDate),
		catchUp: over.catchUp ?? ("latest" as const),
		catchUpCap: over.catchUpCap ?? 30,
		indexReady: over.indexReady ?? true,
	};
	const svc = new RecurrenceService({
		feed,
		write: port,
		dispatcher,
		settings: () => ({
			inboxFile: INBOX,
			catchUp: state.catchUp,
			catchUpCap: state.catchUpCap,
		}),
		todayIso: () => state.today,
		indexReady: () => state.indexReady,
		ensureFile: async (path) => {
			if (!port.files.has(path)) port.files.set(path, "");
		},
		...(over.genId !== undefined ? { genId: over.genId } : {}),
	});
	/** Эмуляция индексатора: перечитать все файлы порта в индекс. */
	const sync = () => {
		for (const [path, content] of port.files) {
			feed.replaceFile(path, parseFile(path, content, path === REC ? "recurring" : "plain"));
		}
	};
	return { port, feed, svc, dispatcher, state, sync };
}

const TPL_LINE =
	"- [ ] Ревью приоритетов #review 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-07-31";
const INSTANCE_LINE =
	"- [ ] Ревью приоритетов #review 🛫 2026-07-28 ➕ 2026-08-03 🧬 rev-prio 🆔 rev-prio-20260731";

describe("RecurrenceService: гейт индекса", () => {
	it("runPass до готовности индекса — no-op с нулевым отчётом", async () => {
		const { port, svc } = makeHarness({ indexReady: false });
		port.files.set(REC, `${TPL_LINE}\n`);

		const report = await svc.runPass();

		expect(report).toEqual({ spawned: 0, advanced: 0, deduped: 0, conflicts: [], errors: [] });
		expect(port.calls).toBe(0);
	});

	it("spawnNow до готовности индекса — отказ без записей", async () => {
		const { port, svc } = makeHarness({ indexReady: false });
		const res = await svc.spawnNow("id:rev-prio");
		expect(res).toEqual({ ok: false, reason: "index-not-ready" });
		expect(port.calls).toBe(0);
	});
});

describe("RecurrenceService: полный цикл спавна", () => {
	it("дублирующиеся 🆔 шаблонов fail-closed: ни копий, ни курсоров", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(
			REC,
			[TPL_LINE, TPL_LINE.replace("Ревью приоритетов", "Другая копия шаблона")].join("\n") +
				"\n",
		);
		sync();

		const report = await svc.runPass();

		expect(report.spawned).toBe(0);
		expect(report.advanced).toBe(0);
		expect(report.errors).toHaveLength(2);
		expect(report.errors.every((e) => e.templateId === "rev-prio")).toBe(true);
		expect(report.errors[0]!.message).toContain("duplicate recurring template id rev-prio");
		expect(port.files.has(INBOX)).toBe(false);
		expect(port.writes).toHaveLength(0);
		expect(await svc.spawnNow("id:rev-prio")).toEqual({
			ok: false,
			reason: "duplicate-template-id",
		});
	});

	it("шаблон → копия в target, потом сдвиг 🔜 (копия строго раньше курсора)", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		const report = await svc.runPass();

		expect(report).toEqual({ spawned: 1, advanced: 1, deduped: 0, conflicts: [], errors: [] });
		expect(port.files.get(INBOX)).toBe(`${INSTANCE_LINE}\n`);
		expect(port.files.get(REC)).toBe(
			"- [ ] Ревью приоритетов #review 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-08-31\n",
		);
		// порядок записи: сначала копия (INBOX), потом курсор (REC) — ТЗ §6 шаг 4
		expect(port.writes.map((w) => w.path)).toEqual([INBOX, REC]);
	});

	it("двойной runPass идемпотентен: второй проход — пустой план, ноль записей", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();
		await svc.runPass();
		sync(); // индексатор увидел копию и сдвинутый курсор

		const writesBefore = port.writes.length;
		const second = await svc.runPass();

		expect(second).toEqual({ spawned: 0, advanced: 0, deduped: 0, conflicts: [], errors: [] });
		expect(port.writes.length).toBe(writesBefore);
		expect(port.files.get(INBOX)).toBe(`${INSTANCE_LINE}\n`);
	});

	it("мьютекс: два параллельных runPass дают ровно одну копию", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		const [r1, r2] = await Promise.all([svc.runPass(), svc.runPass()]);

		// второй проход сериализован ПОСЛЕ первого: спавн гасится повторной
		// проверкой 🆔 в содержимом (индекс за это время не синхронизировался)
		expect(r1.spawned + r2.spawned).toBe(1);
		const inbox = port.files.get(INBOX)!;
		expect(inbox.split("rev-prio-20260731")).toHaveLength(2); // ровно одно вхождение
	});

	it("гонка: копия уже в target (индекс отстал) → без дубля, курсор двигается", async () => {
		const { port, feed, svc, state } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(REC, `${TPL_LINE}\n`);
		port.files.set(INBOX, `${INSTANCE_LINE}\n`); // собственная незакоммиченная запись
		// индексатор отстал: он знает ТОЛЬКО шаблон, копию в target ещё не видел —
		// existingIds её не гасит, спасает повторная проверка 🆔 внутри transform
		feed.replaceFile(REC, parseFile(REC, port.files.get(REC)!, "recurring"));

		const report = await svc.runPass();

		expect(report.spawned).toBe(0);
		expect(report.advanced).toBe(1);
		expect(port.files.get(INBOX)!.split("rev-prio-20260731")).toHaveLength(2);
		expect(port.files.get(REC)).toContain("🔜 2026-08-31");
	});

	it("краш-эмуляция: копия записана, advance-cursor отказал → второй проход не дублирует и двигает курсор", async () => {
		const { port, svc, sync, state, dispatcher } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		dispatcher.failCursor = true;
		const first = await svc.runPass();

		expect(first.spawned).toBe(1);
		expect(first.advanced).toBe(0);
		expect(first.errors).toHaveLength(1);
		expect(first.errors[0]!.templateId).toBe("rev-prio");
		expect(port.files.get(REC)).toContain("🔜 2026-07-31"); // курсор НЕ сдвинут

		dispatcher.failCursor = false;
		sync(); // индекс увидел копию; курсор всё ещё старый
		const second = await svc.runPass();

		expect(second.spawned).toBe(0); // existingIds гасит повторный спавн
		expect(second.advanced).toBe(1); // курсор добит
		expect(port.files.get(INBOX)!.split("rev-prio-20260731")).toHaveLength(2);
		expect(port.files.get(REC)).toContain("🔜 2026-08-31");
	});

	it("catchUp latest над разрывом: ровно одна свежайшая копия", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15", catchUp: "latest" });
		port.files.set(REC, "- [ ] Standup 🔁 every day 🆔 stand 🔜 2026-04-16\n");
		sync();

		const report = await svc.runPass();

		expect(report.spawned).toBe(1);
		expect(port.files.get(INBOX)).toBe(
			"- [ ] Standup ➕ 2026-07-15 🧬 stand 🆔 stand-20260715\n",
		);
		expect(port.files.get(REC)).toBe("- [ ] Standup 🔁 every day 🆔 stand 🔜 2026-07-16\n");
	});

	it("сломанное правило — в errors; шаблон без 🆔 — не ошибка, а инъекция id", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15", genId: () => "injected1" });
		port.files.set(
			REC,
			[
				"- [ ] Кривое правило 🔁 когда-нибудь 🆔 bad1 🔜 2026-07-01",
				"- [ ] Без айди 🔁 every day",
				"- [ ] Standup 🔁 every day 🆔 stand 🔜 2026-07-15",
			].join("\n") + "\n",
		);
		sync();

		const report = await svc.runPass();

		expect(report.spawned).toBe(1);
		// ошибка "нет 🆔" исчезла как класс: остаётся только кривое правило
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]!.templateId).toBe("bad1");
		expect(report.errors[0]!.message).toContain("unparseable");
		// строке без 🆔 вписан детерминированный id — в этом же проходе, без спавна
		expect(port.files.get(REC)).toContain("- [ ] Без айди 🔁 every day 🆔 injected1");
	});
});

describe("RecurrenceService: ленивая инъекция 🆔 в шаблон без него", () => {
	it("проход 1 вписывает 🆔 (без спавна и без ошибки), проход 2 спавнит", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15", genId: () => "genrec" });
		port.files.set(REC, "- [ ] Обзор 🔁 every day\n");
		sync();

		const first = await svc.runPass();

		expect(first.errors).toEqual([]);
		expect(first.spawned).toBe(0); // спавн отдан следующему проходу
		expect(port.files.get(REC)).toBe("- [ ] Обзор 🔁 every day 🆔 genrec\n");
		expect(port.files.get(INBOX) ?? "").toBe(""); // копии в этом проходе нет

		sync(); // индексатор увидел 🆔 на шаблоне

		const second = await svc.runPass();

		expect(second.errors).toEqual([]);
		expect(second.spawned).toBe(1);
		expect(port.files.get(INBOX)).toContain("🧬 genrec 🆔 genrec-20260715");
	});

	it("повторный проход до реиндекса НЕ вписывает второй id (идемпотентность окна дебаунса)", async () => {
		const ids = ["id1", "id2"];
		let n = 0;
		const { port, svc, sync } = makeHarness({ today: "2026-07-15", genId: () => ids[n++]! });
		port.files.set(REC, "- [ ] Обзор 🔁 every day\n");
		sync();

		await svc.runPass();
		const afterFirst = port.files.get(REC);
		// индекс НЕ пересинхронизирован: шаблон в индексе всё ещё без 🆔
		const second = await svc.runPass();

		expect(port.files.get(REC)).toBe(afterFirst); // id не переписан
		expect(port.files.get(REC)).toContain("🆔 id1");
		expect(port.files.get(REC)).not.toContain("id2");
		expect(second.errors).toEqual([]);
	});
});

describe("RecurrenceService: дедуп двух устройств", () => {
	/** Шаблон с курсором в будущем (спавнов нет — проверяем только дедуп). */
	const TPL_ADVANCED =
		"- [ ] Ревью приоритетов #review 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-08-31";
	const OTHER = "GTD/Другое.md";

	it("пристин-проигравший удалён, модифицированный выживает", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-05";
		port.files.set(REC, `${TPL_ADVANCED}\n`);
		port.files.set(INBOX, `${INSTANCE_LINE}\n`);
		const modified = INSTANCE_LINE.replace("- [ ]", "- [x]") + " ✅ 2026-08-04";
		port.files.set(OTHER, `${modified}\n`);
		sync();

		const report = await svc.runPass();

		expect(report.deduped).toBe(1);
		expect(report.conflicts).toEqual([]);
		expect(port.files.get(INBOX)).toBe(""); // машинная строка удалена
		expect(port.files.get(OTHER)).toBe(`${modified}\n`); // работа пользователя цела
	});

	it("все нетронуты → детерминированный победитель по (path, line)", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-05";
		const ARCHIVE = "GTD/Archive.md";
		port.files.set(REC, `${TPL_ADVANCED}\n`);
		port.files.set(INBOX, `${INSTANCE_LINE}\n`);
		port.files.set(ARCHIVE, `${INSTANCE_LINE}\n`);
		sync();

		const report = await svc.runPass();

		expect(report.deduped).toBe(1);
		// "GTD/Archive.md" < "GTD/Inbox.md" — выживает архивный носитель
		expect(port.files.get(ARCHIVE)).toBe(`${INSTANCE_LINE}\n`);
		expect(port.files.get(INBOX)).toBe("");
	});

	it("три носителя в одном файле: пристины сняты одной записью, кипер с работой пользователя цел", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-05";
		port.files.set(REC, `${TPL_ADVANCED}\n`);
		const modified = INSTANCE_LINE.replace("- [ ]", "- [x]") + " ✅ 2026-08-04";
		// схождение синка: ДВЕ пристин-копии НАД кипером — их удаление сдвигает
		// строки, последовательные delete-line с протухшими подсказками роняли кипера
		port.files.set(INBOX, `${INSTANCE_LINE}\n${INSTANCE_LINE}\n${modified}\n`);
		sync();

		const report = await svc.runPass();

		expect(report.deduped).toBe(2);
		expect(report.conflicts).toEqual([]);
		expect(port.files.get(INBOX)).toBe(`${modified}\n`); // работа пользователя цела
		// весь батч группы в файле — ровно одна запись
		expect(port.writes.filter((w) => w.path === INBOX)).toHaveLength(1);
	});

	it("все пристины в одном файле: выживает ровно один носитель", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-05";
		port.files.set(REC, `${TPL_ADVANCED}\n`);
		port.files.set(INBOX, `${INSTANCE_LINE}\n${INSTANCE_LINE}\n${INSTANCE_LINE}\n`);
		sync();

		const report = await svc.runPass();

		expect(report.deduped).toBe(2);
		expect(report.conflicts).toEqual([]);
		expect(port.files.get(INBOX)).toBe(`${INSTANCE_LINE}\n`);
	});

	it("конфликт двух модифицированных: ничего не удаляется, ключи в conflicts", async () => {
		const { port, svc, sync, state, feed } = makeHarness();
		state.today = "2026-08-05";
		port.files.set(REC, `${TPL_ADVANCED}\n`);
		const doneHere = INSTANCE_LINE.replace("- [ ]", "- [x]") + " ✅ 2026-08-04";
		const editedThere = `${INSTANCE_LINE} и созвон с командой`;
		port.files.set(INBOX, `${doneHere}\n`);
		port.files.set(OTHER, `${editedThere}\n`);
		sync();

		const report = await svc.runPass();

		expect(report.deduped).toBe(0);
		const expected = feed
			.getIndex()
			.resolveDep("rev-prio-20260731")
			.map((t) => t.key)
			.sort();
		expect([...report.conflicts].sort()).toEqual(expected);
		expect(port.files.get(INBOX)).toBe(`${doneHere}\n`);
		expect(port.files.get(OTHER)).toBe(`${editedThere}\n`);
	});

	it("шаблон удалён → канон невоспроизводим, группа целиком в конфликтах", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-05";
		// REC отсутствует: шаблона rev-prio больше нет
		port.files.set(INBOX, `${INSTANCE_LINE}\n`);
		port.files.set(OTHER, `${INSTANCE_LINE}\n`);
		sync();

		const report = await svc.runPass();

		expect(report.deduped).toBe(0);
		expect(report.conflicts).toHaveLength(2);
		expect(port.files.get(INBOX)).toBe(`${INSTANCE_LINE}\n`);
		expect(port.files.get(OTHER)).toBe(`${INSTANCE_LINE}\n`);
	});

	it("дубль пользовательских 🆔 (не по паттерну копии, без 🧬) дедупом не трогается", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-05";
		port.files.set(INBOX, "- [ ] раз 🆔 shared\n");
		port.files.set(OTHER, "- [ ] два 🆔 shared\n");
		sync();

		const report = await svc.runPass();

		expect(report).toEqual({ spawned: 0, advanced: 0, deduped: 0, conflicts: [], errors: [] });
		expect(port.files.get(INBOX)).toBe("- [ ] раз 🆔 shared\n");
	});
});

describe("RecurrenceService: spawnNow", () => {
	it("спавнит копию на сегодня; офсеты — от сегодняшней даты; курсор не тронут", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		const res = await svc.spawnNow("id:rev-prio");

		expect(res).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe(
			"- [ ] Ревью приоритетов #review 🛫 2026-07-12 ➕ 2026-07-15 🧬 rev-prio 🆔 rev-prio-20260715\n",
		);
		expect(port.files.get(REC)).toBe(`${TPL_LINE}\n`); // 🔜 2026-07-31 как был
	});

	it("повторный spawnNow (id занят) → {ok:false}: и по содержимому, и по индексу", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();
		await svc.spawnNow("id:rev-prio");

		// индекс ещё не видел копию — ловит повторная проверка содержимого
		const byContent = await svc.spawnNow("id:rev-prio");
		expect(byContent).toEqual({ ok: false, reason: "already-spawned" });

		sync(); // теперь копию видит индекс — отказ ещё до записи
		const callsBefore = port.calls;
		const byIndex = await svc.spawnNow("id:rev-prio");
		expect(byIndex).toEqual({ ok: false, reason: "already-spawned" });
		expect(port.calls).toBe(callsBefore);
		expect(port.files.get(INBOX)!.split("rev-prio-20260715")).toHaveLength(2);
	});

	it("spawn-now у шаблона «от выполнения» даёт НЕДАТИРОВАННУЮ копию (§FIX-1)", async () => {
		// синтетический план spawn-now календарный (DAILY_RULE), поэтому вычистка
		// фиксированных дат мигранта Tasks шла мимо — ручная копия рождалась с
		// замороженной, уже просроченной 📅 и не совпадала с canonicalLine.
		const { port, svc, sync } = makeHarness({ today: "2026-07-25" });
		port.files.set(
			REC,
			"- [ ] Полить цветы 🔁 every 3 days when done 📅 2026-07-21 #дом 🆔 flowers\n",
		);
		sync();

		expect(await svc.spawnNow("id:flowers")).toEqual({ ok: true });
		expect(port.files.get(INBOX)).toBe(
			"- [ ] Полить цветы #дом ➕ 2026-07-25 🧬 flowers 🆔 flowers-20260725\n",
		);
	});

	it("не-шаблон и неизвестный ключ отклоняются", async () => {
		const { port, svc, sync, feed } = makeHarness();
		port.files.set(INBOX, "- [ ] обычная задача 🆔 plain1\n");
		sync();
		const plainKey = feed.getIndex().fileTasks(INBOX)[0]!.key;

		expect(await svc.spawnNow(plainKey)).toEqual({ ok: false, reason: "not-a-template" });
		expect(await svc.spawnNow("нет такого")).toEqual({ ok: false, reason: "task-not-found" });
	});
});

describe("RecurrenceService: pause / resume", () => {
	it("pause ставит '-', resume возвращает ' ' и снапит 🔜 = nextOccurrence(rule, today)", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15" });
		// курсор протух (2026-04-30) — resume обязан снапнуть вперёд, пропустив дыру
		port.files.set(
			REC,
			"- [ ] Ревью приоритетов #review 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-04-30\n",
		);
		sync();

		await svc.pause("id:rev-prio");
		expect(port.files.get(REC)).toBe(
			"- [-] Ревью приоритетов #review 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-04-30\n",
		);

		sync();
		await svc.resume("id:rev-prio");
		expect(port.files.get(REC)).toBe(
			"- [ ] Ревью приоритетов #review 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-07-31\n",
		);
	});

	it("пауза выключает шаблон для runPass (ноль спавнов)", async () => {
		const { port, svc, sync, state } = makeHarness();
		state.today = "2026-08-03";
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();
		await svc.pause("id:rev-prio");
		sync();

		const report = await svc.runPass();

		expect(report).toEqual({ spawned: 0, advanced: 0, deduped: 0, conflicts: [], errors: [] });
		expect(port.files.has(INBOX)).toBe(false);
	});
});

describe("RecurrenceService: setRule", () => {
	it("ошибка парсинга → {ok:false, parseError}, ноль записей", async () => {
		const { port, svc, sync } = makeHarness();
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		const res = await svc.setRule("id:rev-prio", "когда-нибудь потом");

		expect(res.ok).toBe(false);
		expect(res.parseError).toContain("every");
		expect(port.writes).toHaveLength(0);
	});

	it("правит текст 🔁 на месте и снапит 🔜 = nextOccurrence(new, today)", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		const res = await svc.setRule("id:rev-prio", "every week on friday");

		expect(res).toEqual({ ok: true });
		// 2026-07-15 — среда; ближайшая пятница — 2026-07-17
		expect(port.files.get(REC)).toBe(
			"- [ ] Ревью приоритетов #review 🔁 every week on friday 🛫 -3d 🆔 rev-prio 🔜 2026-07-17\n",
		);
	});

	it("черновик без 🔁 получает поле правила; 🔜 снапится следом", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, "- [ ] Черновик 🆔 drf\n");
		sync();

		const res = await svc.setRule("id:drf", "every day");

		expect(res).toEqual({ ok: true });
		expect(port.files.get(REC)).toBe("- [ ] Черновик 🆔 drf 🔁 every day 🔜 2026-07-16\n");
	});

	it("многострочный текст правила отклоняется до записи", async () => {
		const { port, svc, sync } = makeHarness();
		port.files.set(REC, `${TPL_LINE}\n`);
		sync();

		const res = await svc.setRule("id:rev-prio", "every day\nuntil 2027-01-01");

		expect(res.ok).toBe(false);
		expect(port.writes).toHaveLength(0);
	});

	it("неизвестный ключ → {ok:false} без parseError", async () => {
		const { svc } = makeHarness();
		const res = await svc.setRule("нет такого", "every day");
		expect(res.ok).toBe(false);
		expect(res.parseError).toBeUndefined();
	});
});

describe("RecurrenceService: правила «от выполнения» (§every!)", () => {
	const FLOWERS = "- [ ] Полить цветы 🔁 every! 3 days 🆔 flowers";

	/** Отметить копию выполненной в указанную дату (как это сделал бы пользователь). */
	function complete(line: string, doneDate: string): string {
		return line.replace("- [ ]", "- [x]") + ` ✅ ${doneDate}`;
	}

	it("полный цикл: bootstrap → выполнение → следующий спавн от даты ✅", async () => {
		const { port, svc, sync, state } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, `${FLOWERS}\n`);
		sync();

		// проход 1: bootstrap — одна копия сегодня, курсор встал на сегодня
		const r1 = await svc.runPass();
		expect(r1.spawned).toBe(1);
		const copy = port.files.get(INBOX)!.trim();
		expect(copy).toBe("- [ ] Полить цветы ➕ 2026-07-15 🧬 flowers 🆔 flowers-20260715");
		expect(port.files.get(REC)).toContain("🔜 2026-07-15");

		// пользователь выполнил копию сегодня же
		port.files.set(INBOX, `${complete(copy, "2026-07-15")}\n`);
		sync();

		// проход 2: последняя копия выполнена → 🔜 = 2026-07-15 + 3 = 2026-07-18, без новой копии
		const r2 = await svc.runPass();
		expect(r2.spawned).toBe(0);
		expect(port.files.get(REC)).toContain("🔜 2026-07-18");

		// день следующего спавна наступил
		state.today = "2026-07-18";
		const r3 = await svc.runPass();
		expect(r3.spawned).toBe(1);
		expect(port.files.get(INBOX)).toContain("🆔 flowers-20260718");
		// ровно одна новая копия — исходная выполненная на месте
		expect(port.files.get(INBOX)!.split("🧬 flowers").length - 1).toBe(2);
	});

	it("невыполненная копия не плодит новые (сколько бы дней ни прошло) + двойной проход", async () => {
		const { port, svc, sync, state } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, `${FLOWERS}\n`);
		sync();
		await svc.runPass(); // копия на 2026-07-15, НЕ выполнена
		sync();

		// проход через неделю: копия всё ещё висит невыполненной → ноль новых
		state.today = "2026-07-22";
		const r = await svc.runPass();
		expect(r.spawned).toBe(0);
		expect(port.files.get(INBOX)!.split("🧬 flowers").length - 1).toBe(1); // ровно одна копия

		// двойной проход подряд — тоже без дублей
		sync();
		const r2 = await svc.runPass();
		expect(r2.spawned).toBe(0);
		expect(port.files.get(INBOX)!.split("🧬 flowers").length - 1).toBe(1);
	});

	it("выполнение с опозданием: следующий отсчитывается от фактической даты ✅", async () => {
		const { port, svc, sync, state } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, `${FLOWERS}\n`);
		sync();
		const r1 = await svc.runPass();
		const copy = port.files.get(INBOX)!.trim();
		expect(r1.spawned).toBe(1);

		// выполнил только 2026-07-20 (опоздал)
		state.today = "2026-07-20";
		port.files.set(INBOX, `${complete(copy, "2026-07-20")}\n`);
		sync();

		const r2 = await svc.runPass();
		expect(r2.spawned).toBe(0);
		// 2026-07-20 + 3 = 2026-07-23 (от выполнения, не от календарной сетки 07-15)
		expect(port.files.get(REC)).toContain("🔜 2026-07-23");
	});

	it("setRule на «every!» снапит 🔜 на сегодня (первый спавн — следующим проходом)", async () => {
		const { port, svc, sync } = makeHarness({ today: "2026-07-15" });
		port.files.set(REC, "- [ ] Полить цветы 🆔 flowers\n");
		sync();

		const res = await svc.setRule("id:flowers", "every! 3 days");

		expect(res).toEqual({ ok: true });
		expect(port.files.get(REC)).toBe(
			"- [ ] Полить цветы 🆔 flowers 🔁 every! 3 days 🔜 2026-07-15\n",
		);
	});
});

// ---------------------------------------------------------------------------
// Спавн по пространству ШАБЛОНА (spawnTargetFor)
// ---------------------------------------------------------------------------

describe("RecurrenceService: единый inbox для всех шаблонов", () => {
	const WORK_REC = "Work/Регулярные.md";
	const LIFE_REC = "Личное/Регулярные.md";
	const WORK_INBOX = "Work/Входящие.md";
	const LIFE_INBOX = "Личное/Входящие.md";
	const GLOBAL_INBOX = "GTD/Inbox.md";

	const GLOBAL_REC = "Разное/Регулярные.md";

	/** recurringPaths — какие файлы индексатор помечает контейнером recurring. */
	function makeNsHarness(today: IsoDate, recurringPaths: readonly string[]) {
		const port = new FakePort();
		const feed = new FakeFeed();
		const writeback = new WritebackService({ write: port, feed, autoInjectId: false });
		const dispatcher = new FailingCursorDispatcher(writeback);
		const recSet = new Set(recurringPaths);
		const svc = new RecurrenceService({
			feed,
			write: port,
			dispatcher,
			settings: () => ({ inboxFile: GLOBAL_INBOX, catchUp: "latest", catchUpCap: 30 }),
			todayIso: () => today,
			indexReady: () => true,
			ensureFile: async (path) => {
				if (!port.files.has(path)) port.files.set(path, "");
			},
		});
		const sync = () => {
			for (const [path, content] of port.files) {
				feed.replaceFile(
					path,
					parseFile(path, content, recSet.has(path) ? "recurring" : "plain"),
				);
			}
		};
		return { port, feed, svc, sync };
	}

	it("копии двух шаблонов уходят в единый inbox", async () => {
		const { port, svc, sync } = makeNsHarness("2026-07-15", [WORK_REC, LIFE_REC]);
		port.files.set(WORK_REC, "- [ ] Отчёт 🔁 every day 🆔 work-tpl 🔜 2026-07-15\n");
		port.files.set(LIFE_REC, "- [ ] Зарядка 🔁 every day 🆔 life-tpl 🔜 2026-07-15\n");
		sync();

		const report = await svc.runPass();

		expect(report.spawned).toBe(2);
		expect(report.errors).toEqual([]);
		expect(port.files.get(GLOBAL_INBOX)).toContain("work-tpl-20260715");
		expect(port.files.get(GLOBAL_INBOX)).toContain("life-tpl-20260715");
		expect(port.files.has(WORK_INBOX)).toBe(false);
		expect(port.files.has(LIFE_INBOX)).toBe(false);
	});

	it("spawnNow пишет в единый inbox", async () => {
		const { port, svc, sync } = makeNsHarness("2026-07-15", [WORK_REC]);
		port.files.set(WORK_REC, "- [ ] Отчёт 🔁 every day 🆔 work-tpl 🔜 2026-07-15\n");
		sync();

		const res = await svc.spawnNow("id:work-tpl");

		expect(res.ok).toBe(true);
		expect(port.files.get(GLOBAL_INBOX)).toContain("work-tpl-20260715");
		expect(port.files.has(WORK_INBOX)).toBe(false);
	});

	it("шаблон вне прежних корней также спавнит в единый inbox", async () => {
		const { port, svc, sync } = makeNsHarness("2026-07-15", [GLOBAL_REC]);
		port.files.set(GLOBAL_REC, "- [ ] Общая 🔁 every day 🆔 gen-tpl 🔜 2026-07-15\n");
		sync();

		const report = await svc.runPass();

		expect(report.spawned).toBe(1);
		expect(port.files.get(GLOBAL_INBOX)).toContain("gen-tpl-20260715");
		expect(port.files.has(WORK_INBOX)).toBe(false);
		expect(port.files.has(LIFE_INBOX)).toBe(false);
	});
});
