import { describe, expect, it } from "vitest";
import type { IcsCalendarSub } from "../settings/Settings";
import {
	mirrorPath,
	SyncService,
	safeMirrorFileName,
	subIdSlug,
	type ManagedMirror,
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
	async listManagedMirrors(): Promise<readonly ManagedMirror[]> {
		return [...this.files.entries()]
			.filter(([, content]) => content.includes("gtd-external: true"))
			.map(([path, content]) => ({
				path,
				subscriptionId: content.match(/^gtd-external-id: "([^"]+)"$/m)?.[1] ?? null,
			}));
	}
}

const ICS_ONE_EVENT =
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n" +
	"BEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Встреча\r\nDTSTART:20260716T120000\r\nDTEND:20260716T130000\r\nEND:VEVENT\r\n" +
	"END:VCALENDAR";

function sub(over: Partial<IcsCalendarSub> = {}): IcsCalendarSub {
	return {
		id: "s1",
		name: "Календарь",
		url: "https://example/basic.ics",
		lastSyncAt: null,
		lastError: null,
		errorCode: null,
		...over,
	};
}

interface Harness {
	fetchImpl: (url: string) => Promise<string>;
	subs: IcsCalendarSub[];
	inertIds: string[];
	inboxFile: string;
	feedTimeoutMs?: number;
	warnings: string[];
}

function makeService(over: Partial<Harness> = {}) {
	const vault = new FakeVault();
	const results: Array<{ id: string; result: SyncResult }> = [];
	const h: Harness = {
		fetchImpl: async () => ICS_ONE_EVENT,
		subs: [sub()],
		inertIds: [],
		inboxFile: "GTD/Inbox.md",
		warnings: [],
		...over,
	};
	const svc = new SyncService({
		fetch: (url) => h.fetchImpl(url),
		vault,
		clock: { now: () => new Date(2026, 6, 15) }, // фикс: окно и даты детерминированы
		subscriptions: () => h.subs,
		inertSubscriptionIds: () => h.inertIds,
		inboxFile: () => h.inboxFile,
		intervalMin: () => 5,
		feedTimeoutMs: () => h.feedTimeoutMs ?? 30_000,
		onResult: (id, result) => {
			// как main (applySyncResult): персистится только санитизированный код
			const s = h.subs.find((x) => x.id === id);
			if (s !== undefined) {
				if (result.ok) {
					s.lastSyncAt = result.at;
					s.lastError = null;
					s.errorCode = null;
				} else {
					s.errorCode = result.code;
					s.lastError = null;
				}
			}
			results.push({ id, result });
		},
		onLifecycleWarning: (message) => h.warnings.push(message),
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
		// не бросает; терминальный отчёт честно говорит «error», а не молчит
		await expect(svc.syncAll()).resolves.toMatchObject({ status: "error" });
		expect(vault.writes).toBe(0);
		expect(results[0]!.result).toMatchObject({ ok: false });
		expect(h.subs[0]!.errorCode).toBe("network_error");
		expect(h.subs[0]!.lastError).toBeNull(); // сырой текст не персистится
		expect(results[0]!.result).toMatchObject({ ok: false, code: "network_error" });
	});

	it("битая лента (не ICS) → статус ошибки, без записи", async () => {
		const { svc, vault, h } = makeService({ fetchImpl: async () => "это не ICS" });
		await svc.syncAll();
		expect(vault.writes).toBe(0);
		expect(h.subs[0]!.errorCode).toBe("invalid_calendar_data");
	});

	it("пустой URL → ошибка статуса, сети не касаемся", async () => {
		let fetched = false;
		const { svc, h, results } = makeService({
			subs: [sub({ url: "  " })],
			fetchImpl: async () => {
				fetched = true;
				return ICS_ONE_EVENT;
			},
		});
		await svc.syncAll();
		expect(fetched).toBe(false);
		expect(h.subs[0]!.errorCode).toBe("unknown");
		const failed = results[0]!.result;
		expect(failed.ok === false && failed.detail).toContain("адрес");
	});

	it("syncById синхронизирует одну подписку по id", async () => {
		const { svc, vault } = makeService({
			subs: [sub({ id: "a" }), sub({ id: "b", name: "Второй" })],
		});
		await svc.syncById("b");
		expect(vault.writes).toBe(1);
		expect([...vault.files.keys()]).toEqual([`GTD/External/Второй-${subIdSlug("b")}.md`]);
	});
});

describe("mirrorPath / safeMirrorFileName", () => {
	it("uses the parent of the unified inbox", () => {
		expect(mirrorPath(sub({ name: "Личный" }), "GTD/Inbox.md")).toBe(
			`GTD/External/Личный-${subIdSlug("s1")}.md`,
		);
		expect(mirrorPath(sub({ name: "Рабочий" }), "Areas/Work/Inbox.md")).toBe(
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

	// Второй caller разделяет активный promise, а не получает ложный успешный no-op.
	it("конкурентный syncById той же подписки во время висящего fetch ждёт тот же проход", async () => {
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
		const p2 = svc.syncById("s1"); // конкурентный клик ждёт существующий проход
		let secondSettled = false;
		void p2.then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		expect(fetchCalls).toBe(1); // второй syncOne не запущен
		expect(secondSettled).toBe(false);
		release(ICS_ONE_EVENT);
		await Promise.all([p1, p2]);
		expect(fetchCalls).toBe(1);
		expect(vault.writes).toBe(1);
		expect(results.filter((r) => !r.result.ok)).toHaveLength(0); // без ложной ошибки гонки
	});

	it("configuration change during active sync promptly runs a fresh generation", async () => {
		let releaseOld!: (value: string) => void;
		const oldGate = new Promise<string>((resolve) => {
			releaseOld = resolve;
		});
		const urls: string[] = [];
		const s = sub({ id: "generation-race", name: "Before", url: "https://example/old.ics" });
		const { svc, vault } = makeService({
			subs: [s],
			fetchImpl: async (url) => {
				urls.push(url);
				return urls.length === 1 ? oldGate : ICS_ONE_EVENT;
			},
		});

		const active = svc.syncAll();
		await Promise.resolve();
		s.name = "After";
		s.url = "https://example/new.ics";
		svc.configurationChanged();
		releaseOld(ICS_ONE_EVENT);
		await active;

		expect(urls).toEqual(["https://example/old.ics", "https://example/new.ics"]);
		expect(vault.writes).toBe(1);
		expect([...vault.files.keys()]).toEqual([
			`GTD/External/After-${subIdSlug("generation-race")}.md`,
		]);
		svc.dispose();
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

describe("SyncService — deadlines and mirror lifecycle hardening", () => {
	it("a timed-out feed is reported while a healthy feed completes in the same shared syncAll pass", async () => {
		let calls = 0;
		const { svc, vault, results } = makeService({
			subs: [
				sub({ id: "slow" }),
				sub({ id: "fast", name: "Healthy", url: "https://example/fast.ics" }),
			],
			feedTimeoutMs: 10,
			fetchImpl: async (url) => {
				calls++;
				if (url.includes("basic")) return new Promise<string>(() => undefined);
				return ICS_ONE_EVENT;
			},
		});

		await Promise.all([svc.syncAll(), svc.syncAll()]);
		expect(calls).toBe(2); // duplicate syncAll shared its active pass
		expect(vault.files.has(`GTD/External/Healthy-${subIdSlug("fast")}.md`)).toBe(true);
		expect(results.find((r) => r.id === "slow")!.result).toMatchObject({ ok: false });
		expect(results.find((r) => r.id === "slow")!.result).toMatchObject({
			code: "timeout",
			detail: expect.stringContaining("timed out"),
		});
		expect(results.find((r) => r.id === "fast")!.result).toMatchObject({ ok: true });
	});

	it("deletion tombstone fences a delayed fetch so it cannot resurrect the trashed mirror", async () => {
		let release!: (text: string) => void;
		const gate = new Promise<string>((resolve) => {
			release = resolve;
		});
		const s = sub({ id: "delete-race" });
		const { svc, vault, h, results } = makeService({ subs: [s], fetchImpl: async () => gate });
		const pending = svc.syncById(s.id);
		await Promise.resolve();
		await svc.removeSubscription(s);
		h.subs.splice(0, 1);
		release(ICS_ONE_EVENT);
		await pending;
		expect(vault.files.size).toBe(0);
		expect(results).toHaveLength(0);
	});

	it("failed removal rollback clears its tombstone so syncById can resume", async () => {
		const s = sub({ id: "restore-after-save-failure" });
		const { svc, vault, results } = makeService({ subs: [s] });

		// Settings persistence failed after removeSubscription completed, so the
		// restored settings still contain this exact subscription.
		await svc.removeSubscription(s);
		svc.rollbackSubscriptionRemoval(s.id);
		await svc.syncById(s.id);

		expect(vault.writes).toBe(1);
		expect(results.at(-1)).toMatchObject({ id: s.id, result: { ok: true } });
		svc.dispose();
	});

	it("path-affecting configuration change trashes the old stable-id mirror and writes exactly one new one", async () => {
		const s = sub({ id: "move-root", name: "Relocate" });
		const { svc, vault, h } = makeService({ subs: [s] });
		await svc.syncAll();
		const oldPath = `GTD/External/Relocate-${subIdSlug(s.id)}.md`;
		expect(vault.files.get(oldPath)).toContain('gtd-external-id: "move-root"');

		h.inboxFile = "Elsewhere/Inbox.md";
		svc.configurationChanged();
		await svc.reconcileMirrors();
		await svc.syncAll();

		const newPath = `Elsewhere/External/Relocate-${subIdSlug(s.id)}.md`;
		expect(vault.deletes).toContain(oldPath);
		expect(vault.files.has(oldPath)).toBe(false);
		expect(vault.files.has(newPath)).toBe(true);
		expect(vault.files.size).toBe(1);
	});

	it("startup reconciliation removes an orphan with a stable subscription marker and reports it", async () => {
		const { svc, vault, h } = makeService({ subs: [] });
		vault.files.set(
			"GTD/External/orphan.md",
			'---\ngtd-events: true\ngtd-external: true\ngtd-external-id: "removed-sub"\n---\n',
		);
		await svc.reconcileMirrors();
		expect(vault.files.has("GTD/External/orphan.md")).toBe(false);
		expect(h.warnings.join("\n")).toContain("removed-sub");
	});

	it("startup reconciliation preserves a pre-marker mirror at its current path, then upgrades it in place", async () => {
		const s = sub({ id: "legacy-current", name: "Legacy" });
		const { svc, vault, h } = makeService({ subs: [s] });
		const path = `GTD/External/Legacy-${subIdSlug(s.id)}.md`;
		vault.files.set(path, "---\ngtd-events: true\ngtd-external: true\n---\nold\n");
		await svc.reconcileMirrors();
		expect(vault.files.has(path)).toBe(true);
		expect(h.warnings.join("\n")).toContain("Will add stable id");
		await svc.syncAll();
		expect(vault.files.get(path)).toContain('gtd-external-id: "legacy-current"');
		expect(vault.files.size).toBe(1);
	});
});

describe("SyncService — инертные (повреждённые) записи подписок", () => {
	it("зеркало инертной записи защищено от orphan-очистки, пока запись существует", async () => {
		const { svc, vault, h } = makeService({ subs: [], inertIds: ["broken-1"] });
		const orphan =
			'---\ngtd-events: true\ngtd-external: true\ngtd-external-id: "broken-1"\n---\n';
		vault.files.set("GTD/External/Битый-000000.md", orphan);
		await svc.reconcileMirrors();
		expect(vault.files.has("GTD/External/Битый-000000.md")).toBe(true);
		expect(vault.deletes).toEqual([]);
		expect(h.warnings.join("\n")).toContain("invalid subscription record broken-1");
	});

	it("после удаления инертной записи её зеркало уходит в recoverable-очистку", async () => {
		const { svc, vault } = makeService({ subs: [], inertIds: [] });
		const orphan =
			'---\ngtd-events: true\ngtd-external: true\ngtd-external-id: "broken-1"\n---\n';
		vault.files.set("GTD/External/Битый-000000.md", orphan);
		await svc.reconcileMirrors();
		expect(vault.files.has("GTD/External/Битый-000000.md")).toBe(false);
		expect(vault.deletes).toEqual(["GTD/External/Битый-000000.md"]);
	});

	it("caldav-подписка до появления провайдера не делает ни запросов, ни записей", async () => {
		let fetches = 0;
		const { svc, vault, results, h } = makeService({ subs: [] });
		h.fetchImpl = async () => {
			fetches++;
			return ICS_ONE_EVENT;
		};
		const caldavSub = {
			kind: "caldav" as const,
			id: "cd-1",
			name: "Работа",
			accountId: "acc-1",
			collectionKey: "col-1",
			privacy: "details" as const,
			enabled: true,
			scopeId: null,
			pendingRedaction: false,
			lastSyncAt: null,
			lastError: null,
			errorCode: null,
		};
		// Harness типизирован под ics; сервис принимает объединение ActiveCalendarSub.
		h.subs = [caldavSub as unknown as ReturnType<typeof sub>];
		await svc.syncAll();
		expect(fetches).toBe(0);
		expect(vault.writes).toBe(0);
		expect(results).toEqual([]);
	});
});

describe("SyncService — терминальный отчёт (§10) и runtime-статусы (§9)", () => {
	it("ok/partial/error агрегируются честно; changedMirrors считает записи", async () => {
		const good = sub({ id: "a", name: "A" });
		const bad = sub({ id: "b", name: "B", url: "https://example/b.ics" });
		const { svc, h } = makeService({ subs: [good, bad] });
		h.fetchImpl = async (url) => {
			if (url.endsWith("b.ics")) throw new Error("сеть недоступна");
			return ICS_ONE_EVENT;
		};
		const partial = await svc.syncAll();
		expect(partial.status).toBe("partial");
		expect(partial.changedMirrors).toBe(1);
		expect(partial.subscriptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "a", status: "ok", errorCode: null }),
				expect.objectContaining({ id: "b", status: "error", errorCode: "network_error" }),
			]),
		);
		expect(partial.finishedAt).toBeGreaterThanOrEqual(partial.startedAt);

		h.fetchImpl = async () => {
			throw new Error("всё лежит");
		};
		expect((await svc.syncAll()).status).toBe("error");

		h.fetchImpl = async () => ICS_ONE_EVENT;
		const ok = await svc.syncAll();
		expect(ok.status).toBe("ok");
		// Повторный идентичный проход: без записей, статусы unchanged.
		const idle = await svc.syncAll();
		expect(idle.status).toBe("ok");
		expect(idle.changedMirrors).toBe(0);
		expect(idle.subscriptions.every((s) => s.status === "unchanged")).toBe(true);
	});

	it("caldav-подписка получает skipped-запись отчёта, не считаясь ошибкой", async () => {
		const caldavSub = {
			kind: "caldav" as const,
			id: "cd-1",
			name: "Работа",
			accountId: "acc-1",
			collectionKey: "col-1",
			privacy: "details" as const,
			enabled: true,
			scopeId: null,
			pendingRedaction: false,
			lastSyncAt: 777,
			lastError: null,
			errorCode: null,
		};
		const { svc, h } = makeService();
		h.subs = [sub(), caldavSub as unknown as ReturnType<typeof sub>];
		const report = await svc.syncAll();
		expect(report.status).toBe("ok");
		expect(report.subscriptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "cd-1", status: "skipped", lastSuccessAt: 777 }),
			]),
		);
	});

	it("совпадающие вызовы syncAll разделяют ОДИН отчёт; syncById отдаёт запись", async () => {
		const { svc } = makeService();
		const [r1, r2] = await Promise.all([svc.syncAll(), svc.syncAll()]);
		expect(r1).toBe(r2);
		const entry = await svc.syncById("s1");
		expect(entry).toMatchObject({ id: "s1", status: "unchanged", errorCode: null });
		expect(await svc.syncById("no-such")).toBeNull();
	});

	it("runtime-статусы: neverAttempted → syncing → okChanged/okUnchanged/error", async () => {
		let release: (v: string) => void = () => undefined;
		const gate = new Promise<string>((resolve) => (release = resolve));
		const { svc, h } = makeService({ fetchImpl: () => gate });
		expect(svc.runtimeStatus("s1").state).toBe("neverAttempted");
		const pass = svc.syncAll();
		await Promise.resolve();
		expect(svc.runtimeStatus("s1").state).toBe("syncing");
		release(ICS_ONE_EVENT);
		await pass;
		expect(svc.runtimeStatus("s1")).toMatchObject({ state: "okChanged", errorCode: null });
		await svc.syncAll();
		expect(svc.runtimeStatus("s1").state).toBe("okUnchanged");
		h.fetchImpl = async () => {
			throw new Error("сеть недоступна");
		};
		await svc.syncAll();
		expect(svc.runtimeStatus("s1")).toMatchObject({
			state: "error",
			errorCode: "network_error",
		});
	});
});
