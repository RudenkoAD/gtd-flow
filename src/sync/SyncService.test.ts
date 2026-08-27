import { describe, expect, it } from "vitest";
import type { CalDavAccount, CalDavCalendarSub, IcsCalendarSub } from "../settings/Settings";
import { ExternalSyncError } from "./externalSyncStatus";
import type { MirrorOccurrence, MirrorWindow } from "./icsParse";
import { buildMirrorFile } from "./mirrorBuilder";
import {
	caldavSourceKey,
	mirrorPath,
	SyncService,
	safeMirrorFileName,
	subIdSlug,
	type CalDavSourceRef,
	type ExternalOccurrenceProvider,
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
				sourceKey: content.match(/^gtd-external-source: "([^"]+)"$/m)?.[1] ?? null,
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
	/** CalDAV-провайдер (этап 4); отсутствует — caldav-подписки остаются skipped. */
	provider?: ExternalOccurrenceProvider;
	/** Гейт §4.2: существует ли активный scope; отсутствие деп — как «не существует». */
	scopeExists?: (scopeId: string) => boolean;
	/** Реестр CalDAV-аккаунтов, резолвящихся по CalDavCalendarSub.accountId. */
	accounts?: CalDavAccount[];
	/** Ids переданные в deps.onPendingRedactionCleared, записанные ДЕФОЛТНЫМ
	 *  рекордером (см. ниже); заполняется, только если `onPendingRedactionCleared`
	 *  сам не задан явно в `over` (тест-переопределение полностью заменяет запись). */
	pendingRedactionCleared: string[];
	/** Переопределение колбэка §4.3 (например, чтобы смоделировать сбой
	 *  персиста): когда задано, ПОЛНОСТЬЮ заменяет дефолтный рекордер выше. */
	onPendingRedactionCleared?: (id: string) => Promise<void> | void;
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
		pendingRedactionCleared: [],
		...over,
	};
	const svc = new SyncService({
		fetch: (url) => h.fetchImpl(url),
		vault,
		clock: { now: () => new Date(2026, 6, 15) }, // фикс: окно и даты детерминированы
		subscriptions: () => h.subs,
		accounts: () => h.accounts ?? [],
		caldavProvider: h.provider,
		scopeExists: h.scopeExists,
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
		onPendingRedactionCleared: (id) => {
			if (h.onPendingRedactionCleared !== undefined) return h.onPendingRedactionCleared(id);
			h.pendingRedactionCleared.push(id);
		},
		onLifecycleWarning: (message) => h.warnings.push(message),
	});
	return { svc, vault, results, h };
}

function caldavSub(over: Partial<CalDavCalendarSub> = {}): CalDavCalendarSub {
	return {
		kind: "caldav",
		id: "cd-1",
		name: "Работа",
		accountId: "acc-1",
		collectionKey: "col-1",
		privacy: "details",
		enabled: true,
		scopeId: null,
		pendingRedaction: false,
		lastSyncAt: null,
		lastError: null,
		errorCode: null,
		...over,
	};
}

function account(over: Partial<CalDavAccount> = {}): CalDavAccount {
	return {
		id: "acc-1",
		serverOrigin: "https://caldav.example",
		secretRef: "acc-1",
		...over,
	};
}

function occ(over: Partial<MirrorOccurrence> = {}): MirrorOccurrence {
	return {
		uid: "uid-1",
		recurrenceKey: "20260720T100000",
		date: "2026-07-20",
		allDay: false,
		startTime: "10:00",
		endTime: "11:00",
		title: "Встреча",
		location: "Zoom",
		dayIndex: 0,
		dayCount: 1,
		...over,
	};
}

/** Фейковый CalDAV-провайдер (§7 CalDAV-заказа): скриптуемый `load`, счётчик
 *  beginPass, и запись каждого вызова (источник + сигнал) для ассертов фенса. */
class FakeCaldavProvider implements ExternalOccurrenceProvider {
	beginPassCalls = 0;
	calls: Array<{ source: CalDavSourceRef; window: MirrorWindow; signal: AbortSignal }> = [];

	constructor(
		private readonly impl: (
			source: CalDavSourceRef,
			callIndex: number,
		) => Promise<readonly MirrorOccurrence[]>,
	) {}

	beginPass(): void {
		this.beginPassCalls++;
	}

	async load(
		source: CalDavSourceRef,
		window: MirrorWindow,
		opts: { deadlineAt: number; signal: AbortSignal },
	): Promise<readonly MirrorOccurrence[]> {
		const callIndex = this.calls.length;
		this.calls.push({ source, window, signal: opts.signal });
		return this.impl(source, callIndex);
	}
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

describe("SyncService — caldav-провайдер (этап 4)", () => {
	it("draft/disabled/redaction гейты: провайдер не вызывается, запись не идёт (включая полный проход syncAll())", async () => {
		const patches: Array<Partial<CalDavCalendarSub>> = [
			{ enabled: false },
			{ privacy: "unconfigured" },
			{ pendingRedaction: true },
		];
		for (const patch of patches) {
			const provider = new FakeCaldavProvider(async () => [occ()]);
			const s = caldavSub(patch);
			const { svc, vault, results } = makeService({
				subs: [s] as unknown as IcsCalendarSub[],
				provider,
				accounts: [account()],
				scopeExists: () => true,
			});
			const report = await svc.syncAll();
			expect(provider.calls).toHaveLength(0);
			expect(vault.writes).toBe(0);
			expect(results).toEqual([]); // skipped — не попытка, onResult не зовётся
			expect(report.subscriptions).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: s.id, status: "skipped" })]),
			);
		}
	});

	it("happy path (details): вхождения проецируются, санируются и получают 🆔/🧭", async () => {
		const provider = new FakeCaldavProvider(async () => [
			occ({ uid: "u1", date: "2026-07-20", title: "Встреча https://zoom.example/j/1" }),
			occ({
				uid: "u2",
				date: "2026-07-21",
				recurrenceKey: "20260721T090000",
				title: "Планёрка",
			}),
		]);
		const s = caldavSub({ id: "cd-1", scopeId: "work" });
		const { svc, vault, results } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
			scopeExists: (id) => id === "work",
		});
		const report = await svc.syncAll();
		expect(provider.calls).toHaveLength(1);
		expect(vault.writes).toBe(1);
		const path = mirrorPath(s, "GTD/Inbox.md");
		const content = vault.files.get(path)!;
		expect(content).toContain("Встреча");
		expect(content).not.toContain("zoom.example");
		const bodyLines = content.split("\n").filter((l) => l.startsWith("- [ ]"));
		expect(bodyLines).toHaveLength(2);
		for (const line of bodyLines) {
			expect(line).toMatch(/🆔 [0-9a-z]{10}/);
			expect(line).toMatch(/🧭 work$/);
		}
		expect(report.changedMirrors).toBe(1);
		expect(report.subscriptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "cd-1", status: "ok" })]),
		);
		expect(results.find((r) => r.id === "cd-1")?.result).toMatchObject({ ok: true });
	});

	it("busy: обобщённый заголовок, без 📍 и без исходного текста", async () => {
		const provider = new FakeCaldavProvider(async () => [
			occ({ title: "Секретная встреча", location: "Zoom Room", date: "2026-07-20" }),
		]);
		const s = caldavSub({ id: "cd-1", privacy: "busy" });
		const { svc, vault } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});
		await svc.syncAll();
		const path = mirrorPath(s, "GTD/Inbox.md");
		const content = vault.files.get(path)!;
		expect(content).toContain("Рабочая встреча");
		expect(content).not.toContain("Секретная встреча");
		expect(content).not.toContain("📍");
	});

	it("один UID в двух коллекциях одного аккаунта → разные 🆔 (namespace); load дважды, beginPass один раз за проход", async () => {
		const sharedOccurrences = [occ({ uid: "shared-uid", date: "2026-07-20" })];
		const provider = new FakeCaldavProvider(async () => sharedOccurrences);
		const s1 = caldavSub({ id: "cd-1", collectionKey: "col-a", name: "Календарь A" });
		const s2 = caldavSub({ id: "cd-2", collectionKey: "col-b", name: "Календарь B" });
		const { svc, vault } = makeService({
			subs: [s1, s2] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});
		await svc.syncAll();
		expect(provider.calls).toHaveLength(2);
		expect(provider.beginPassCalls).toBe(1);
		const c1 = vault.files.get(mirrorPath(s1, "GTD/Inbox.md"))!;
		const c2 = vault.files.get(mirrorPath(s2, "GTD/Inbox.md"))!;
		const id1 = c1.match(/🆔 ([0-9a-z]{10})/)?.[1];
		const id2 = c2.match(/🆔 ([0-9a-z]{10})/)?.[1];
		expect(id1).toBeDefined();
		expect(id2).toBeDefined();
		expect(id1).not.toBe(id2);
	});

	it("scope_missing: провайдер не вызывается, отчёт error, зеркало сохраняется байт-в-байт", async () => {
		const s = caldavSub({ id: "cd-1", scopeId: "gone" });
		const provider = new FakeCaldavProvider(async () => [occ()]);
		const path = mirrorPath(s, "GTD/Inbox.md");
		const preseeded =
			'---\ngtd-events: true\ngtd-external: true\ngtd-external-id: "cd-1"\n---\nold\n';
		const { svc, vault, h, results } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
			scopeExists: () => false,
		});
		vault.files.set(path, preseeded);
		const report = await svc.syncAll();
		expect(provider.calls).toHaveLength(0);
		expect(vault.files.get(path)).toBe(preseeded); // байт-в-байт, без записи
		expect(report.subscriptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "cd-1",
					status: "error",
					errorCode: "scope_missing",
				}),
			]),
		);
		expect(results.find((r) => r.id === "cd-1")?.result).toMatchObject({
			ok: false,
			code: "scope_missing",
		});
		expect(h.subs.find((x) => x.id === "cd-1")?.errorCode).toBe("scope_missing");
	});

	it("валидный пустой результат зачищает тело зеркала (§12)", async () => {
		const s = caldavSub({ id: "cd-1" });
		const path = mirrorPath(s, "GTD/Inbox.md");
		const provider = new FakeCaldavProvider(async () => []);
		const { svc, vault } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});
		vault.files.set(
			path,
			buildMirrorFile([occ()], {
				name: s.name,
				subscriptionId: s.id,
				idNamespace: `${s.accountId}\u0000${s.collectionKey}`,
			}),
		);
		expect(vault.files.get(path)).toContain("- [ ]");
		const report = await svc.syncAll();
		expect(vault.files.get(path)).not.toContain("- [ ]");
		expect(report.changedMirrors).toBe(1);
		expect(report.subscriptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "cd-1", status: "ok" })]),
		);
	});

	it("сбой провайдера (authentication_failed) → зеркало сохраняется байт-в-байт, отчёт error, runtime error", async () => {
		const s = caldavSub({ id: "cd-1" });
		const path = mirrorPath(s, "GTD/Inbox.md");
		const provider = new FakeCaldavProvider(async () => {
			throw new ExternalSyncError("authentication_failed", "bad credentials");
		});
		const { svc, vault } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});
		const preseeded = buildMirrorFile([occ()], { name: s.name, subscriptionId: s.id });
		vault.files.set(path, preseeded);
		const report = await svc.syncAll();
		expect(vault.files.get(path)).toBe(preseeded);
		expect(report.subscriptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "cd-1",
					status: "error",
					errorCode: "authentication_failed",
				}),
			]),
		);
		expect(svc.runtimeStatus("cd-1")).toMatchObject({
			state: "error",
			errorCode: "authentication_failed",
		});
	});

	it("fence: смена конфигурации во время висящего provider.load отменяет запись; controller абортится; свежий проход синкает новый fingerprint", async () => {
		let release!: (occs: readonly MirrorOccurrence[]) => void;
		const gate = new Promise<readonly MirrorOccurrence[]>((resolve) => {
			release = resolve;
		});
		const provider = new FakeCaldavProvider(async () => gate);
		const s = caldavSub({ id: "cd-1", privacy: "details" });
		const { svc, vault, h } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});

		const pending = svc.syncById("cd-1");
		await Promise.resolve();
		expect(provider.calls).toHaveLength(1);
		const signal = provider.calls[0]!.signal;
		expect(signal.aborted).toBe(false);

		(h.subs[0] as unknown as CalDavCalendarSub).privacy = "busy";
		svc.configurationChanged();
		expect(signal.aborted).toBe(true); // весь caldav-поток абортится одним контроллером

		release([occ({ title: "Детали" })]);
		const outcome = await pending;
		expect(outcome?.status).toBe("skipped");
		expect(vault.writes).toBe(0); // detailed-контент НЕ приземлился (fence)

		const fresh = await svc.syncAll();
		expect(fresh.subscriptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "cd-1", status: "ok" })]),
		);
		const path = mirrorPath(s, "GTD/Inbox.md");
		expect(vault.files.get(path)).toContain("Рабочая встреча"); // новый fingerprint → busy
		svc.dispose();
	});

	it("dispose() во время висящего provider.load — ни записи, ни onResult", async () => {
		let release!: (occs: readonly MirrorOccurrence[]) => void;
		const gate = new Promise<readonly MirrorOccurrence[]>((resolve) => {
			release = resolve;
		});
		const provider = new FakeCaldavProvider(async () => gate);
		const s = caldavSub({ id: "cd-1" });
		const { svc, vault, results } = makeService({
			subs: [s] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});
		const pending = svc.syncById("cd-1");
		svc.dispose();
		release([occ()]);
		await pending;
		expect(vault.writes).toBe(0);
		expect(results).toHaveLength(0);
	});

	it("beginPass вызывается ровно один раз за проход syncAll(); повторный проход — ещё раз", async () => {
		const provider = new FakeCaldavProvider(async () => [occ()]);
		const s1 = caldavSub({ id: "cd-1", collectionKey: "col-a" });
		const s2 = caldavSub({ id: "cd-2", collectionKey: "col-b" });
		const { svc } = makeService({
			subs: [s1, s2] as unknown as IcsCalendarSub[],
			provider,
			accounts: [account()],
		});
		await svc.syncAll();
		expect(provider.beginPassCalls).toBe(1);
		await svc.syncAll();
		expect(provider.beginPassCalls).toBe(2);
	});
});

describe("SyncService — fail-closed переходы (этап 6)", () => {
	describe("redactPendingSubscriptions (§4.3 privacy tightening)", () => {
		it("caldav-подписка с pendingRedaction=true теряет своё зеркало, колбэк вызывается, маркер логируется; повтор после сброса флага — no-op", async () => {
			const s = caldavSub({ id: "cd-1", pendingRedaction: true });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const preseeded = buildMirrorFile([occ()], {
				name: s.name,
				subscriptionId: s.id,
				idNamespace: `${s.accountId} ${s.collectionKey}`,
			});
			const { svc, vault, h } = makeService({ subs: [s] as unknown as IcsCalendarSub[] });
			vault.files.set(path, preseeded);

			await svc.redactPendingSubscriptions();

			expect(vault.deletes).toContain(path);
			expect(vault.files.has(path)).toBe(false);
			expect(h.pendingRedactionCleared).toEqual(["cd-1"]);
			expect(h.warnings.join("\n")).toContain(
				"Redacted mirror for privacy-tightened subscription cd-1",
			);

			// Хост сбросил флаг (как и должен после успешного колбэка) — повторный
			// проход больше ничего не трогает.
			s.pendingRedaction = false;
			const deletesBefore = vault.deletes.length;
			await svc.redactPendingSubscriptions();
			expect(vault.deletes.length).toBe(deletesBefore);
		});

		it("не делает НИ ОДНОГО сетевого/provider-вызова: работает без provider, и провайдер не вызывается даже если scopeExists возвращает false (§4.2 precedence)", async () => {
			const provider = new FakeCaldavProvider(async () => [occ()]);
			const s = caldavSub({ id: "cd-1", pendingRedaction: true, scopeId: "gone" });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const preseeded = buildMirrorFile([occ()], { name: s.name, subscriptionId: s.id });
			const { svc, vault } = makeService({
				subs: [s] as unknown as IcsCalendarSub[],
				provider,
				accounts: [account()],
				scopeExists: () => false, // scope_missing блокировал бы обычный sync — редакцию не блокирует
			});
			vault.files.set(path, preseeded);

			await svc.redactPendingSubscriptions();

			expect(provider.calls).toHaveLength(0); // ни одного сетевого вызова
			expect(vault.files.has(path)).toBe(false);
			expect(vault.deletes).toContain(path);
		});

		it("работает и когда credential/провайдер вовсе отсутствует (был бы credential_missing при обычном sync)", async () => {
			const s = caldavSub({ id: "cd-1", pendingRedaction: true });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const preseeded = buildMirrorFile([occ()], { name: s.name, subscriptionId: s.id });
			// Ни provider, ни accounts не заданы — обычный sync получил бы skipped/error.
			const { svc, vault } = makeService({ subs: [s] as unknown as IcsCalendarSub[] });
			vault.files.set(path, preseeded);

			await svc.redactPendingSubscriptions();

			expect(vault.files.has(path)).toBe(false);
			expect(vault.deletes).toContain(path);
		});

		it("полный проход: reconcileMirrors → redactPendingSubscriptions → syncAll — редакция ДО любой записи sync; pendingRedaction-подписка остаётся skipped в отчёте", async () => {
			const pending = caldavSub({ id: "cd-1", pendingRedaction: true });
			const healthyIcs = sub({ id: "ics-1", name: "Здоровый" });
			const path = mirrorPath(pending, "GTD/Inbox.md");
			const preseeded = buildMirrorFile([occ()], {
				name: pending.name,
				subscriptionId: pending.id,
			});
			const { svc, vault } = makeService({
				subs: [healthyIcs, pending] as unknown as IcsCalendarSub[],
			});
			vault.files.set(path, preseeded);

			await svc.reconcileMirrors();
			await svc.redactPendingSubscriptions();
			// Редакция уже случилась — ДО любой записи следующего syncAll().
			expect(vault.files.has(path)).toBe(false);
			expect(vault.writes).toBe(0);

			const report = await svc.syncAll();
			expect(report.subscriptions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "cd-1", status: "skipped" }),
					expect.objectContaining({ id: "ics-1", status: "ok" }),
				]),
			);
			expect(vault.writes).toBe(1); // только здоровая ics-подписка пишет
			expect(vault.files.has(path)).toBe(false); // caldav-зеркало не воскресло
		});

		it("сбой onPendingRedactionCleared: маркер остаётся (нет краша, есть warn); повтор ретраит и trash, и колбэк", async () => {
			const s = caldavSub({ id: "cd-1", pendingRedaction: true });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const preseeded = buildMirrorFile([occ()], { name: s.name, subscriptionId: s.id });
			let callbackCalls = 0;
			const { svc, vault, h } = makeService({
				subs: [s] as unknown as IcsCalendarSub[],
				onPendingRedactionCleared: () => {
					callbackCalls++;
					throw new Error("persist failed");
				},
			});
			vault.files.set(path, preseeded);

			await expect(svc.redactPendingSubscriptions()).resolves.toBeUndefined();
			expect(callbackCalls).toBe(1);
			expect(vault.deletes).toContain(path); // trash уже произошёл, несмотря на сбой колбэка
			expect(h.warnings.some((w) => w.includes("cd-1"))).toBe(true);

			// Повтор: маркер (pendingRedaction) в этом тесте не меняется хостом (колбэк
			// упал) — следующий проход снова пытается trash+callback с нуля.
			vault.files.set(path, preseeded); // ре-сидим, чтобы доказать повторный trash
			await svc.redactPendingSubscriptions();
			expect(callbackCalls).toBe(2);
			expect(vault.files.has(path)).toBe(false);
		});
	});

	describe("caldavSourceKey", () => {
		it("детерминирован, различается между парами (account, collection); не содержит подстрок входа", () => {
			const k1 = caldavSourceKey("acc-1", "col-1");
			expect(k1).toBe(caldavSourceKey("acc-1", "col-1"));
			expect(k1).not.toBe(caldavSourceKey("acc-1", "col-2"));
			expect(k1).not.toBe(caldavSourceKey("acc-2", "col-1"));
			expect(k1).toMatch(/^[0-9a-z]{6,12}$/);
			expect(k1).not.toContain("acc-1");
			expect(k1).not.toContain("col-1");
			expect(k1).not.toContain("col-2");
			expect(k1).not.toContain("acc-2");
		});
	});

	describe("reconcileMirrors — смена идентичности caldav-источника (§4.4)", () => {
		it("mirror с ДРУГИМ gtd-external-source (сменился account/collection под тем же subscriptionId) — trashed + warn", async () => {
			const s = caldavSub({ id: "cd-1", accountId: "acc-1", collectionKey: "col-1" });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const oldKey = "differentkey"; // заведомо не равен caldavSourceKey(s.accountId, s.collectionKey)
			expect(oldKey).not.toBe(caldavSourceKey(s.accountId, s.collectionKey));
			const content =
				'---\ngtd-events: true\ngtd-external: true\ngtd-external-name: "Работа"\n' +
				`gtd-external-id: "cd-1"\ngtd-external-source: "${oldKey}"\n---\nold\n`;
			const { svc, vault, h } = makeService({ subs: [s] as unknown as IcsCalendarSub[] });
			vault.files.set(path, content);

			await svc.reconcileMirrors();

			expect(vault.files.has(path)).toBe(false);
			expect(vault.deletes).toContain(path);
			expect(h.warnings.join("\n")).toContain(
				"Removed mirror of a replaced caldav source for subscription cd-1",
			);
		});

		it("mirror с СОВПАДАЮЩИМ gtd-external-source — не трогается", async () => {
			const s = caldavSub({ id: "cd-1", accountId: "acc-1", collectionKey: "col-1" });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const key = caldavSourceKey(s.accountId, s.collectionKey);
			const content =
				'---\ngtd-events: true\ngtd-external: true\ngtd-external-name: "Работа"\n' +
				`gtd-external-id: "cd-1"\ngtd-external-source: "${key}"\n---\nold\n`;
			const { svc, vault } = makeService({ subs: [s] as unknown as IcsCalendarSub[] });
			vault.files.set(path, content);

			await svc.reconcileMirrors();

			expect(vault.files.has(path)).toBe(true);
			expect(vault.deletes).toEqual([]);
		});

		it("mirror БЕЗ строки gtd-external-source (legacy, до маркера) — не трогается", async () => {
			const s = caldavSub({ id: "cd-1" });
			const path = mirrorPath(s, "GTD/Inbox.md");
			const content =
				'---\ngtd-events: true\ngtd-external: true\ngtd-external-name: "Работа"\n' +
				'gtd-external-id: "cd-1"\n---\nold\n';
			const { svc, vault } = makeService({ subs: [s] as unknown as IcsCalendarSub[] });
			vault.files.set(path, content);

			await svc.reconcileMirrors();

			expect(vault.files.has(path)).toBe(true);
			expect(vault.deletes).toEqual([]);
		});

		it("ICS-подписка не проверяется по sourceKey вовсе (ожидаемый sourceKey для ics — null)", async () => {
			const s = sub({ id: "ics-1", name: "Личный" });
			const path = mirrorPath(s, "GTD/Inbox.md");
			// Гипотетическая строка gtd-external-source на ics-зеркале (не должно
			// такого быть в реальности) — reconcileMirrors всё равно её игнорирует,
			// потому что подписка не caldav.
			const content =
				'---\ngtd-events: true\ngtd-external: true\ngtd-external-name: "Личный"\n' +
				'gtd-external-id: "ics-1"\ngtd-external-source: "whatever"\n---\nold\n';
			const { svc, vault } = makeService({ subs: [s] });
			vault.files.set(path, content);

			await svc.reconcileMirrors();

			expect(vault.files.has(path)).toBe(true);
			expect(vault.deletes).toEqual([]);
		});
	});

	describe("performCaldavSync записывает gtd-external-source (§4.4)", () => {
		it("happy path: зеркало содержит gtd-external-source с ожидаемым caldavSourceKey(accountId, collectionKey)", async () => {
			const provider = new FakeCaldavProvider(async () => [occ()]);
			const s = caldavSub({ id: "cd-1", accountId: "acc-1", collectionKey: "col-1" });
			const { svc, vault } = makeService({
				subs: [s] as unknown as IcsCalendarSub[],
				provider,
				accounts: [account()],
			});
			await svc.syncAll();
			const path = mirrorPath(s, "GTD/Inbox.md");
			const content = vault.files.get(path)!;
			const expectedKey = caldavSourceKey(s.accountId, s.collectionKey);
			expect(content).toContain(`gtd-external-source: "${expectedKey}"`);
			// Порядок закреплён mirrorBuilder: сразу после gtd-external-id.
			const lines = content.split("\n");
			const idIdx = lines.findIndex((l) => l.startsWith("gtd-external-id:"));
			expect(lines[idIdx + 1]).toBe(`gtd-external-source: "${expectedKey}"`);
		});
	});
});

describe("SyncService — фиксы предрелизного ревью", () => {
	const caldavFixSub = (over: Record<string, unknown> = {}) =>
		({
			kind: "caldav" as const,
			id: "cd-fix",
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
			...over,
		}) as unknown as ReturnType<typeof sub>;

	const occFix = {
		uid: "e-1",
		recurrenceKey: "2026-07-20T10:00:00",
		date: "2026-07-20",
		allDay: false,
		startTime: "10:00",
		endTime: "11:00",
		title: "Детали встречи",
		location: null,
		dayIndex: 0,
		dayCount: 1,
	};

	it("устаревшая details-запись НЕ воскрешает зеркало после сжатия приватности", async () => {
		let releaseLoad: (v: readonly (typeof occFix)[]) => void = () => undefined;
		const sub0 = caldavFixSub();
		const { svc, vault, h } = makeService({
			subs: [sub0 as never],
			accounts: [{ id: "acc-1", serverOrigin: "https://caldav.example", secretRef: "s" }],
			provider: {
				beginPass: () => undefined,
				load: () => new Promise((resolve) => (releaseLoad = resolve)),
			},
		});
		void h;
		const pass = svc.syncAll();
		await new Promise((r) => setTimeout(r, 0));
		// Пользователь сжимает приватность, пока запись ещё в полёте:
		// fence -> durable busy + pendingRedaction (как commitPrivacyMode).
		svc.configurationChanged();
		(sub0 as unknown as { privacy: string; pendingRedaction: boolean }).privacy = "busy";
		(sub0 as unknown as { pendingRedaction: boolean }).pendingRedaction = true;
		releaseLoad([occFix]);
		await pass;
		// Запись либо не случилась, либо зачищена cleanupStaleWrite: детального
		// контента на диске нет.
		const files = [...vault.files.entries()];
		expect(files.every(([, content]) => !content.includes("Детали встречи"))).toBe(true);
	});

	it("removeSubscription абортит и СТАРШИЙ поток другого поколения (Set контроллеров)", async () => {
		const signals: AbortSignal[] = [];
		const sub0 = caldavFixSub();
		const { svc, h } = makeService({
			subs: [sub0 as never],
			accounts: [{ id: "acc-1", serverOrigin: "https://caldav.example", secretRef: "s" }],
			provider: {
				beginPass: () => undefined,
				load: (_s, _w, opts) => {
					signals.push(opts.signal);
					// Висит до аборта; на abort — отклоняется, как настоящий провайдер.
					return new Promise((_resolve, reject) => {
						opts.signal.addEventListener("abort", () =>
							reject(new ExternalSyncError("timeout", "aborted")),
						);
					});
				},
			},
		});
		const first = svc.syncById("cd-fix");
		await new Promise((r) => setTimeout(r, 0));
		// Смена поколения (не абортящая напрямую нашу цель — новая попытка).
		h.subs = [caldavFixSub()];
		const second = svc.syncById("cd-fix");
		await new Promise((r) => setTimeout(r, 0));
		expect(signals.length).toBeGreaterThanOrEqual(1);
		await svc.removeSubscription({ id: "cd-fix", name: "Работа" });
		// ВСЕ живые контроллеры этого id абортированы, включая старший.
		expect(signals.every((s) => s.aborted)).toBe(true);
		h.subs = [];
		svc.rollbackSubscriptionRemoval("cd-fix");
		await Promise.all([first, second]);
	});

	it("dispose посреди прохода даёт частичный отчёт, а не пустой ok", async () => {
		const a = sub({ id: "a", name: "A" });
		const b = sub({ id: "b", name: "B", url: "https://example/b.ics" });
		const { svc, h } = makeService({ subs: [a, b] });
		let releaseB: (v: string) => void = () => undefined;
		h.fetchImpl = (url) =>
			url.endsWith("b.ics")
				? new Promise<string>((resolve) => (releaseB = resolve))
				: Promise.resolve(ICS_ONE_EVENT);
		const pass = svc.syncAll();
		await new Promise((r) => setTimeout(r, 0));
		svc.dispose();
		releaseB(ICS_ONE_EVENT);
		const report = await pass;
		// Реальная запись зеркала A уже случилась — отчёт обязан её показать.
		expect(report.changedMirrors).toBe(1);
		expect(report.subscriptions.some((s) => s.id === "a" && s.status === "ok")).toBe(true);
	});
});
