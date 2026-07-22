import { describe, expect, it } from "vitest";
import { DEFAULT_NS, type NamespaceDef } from "../core/namespace/namespace";
import type { ExternalCalendarSub } from "../settings/Settings";
import {
	mirrorPath,
	SyncService,
	safeMirrorFileName,
	subIdSlug,
	type SyncResult,
	type SyncVaultPort,
} from "./SyncService";

class FakeVault implements SyncVaultPort {
	files = new Map<string, string>();
	writes = 0;
	deletes: string[] = [];
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async write(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		this.writes++;
	}
	async delete(path: string): Promise<void> {
		this.deletes.push(path);
		this.files.delete(path);
	}
}

const ICS_ONE_EVENT =
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n" +
	"BEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Встреча\r\nDTSTART:20260716T120000\r\nDTEND:20260716T130000\r\nEND:VEVENT\r\n" +
	"END:VCALENDAR";

function sub(over: Partial<ExternalCalendarSub> = {}): ExternalCalendarSub {
	return {
		id: "s1",
		name: "Календарь",
		url: "https://example/basic.ics",
		namespace: DEFAULT_NS,
		lastSyncAt: null,
		lastError: null,
		...over,
	};
}

interface Harness {
	fetchImpl: (url: string) => Promise<string>;
	subs: ExternalCalendarSub[];
	defs: NamespaceDef[];
	commonRoot: string;
}

function makeService(over: Partial<Harness> = {}) {
	const vault = new FakeVault();
	const results: Array<{ id: string; result: SyncResult }> = [];
	const h: Harness = {
		fetchImpl: async () => ICS_ONE_EVENT,
		subs: [sub()],
		defs: [],
		commonRoot: "GTD",
		...over,
	};
	const svc = new SyncService({
		fetch: (url) => h.fetchImpl(url),
		vault,
		clock: { now: () => new Date(2026, 6, 15) }, // фикс: окно и даты детерминированы
		subscriptions: () => h.subs,
		namespaces: () => h.defs,
		commonRoot: () => h.commonRoot,
		intervalMin: () => 5,
		onResult: (id, result) => {
			// как main: пишем статус в саму подписку
			const s = h.subs.find((x) => x.id === id);
			if (s !== undefined) {
				if (result.ok) {
					s.lastSyncAt = result.at;
					s.lastError = null;
				} else s.lastError = result.error;
			}
			results.push({ id, result });
		},
	});
	return { svc, vault, results, h };
}

describe("SyncService — запись только при изменении", () => {
	it("первый проход пишет файл-зеркало; повтор с той же лентой НЕ пишет", async () => {
		const { svc, vault } = makeService();
		await svc.syncAll();
		expect(vault.writes).toBe(1);
		const path = `GTD/External/Календарь-${subIdSlug("s1")}.md`;
		expect(vault.files.get(path)).toContain("gtd-external: true");
		expect(vault.files.get(path)).toContain("Встреча");

		await svc.syncAll();
		expect(vault.writes).toBe(1); // содержимое не изменилось — повторной записи нет
	});

	it("изменившаяся лента вызывает перезапись", async () => {
		const h: Partial<Harness> = { fetchImpl: async () => ICS_ONE_EVENT };
		const { svc, vault, h: harness } = makeService(h);
		await svc.syncAll();
		expect(vault.writes).toBe(1);
		// лента поменялась (другое событие) → контент изменился → перезапись
		harness.fetchImpl = async () =>
			ICS_ONE_EVENT.replace("SUMMARY:Встреча", "SUMMARY:Другая встреча");
		await svc.syncAll();
		expect(vault.writes).toBe(2);
	});
});

describe("SyncService — статус и устойчивость", () => {
	it("успех: onResult ok с меткой времени, lastError сброшен", async () => {
		const { svc, results, h } = makeService();
		await svc.syncAll();
		expect(results).toHaveLength(1);
		expect(results[0]!.result).toEqual({ ok: true, at: new Date(2026, 6, 15).getTime() });
		expect(h.subs[0]!.lastError).toBeNull();
		expect(h.subs[0]!.lastSyncAt).toBe(new Date(2026, 6, 15).getTime());
	});

	it("ошибка сети НЕ бросается наружу — пишется в статус подписки", async () => {
		const { svc, vault, results, h } = makeService({
			fetchImpl: async () => {
				throw new Error("сеть недоступна");
			},
		});
		await expect(svc.syncAll()).resolves.toBeUndefined(); // не бросает
		expect(vault.writes).toBe(0);
		expect(results[0]!.result).toMatchObject({ ok: false });
		expect(h.subs[0]!.lastError).toContain("сеть недоступна");
	});

	it("битая лента (не ICS) → статус ошибки, без записи", async () => {
		const { svc, vault, h } = makeService({ fetchImpl: async () => "это не ICS" });
		await svc.syncAll();
		expect(vault.writes).toBe(0);
		expect(h.subs[0]!.lastError).not.toBeNull();
	});

	it("пустой URL → ошибка статуса, сети не касаемся", async () => {
		let fetched = false;
		const { svc, h } = makeService({
			subs: [sub({ url: "  " })],
			fetchImpl: async () => {
				fetched = true;
				return ICS_ONE_EVENT;
			},
		});
		await svc.syncAll();
		expect(fetched).toBe(false);
		expect(h.subs[0]!.lastError).toContain("адрес");
	});

	it("syncById синхронизирует одну подписку по id", async () => {
		const { svc, vault } = makeService({ subs: [sub({ id: "a" }), sub({ id: "b", name: "Второй" })] });
		await svc.syncById("b");
		expect(vault.writes).toBe(1);
		expect([...vault.files.keys()]).toEqual([`GTD/External/Второй-${subIdSlug("b")}.md`]);
	});
});

describe("mirrorPath / safeMirrorFileName", () => {
	it("«Общее» → <commonRoot>/External/<имя>-<slug>.md; именованное → <root>/External/<имя>-<slug>.md", () => {
		const defs: NamespaceDef[] = [{ name: "Работа", root: "Areas/Work" }];
		expect(mirrorPath(sub({ namespace: DEFAULT_NS, name: "Личный" }), defs, "GTD")).toBe(
			`GTD/External/Личный-${subIdSlug("s1")}.md`,
		);
		expect(mirrorPath(sub({ namespace: "Работа", name: "Рабочий" }), defs, "GTD")).toBe(
			`Areas/Work/External/Рабочий-${subIdSlug("s1")}.md`,
		);
	});

	it("недопустимые символы в имени санируются", () => {
		expect(safeMirrorFileName("a/b:c*?")).not.toMatch(/[/:*?]/);
		expect(safeMirrorFileName("")).toBe("calendar");
	});

	// --- FIX-4: дубликат имён подписок → разные файлы (slug из id) ---
	it("две подписки с ОДИНАКОВЫМ именем → РАЗНЫЕ файлы (коллизии сняты by construction)", async () => {
		const a = sub({ id: "ext-aaaaaa-111", name: "Мой" });
		const b = sub({ id: "ext-bbbbbb-222", name: "Мой" });
		const { svc, vault } = makeService({ subs: [a, b] });
		await svc.syncAll();
		const paths = [...vault.files.keys()].sort();
		expect(paths).toHaveLength(2); // не один общий файл с вечной перезаписью
		expect(paths).toContain(`GTD/External/Мой-${subIdSlug("ext-aaaaaa-111")}.md`);
		expect(paths).toContain(`GTD/External/Мой-${subIdSlug("ext-bbbbbb-222")}.md`);
		expect(subIdSlug("ext-aaaaaa-111")).not.toBe(subIdSlug("ext-bbbbbb-222"));
	});

	it("subIdSlug — ровно 6 base36-символов, детерминирован", () => {
		expect(subIdSlug("s1")).toMatch(/^[0-9a-z]{6}$/);
		expect(subIdSlug("s1")).toBe(subIdSlug("s1"));
	});
});

describe("SyncService — webcal / CRLF / гонки / выгрузка", () => {
	// --- FIX-5: webcal:// → https:// ---
	it("webcal:// нормализуется в https:// перед запросом", async () => {
		let seenUrl = "";
		const { svc } = makeService({
			subs: [sub({ url: "webcal://example.com/basic.ics" })],
			fetchImpl: async (u) => {
				seenUrl = u;
				return ICS_ONE_EVENT;
			},
		});
		await svc.syncAll();
		expect(seenUrl).toBe("https://example.com/basic.ics");
	});

	// --- FIX-6: CRLF на диске, эквивалентный контент → без записи ---
	it("диск с CRLF, эквивалентный LF-контент → повторной записи нет", async () => {
		const { svc, vault } = makeService();
		await svc.syncAll();
		expect(vault.writes).toBe(1);
		const path = [...vault.files.keys()][0]!;
		// эмулируем sync-клиент/устройство, переписавшее файл в CRLF (контент тот же)
		vault.files.set(path, vault.files.get(path)!.replace(/\n/g, "\r\n"));
		await svc.syncAll();
		expect(vault.writes).toBe(1); // \r-различие не считается изменением
	});

	// --- FIX-9: syncById через per-sub гейт (нет двойного syncOne) ---
	it("конкурентный syncById той же подписки во время висящего fetch — второй пропускается", async () => {
		let fetchCalls = 0;
		let release!: (v: string) => void;
		const gate = new Promise<string>((res) => {
			release = res;
		});
		const { svc, vault, results } = makeService({
			fetchImpl: async () => {
				fetchCalls++;
				return gate;
			},
		});
		const p1 = svc.syncById("s1"); // стартует, висит на fetch (in-flight гейт занят)
		const p2 = svc.syncById("s1"); // конкурентный клик — должен пропуститься
		await p2;
		expect(fetchCalls).toBe(1); // второй syncOne не запущен
		release(ICS_ONE_EVENT);
		await p1;
		expect(fetchCalls).toBe(1);
		expect(vault.writes).toBe(1);
		expect(results.filter((r) => !r.result.ok)).toHaveLength(0); // без ложной ошибки гонки
	});

	// --- FIX-8: dispose во время висящего fetch → без записи и без статуса ---
	it("dispose во время подвешенного fetch — ни записи, ни статуса", async () => {
		let release!: (v: string) => void;
		const gate = new Promise<string>((res) => {
			release = res;
		});
		const { svc, vault, results } = makeService({ fetchImpl: async () => gate });
		const p = svc.syncById("s1"); // висит на fetch
		svc.dispose(); // выгрузка во время сети
		release(ICS_ONE_EVENT); // fetch резолвится уже после dispose
		await p;
		expect(vault.writes).toBe(0);
		expect(results).toHaveLength(0);
	});
});

describe("SyncService.deleteMirror (FIX-11)", () => {
	it("удаляет файл-зеркало по детерминированному пути (id+имя)", async () => {
		const s = sub({ id: "ext-xyz-9", name: "Удаляемый" });
		const { svc, vault } = makeService({ subs: [s] });
		await svc.syncAll();
		const path = `GTD/External/Удаляемый-${subIdSlug("ext-xyz-9")}.md`;
		expect(vault.files.has(path)).toBe(true);
		await svc.deleteMirror(s);
		expect(vault.deletes).toContain(path);
		expect(vault.files.has(path)).toBe(false);
	});

	it("переименование: удаляется зеркало под СТАРЫМ именем (осиротевшее)", async () => {
		const s = sub({ id: "ext-r-1", name: "Старое" });
		const { svc, vault } = makeService({ subs: [s] });
		await svc.syncAll();
		const oldPath = `GTD/External/Старое-${subIdSlug("ext-r-1")}.md`;
		expect(vault.files.has(oldPath)).toBe(true);
		// SettingsTab при смене имени зовёт deleteMirror со СТАРЫМ именем
		await svc.deleteMirror({ ...s, name: "Старое" });
		expect(vault.deletes).toContain(oldPath);
	});

	it("порт без delete — deleteMirror тихо ничего (не бросает)", async () => {
		const s = sub({ id: "ext-n-1", name: "Без порта" });
		const { svc, vault } = makeService({ subs: [s] });
		// эмулируем обёртку без поддержки удаления
		(vault as { delete?: unknown }).delete = undefined;
		await expect(svc.deleteMirror(s)).resolves.toBeUndefined();
	});
});
