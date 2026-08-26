/**
 * settingsFormat: текст полей вкладки настроек — ручной ввод, поэтому мусор,
 * CRLF, лишние пробелы и частично невалидные строки — штатный вход.
 */
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS,
	type CalDavAccount,
	type CalDavCalendarSub,
	type GtdFlowSettings,
	type IcsCalendarSub,
	type InvalidCalendarSub,
} from "./Settings";
import { EXTERNAL_SYNC_ERROR_CODES, NEVER_ATTEMPTED_STATUS } from "../sync/externalSyncStatus";
import {
	commitInboxFile,
	commitPrivacyMode,
	commitSubName,
	formatDeferPresets,
	formatPathList,
	parseDeferPresets,
	parseIntInRange,
	parsePathList,
	planSubNameCommit,
	removeCaldavAccount,
	reorderCalendarPlacement,
	applySyncResult,
	describeSyncErrorCode,
	formatSyncStatus,
} from "./settingsFormat";

describe("parsePathList / formatPathList", () => {
	it("путь-на-строку: trim, пустые строки отбрасываются, CRLF ок", () => {
		expect(parsePathList("GTD/Inbox.md\r\n  Работа/Входящие.md  \n\n\nАрхив\n")).toEqual([
			"GTD/Inbox.md",
			"Работа/Входящие.md",
			"Архив",
		]);
	});

	it("пустой/пробельный текст → пустой список", () => {
		expect(parsePathList("")).toEqual([]);
		expect(parsePathList("  \n \r\n ")).toEqual([]);
	});

	it("round-trip: format → parse возвращает исходный список", () => {
		const paths = ["GTD/Inbox.md", "Работа/Входящие.md"];
		expect(parsePathList(formatPathList(paths))).toEqual(paths);
	});
});

describe("parseDeferPresets / formatDeferPresets", () => {
	it("разбирает «Метка|дни», пропуская пустые строки", () => {
		const { presets, invalid } = parseDeferPresets(
			"Завтра|1\n\n  Через неделю | 7 \r\n+3 дня|3",
		);
		expect(invalid).toEqual([]);
		expect(presets).toEqual([
			{ label: "Завтра", offsetDays: 1 },
			{ label: "Через неделю", offsetDays: 7 },
			{ label: "+3 дня", offsetDays: 3 },
		]);
	});

	it("невалидные строки попадают в invalid, валидные — сохраняются", () => {
		const { presets, invalid } = parseDeferPresets(
			"Завтра|1\nбез разделителя\n|5\nМетка|1.5\nМетка|-2\nОк|0",
		);
		expect(presets).toEqual([
			{ label: "Завтра", offsetDays: 1 },
			{ label: "Ок", offsetDays: 0 },
		]);
		expect(invalid).toEqual(["без разделителя", "|5", "Метка|1.5", "Метка|-2"]);
	});

	it("разделитель — последний «|»: метка может содержать «|»", () => {
		const { presets, invalid } = parseDeferPresets("A|B|14");
		expect(invalid).toEqual([]);
		expect(presets).toEqual([{ label: "A|B", offsetDays: 14 }]);
	});

	it("round-trip дефолтных пресетов", () => {
		const text = formatDeferPresets(DEFAULT_SETTINGS.deferPresets);
		expect(parseDeferPresets(text)).toEqual({
			presets: DEFAULT_SETTINGS.deferPresets,
			invalid: [],
		});
	});
});

describe("parseIntInRange", () => {
	it("строгое целое: пробелы вокруг ок, «+» ок", () => {
		expect(parseIntInRange(" 42 ", 0)).toBe(42);
		expect(parseIntInRange("+7", 0)).toBe(7);
		expect(parseIntInRange("0", 0)).toBe(0);
	});

	it("мусор → null (в отличие от Number: «» было бы 0)", () => {
		for (const bad of ["", "  ", "abc", "12abc", "1.5", "1e3", "--5", "NaN"]) {
			expect(parseIntInRange(bad, 0)).toBeNull();
		}
	});

	it("границы диапазона включительны, выход за них → null", () => {
		expect(parseIntInRange("1", 1, 30)).toBe(1);
		expect(parseIntInRange("30", 1, 30)).toBe(30);
		expect(parseIntInRange("0", 1, 30)).toBeNull();
		expect(parseIntInRange("31", 1, 30)).toBeNull();
		expect(parseIntInRange("-1", 0)).toBeNull();
	});
});

describe("reorderCalendarPlacement", () => {
	it("выбранное поле — в голову, остальные сохраняют относительный порядок", () => {
		expect(reorderCalendarPlacement(["due", "scheduled", "start"], "start")).toEqual([
			"start",
			"due",
			"scheduled",
		]);
		expect(reorderCalendarPlacement(["start", "due", "scheduled"], "due")).toEqual([
			"due",
			"start",
			"scheduled",
		]);
	});

	it("выбор уже первого поля — порядок не меняется", () => {
		expect(reorderCalendarPlacement(["due", "scheduled", "start"], "due")).toEqual([
			"due",
			"scheduled",
			"start",
		]);
	});

	it("нормализует руками правленный data.json: дубликаты и пропуски", () => {
		expect(reorderCalendarPlacement(["due", "due"], "scheduled")).toEqual([
			"scheduled",
			"due",
			"start",
		]);
		expect(reorderCalendarPlacement([], "start")).toEqual(["start", "due", "scheduled"]);
	});
});

describe("planSubNameCommit", () => {
	it("имя не менялось → renamed=false (зеркало не трогаем)", () => {
		expect(planSubNameCommit("Луна", "Луна")).toEqual({ value: "Луна", renamed: false });
	});

	it("только краевые пробелы → не изменение, но значение обрезается", () => {
		expect(planSubNameCommit("Луна", "  Луна ")).toEqual({ value: "Луна", renamed: false });
	});

	it("имя изменилось → renamed=true, значение обрезано", () => {
		expect(planSubNameCommit("Новый календарь", "  Луна  ")).toEqual({
			value: "Луна",
			renamed: true,
		});
	});

	it("очистка в пусто → renamed=true, value пустой (строка покажет «(без имени)»)", () => {
		expect(planSubNameCommit("Луна", "")).toEqual({ value: "", renamed: true });
		expect(planSubNameCommit("Луна", "   ")).toEqual({ value: "", renamed: true });
	});

	it("пустое → пустое → не изменение", () => {
		expect(planSubNameCommit("", "  ")).toEqual({ value: "", renamed: false });
	});
});

describe("commitSubName", () => {
	it("переименование: deleteMirror СТАРОГО имени ровно раз, save раз, sub.name обновлён, true", async () => {
		const sub = { name: "Новый календарь" };
		const deleteMirror = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);

		const renamed = await commitSubName(sub, "  Луна  ", { deleteMirror, save });

		expect(renamed).toBe(true);
		expect(deleteMirror).toHaveBeenCalledTimes(1);
		expect(deleteMirror).toHaveBeenCalledWith("Новый календарь"); // старое, не новое
		expect(save).toHaveBeenCalledTimes(1);
		expect(sub.name).toBe("Луна"); // записано обрезанное новое имя
	});

	it("зеркало удаляется ДО мутации sub.name (порт видит старое имя)", async () => {
		const sub = { name: "Старое" };
		let nameAtDelete: string | null = null;
		const deleteMirror = vi.fn(async () => {
			nameAtDelete = sub.name;
		});
		const save = vi.fn(async () => undefined);

		await commitSubName(sub, "Новое", { deleteMirror, save });

		expect(nameAtDelete).toBe("Старое");
	});

	it("имя не изменилось: ни deleteMirror, ни save, sub.name как был, false", async () => {
		const sub = { name: "Луна" };
		const deleteMirror = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);

		const renamed = await commitSubName(sub, "  Луна ", { deleteMirror, save });

		expect(renamed).toBe(false);
		expect(deleteMirror).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(sub.name).toBe("Луна");
	});

	it("очистка в пусто — тоже переименование: deleteMirror старого раз, sub.name пуст", async () => {
		const sub = { name: "Луна" };
		const deleteMirror = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);

		const renamed = await commitSubName(sub, "   ", { deleteMirror, save });

		expect(renamed).toBe(true);
		expect(deleteMirror).toHaveBeenCalledTimes(1);
		expect(deleteMirror).toHaveBeenCalledWith("Луна");
		expect(sub.name).toBe("");
	});
});

describe("commitInboxFile", () => {
	it("реальное изменение: путь обрезан, reconcile и save по одному разу, true", async () => {
		const settings = { inboxFile: "Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		const changed = await commitInboxFile(settings, "  GTD/Inbox.md  ", { reconcile, save });

		expect(changed).toBe(true);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
	});

	// Ключ фикса: путь зеркал ICS считается от папки этого файла, поэтому запись на
	// каждый символ гоняла зеркала по промежуточным путям («G», «GT», …) и на каждое
	// поколение конфигурации перезапускала полный сетевой проход по всем лентам.
	it("промежуточные значения набора коммитом не считаются: один коммит на весь путь", async () => {
		const settings = { inboxFile: "Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		// blur наступает один раз — ровно с итоговым значением поля
		await commitInboxFile(settings, "GTD/Inbox.md", { reconcile, save });

		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
	});

	it("то же значение (и лишние пробелы) — ни reconcile, ни save, false", async () => {
		const settings = { inboxFile: "GTD/Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		expect(await commitInboxFile(settings, "  GTD/Inbox.md ", { reconcile, save })).toBe(false);
		expect(reconcile).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("пустое значение изменением не считается — прежний путь сохраняется", async () => {
		const settings = { inboxFile: "GTD/Inbox.md" };
		const reconcile = vi.fn();
		const save = vi.fn(async () => undefined);

		expect(await commitInboxFile(settings, "   ", { reconcile, save })).toBe(false);
		expect(settings.inboxFile).toBe("GTD/Inbox.md");
		expect(reconcile).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});
});

describe("applySyncResult — санитизированный персист статуса (§5.1/§5.2)", () => {
	const freshSub = (): IcsCalendarSub => ({
		id: "s1",
		name: "X",
		url: "https://example/a.ics",
		lastSyncAt: null,
		lastError: "легаси текст со старой версии",
		errorCode: null,
	});

	it("успех: ставит lastSyncAt, чистит errorCode и легаси lastError", () => {
		const sub = freshSub();
		expect(applySyncResult(sub, { ok: true, at: 42 })).toBe(true);
		expect(sub).toMatchObject({ lastSyncAt: 42, lastError: null, errorCode: null });
		// Повтор того же успеха — сохранение не нужно.
		expect(applySyncResult(sub, { ok: true, at: 42 })).toBe(false);
	});

	it("ошибка: персистится ТОЛЬКО код; сырой detail не попадает в подписку", () => {
		const sub = freshSub();
		const changed = applySyncResult(sub, {
			ok: false,
			code: "network_error",
			detail: "https://secret.example/token?x=1 500 Internal",
		});
		expect(changed).toBe(true);
		expect(sub.errorCode).toBe("network_error");
		expect(sub.lastError).toBeNull();
		expect(JSON.stringify(sub)).not.toContain("secret.example");
		// Тот же код повторно — без сохранения.
		expect(
			applySyncResult(sub, { ok: false, code: "network_error", detail: "другой текст" }),
		).toBe(false);
	});

	it("device-local коды не персистятся и не затирают durable-статус", () => {
		const sub = freshSub();
		sub.lastSyncAt = 100;
		sub.lastError = null;
		for (const code of ["credential_missing", "authentication_failed"] as const) {
			expect(applySyncResult(sub, { ok: false, code, detail: "" })).toBe(false);
			expect(sub.errorCode).toBeNull();
			expect(sub.lastSyncAt).toBe(100);
		}
	});
});

describe("describeSyncErrorCode / formatSyncStatus — §9 состояния", () => {
	it("каждый код замкнутого списка имеет непустую безопасную подсказку", () => {
		for (const code of EXTERNAL_SYNC_ERROR_CODES) {
			const hint = describeSyncErrorCode(code);
			expect(hint.length).toBeGreaterThan(3);
			expect(hint).not.toContain("http");
		}
	});

	it("runtime-состояния приоритетнее персистентного статуса", () => {
		const sub = { lastSyncAt: null, lastError: null, errorCode: null };
		expect(formatSyncStatus(sub, NEVER_ATTEMPTED_STATUS)).toBe("ещё не синхронизировалось");
		expect(formatSyncStatus(sub, { state: "syncing", errorCode: null, lastAttemptAt: 1 })).toBe(
			"синхронизируется…",
		);
		expect(
			formatSyncStatus(sub, {
				state: "error",
				errorCode: "credential_missing",
				lastAttemptAt: 1,
			}),
		).toContain("нет учётных данных");
		const at = new Date(2026, 6, 15, 9, 5).getTime();
		const synced = { lastSyncAt: at, lastError: null, errorCode: null };
		expect(
			formatSyncStatus(synced, { state: "okChanged", errorCode: null, lastAttemptAt: at }),
		).toBe("обновлено 09:05 15.07");
		expect(
			formatSyncStatus(synced, { state: "okUnchanged", errorCode: null, lastAttemptAt: at }),
		).toBe("обновлено 09:05 15.07 (без изменений)");
	});

	it("персистентный errorCode и легаси lastError рендерятся без сырого текста", () => {
		expect(
			formatSyncStatus(
				{ lastSyncAt: null, lastError: null, errorCode: "forbidden" },
				NEVER_ATTEMPTED_STATUS,
			),
		).toContain("доступ запрещён");
		const legacy = formatSyncStatus(
			{ lastSyncAt: null, lastError: "https://secret.example/x упал", errorCode: null },
			NEVER_ATTEMPTED_STATUS,
		);
		expect(legacy).not.toContain("secret.example");
		expect(legacy).toContain("⚠");
	});
});

function freshCaldavSub(overrides: Partial<CalDavCalendarSub> = {}): CalDavCalendarSub {
	return {
		kind: "caldav",
		id: "sub1",
		name: "Работа",
		accountId: "acc1",
		collectionKey: "key1",
		privacy: "unconfigured",
		enabled: false,
		scopeId: null,
		pendingRedaction: false,
		lastSyncAt: null,
		lastError: null,
		errorCode: null,
		...overrides,
	};
}

describe("commitPrivacyMode — §4.3 crash- и save-safe переход приватности", () => {
	it("next === текущему privacy → unchanged: без fence, без save, без мутации", async () => {
		const sub = freshCaldavSub({ privacy: "details" });
		const fence = vi.fn();
		const save = vi.fn(async () => undefined);

		const result = await commitPrivacyMode(sub, "details", { fence, save });

		expect(result).toBe("unchanged");
		expect(fence).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(sub.privacy).toBe("details");
	});

	it("unconfigured→details: без fence, privacy применён, save раз, applied", async () => {
		const sub = freshCaldavSub({ privacy: "unconfigured" });
		const fence = vi.fn();
		const save = vi.fn(async () => undefined);

		const result = await commitPrivacyMode(sub, "details", { fence, save });

		expect(result).toBe("applied");
		expect(fence).not.toHaveBeenCalled();
		expect(save).toHaveBeenCalledTimes(1);
		expect(sub.privacy).toBe("details");
	});

	it("unconfigured→busy: без fence, pendingRedaction не трогается, applied", async () => {
		const sub = freshCaldavSub({ privacy: "unconfigured", pendingRedaction: false });
		const fence = vi.fn();
		const save = vi.fn(async () => undefined);

		const result = await commitPrivacyMode(sub, "busy", { fence, save });

		expect(result).toBe("applied");
		expect(fence).not.toHaveBeenCalled();
		expect(sub.privacy).toBe("busy");
		expect(sub.pendingRedaction).toBe(false); // не тронут: это не fail-closed сжатие
	});

	it("busy→details: без fence, pendingRedaction не трогается (остаётся как было), applied", async () => {
		const sub = freshCaldavSub({ privacy: "busy", pendingRedaction: true });
		const fence = vi.fn();
		const save = vi.fn(async () => undefined);

		const result = await commitPrivacyMode(sub, "details", { fence, save });

		expect(result).toBe("applied");
		expect(fence).not.toHaveBeenCalled();
		expect(sub.privacy).toBe("details");
		expect(sub.pendingRedaction).toBe(true); // §4.3: нечего больше делать здесь
	});

	it("ослабление: отказ save откатывает privacy в памяти и пробрасывает ошибку", async () => {
		const sub = freshCaldavSub({ privacy: "unconfigured" });
		const fence = vi.fn();
		const boom = new Error("saveData упал");
		const save = vi.fn(async () => {
			throw boom;
		});

		await expect(commitPrivacyMode(sub, "details", { fence, save })).rejects.toThrow(boom);
		expect(sub.privacy).toBe("unconfigured"); // откачено
	});

	it("сжатие details→busy: fence ДО мутации и ДО save, privacy+pendingRedaction, pending-redaction", async () => {
		const sub = freshCaldavSub({ privacy: "details", pendingRedaction: false, enabled: true });
		const order: string[] = [];
		const fence = vi.fn(() => order.push("fence"));
		const save = vi.fn(async () => {
			order.push("save");
			// на момент save мутация уже должна была случиться
			expect(sub.privacy).toBe("busy");
			expect(sub.pendingRedaction).toBe(true);
		});

		const result = await commitPrivacyMode(sub, "busy", { fence, save });

		expect(result).toBe("pending-redaction");
		expect(order).toEqual(["fence", "save"]);
		expect(sub.privacy).toBe("busy");
		expect(sub.pendingRedaction).toBe(true);
		expect(sub.enabled).toBe(true); // sub.enabled НИКОГДА не трогается
	});

	it("сжатие details→busy: отказ save откатывает ОБА поля и пробрасывает ошибку", async () => {
		const sub = freshCaldavSub({ privacy: "details", pendingRedaction: false });
		const fence = vi.fn();
		const boom = new Error("saveData упал");
		const save = vi.fn(async () => {
			throw boom;
		});

		await expect(commitPrivacyMode(sub, "busy", { fence, save })).rejects.toThrow(boom);
		expect(fence).toHaveBeenCalledTimes(1);
		expect(sub.privacy).toBe("details"); // откачено
		expect(sub.pendingRedaction).toBe(false); // откачено
	});
});

describe("removeCaldavAccount — §4.1 атомарное отключение аккаунта", () => {
	const account = (overrides: Partial<CalDavAccount> = {}): CalDavAccount => ({
		id: "acc1",
		serverOrigin: "https://caldav.example",
		secretRef: "acc1",
		...overrides,
	});
	const ics = (id: string): IcsCalendarSub => ({
		kind: "ics",
		id,
		name: `ics-${id}`,
		url: "https://example/a.ics",
		lastSyncAt: null,
		lastError: null,
		errorCode: null,
	});
	const invalid = (id: string): InvalidCalendarSub => ({ kind: "invalid", id, reason: "schema" });

	const makePorts = () => ({
		confirmCascade: vi.fn(async (): Promise<boolean> => true),
		removeSubscription: vi.fn(
			async (_sub: { id: string; name: string }): Promise<void> => undefined,
		),
		rollbackRemoval: vi.fn((_id: string): void => undefined),
		save: vi.fn(async (): Promise<void> => undefined),
	});

	it("аккаунт не найден, ссылок нет → removed с пустым списком, БЕЗ save/confirm/removeSubscription", async () => {
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			externalCalendars: [ics("i1")],
			caldavAccounts: [],
		};
		const ports = makePorts();

		const result = await removeCaldavAccount(settings, "missing", ports);

		expect(result).toEqual({ status: "removed", removedSubscriptionIds: [] });
		expect(ports.confirmCascade).not.toHaveBeenCalled();
		expect(ports.removeSubscription).not.toHaveBeenCalled();
		expect(ports.save).not.toHaveBeenCalled();
		expect(settings.externalCalendars).toEqual([ics("i1")]);
		expect(settings.caldavAccounts).toEqual([]);
	});

	it("аккаунт найден, ссылок нет → confirmCascade НЕ вызывается, аккаунт всё равно удаляется", async () => {
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			externalCalendars: [ics("i1")],
			caldavAccounts: [account()],
		};
		const ports = makePorts();

		const result = await removeCaldavAccount(settings, "acc1", ports);

		expect(result).toEqual({ status: "removed", removedSubscriptionIds: [] });
		expect(ports.confirmCascade).not.toHaveBeenCalled();
		expect(ports.removeSubscription).not.toHaveBeenCalled();
		expect(ports.save).toHaveBeenCalledTimes(1);
		expect(settings.caldavAccounts).toEqual([]);
		expect(settings.externalCalendars).toEqual([ics("i1")]); // сосед не тронут
	});

	it("confirmCascade → false: отказ, БЕЗ мутации и БЕЗ save; sibling ics/другой аккаунт целы", async () => {
		const otherSub = freshCaldavSub({ id: "other", accountId: "acc-other" });
		const targetSub = freshCaldavSub({ id: "s1", accountId: "acc1" });
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			externalCalendars: [ics("i1"), otherSub, targetSub, invalid("bad1")],
			caldavAccounts: [account(), account({ id: "acc-other" })],
		};
		const before = {
			externalCalendars: [...settings.externalCalendars],
			caldavAccounts: [...settings.caldavAccounts],
		};
		const ports = makePorts();
		ports.confirmCascade.mockImplementation(async () => false);

		const result = await removeCaldavAccount(settings, "acc1", ports);

		expect(result).toEqual({ status: "refused-active-subscriptions", subscriptionIds: ["s1"] });
		expect(ports.removeSubscription).not.toHaveBeenCalled();
		expect(ports.save).not.toHaveBeenCalled();
		expect(settings.externalCalendars).toEqual(before.externalCalendars);
		expect(settings.caldavAccounts).toEqual(before.caldavAccounts);
	});

	it("подтверждённый каскад: removeSubscription для КАЖДОЙ ссылающейся подписки, затем splice+save, sibling целы", async () => {
		const otherSub = freshCaldavSub({ id: "other", accountId: "acc-other", name: "Чужой" });
		const s1 = freshCaldavSub({ id: "s1", accountId: "acc1", name: "Раз" });
		const s2 = freshCaldavSub({ id: "s2", accountId: "acc1", name: "Два" });
		const icsSub = ics("i1");
		const invalidSub = invalid("bad1");
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			externalCalendars: [icsSub, otherSub, s1, invalidSub, s2],
			caldavAccounts: [account(), account({ id: "acc-other" })],
		};
		const ports = makePorts();

		const result = await removeCaldavAccount(settings, "acc1", ports);

		expect(result).toEqual({ status: "removed", removedSubscriptionIds: ["s1", "s2"] });
		expect(ports.confirmCascade).toHaveBeenCalledTimes(1);
		expect(ports.removeSubscription).toHaveBeenCalledTimes(2);
		expect(ports.removeSubscription).toHaveBeenNthCalledWith(1, { id: "s1", name: "Раз" });
		expect(ports.removeSubscription).toHaveBeenNthCalledWith(2, { id: "s2", name: "Два" });
		expect(ports.save).toHaveBeenCalledTimes(1);
		expect(ports.rollbackRemoval).not.toHaveBeenCalled();
		expect(settings.externalCalendars).toEqual([icsSub, otherSub, invalidSub]);
		expect(settings.caldavAccounts).toEqual([account({ id: "acc-other" })]);
	});

	it("битые ссылки на ОТСУТСТВУЮЩИЙ аккаунт: тот же каскад, без записи аккаунта на вырезание", async () => {
		const s1 = freshCaldavSub({ id: "s1", accountId: "ghost" });
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			externalCalendars: [s1],
			caldavAccounts: [], // аккаунта уже нет — битая ссылка
		};
		const ports = makePorts();

		const result = await removeCaldavAccount(settings, "ghost", ports);

		expect(result).toEqual({ status: "removed", removedSubscriptionIds: ["s1"] });
		expect(ports.confirmCascade).toHaveBeenCalledTimes(1);
		expect(ports.removeSubscription).toHaveBeenCalledTimes(1);
		expect(ports.save).toHaveBeenCalledTimes(1);
		expect(settings.externalCalendars).toEqual([]);
		expect(settings.caldavAccounts).toEqual([]);
	});

	it("removeSubscription падает на второй подписке: пробрасывает ДО любой mutации settings", async () => {
		const s1 = freshCaldavSub({ id: "s1", accountId: "acc1", name: "Раз" });
		const s2 = freshCaldavSub({ id: "s2", accountId: "acc1", name: "Два" });
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			externalCalendars: [s1, s2],
			caldavAccounts: [account()],
		};
		const before = {
			externalCalendars: [...settings.externalCalendars],
			caldavAccounts: [...settings.caldavAccounts],
		};
		const boom = new Error("trash упал");
		const ports = makePorts();
		ports.removeSubscription.mockImplementation(async (sub: { id: string }) => {
			if (sub.id === "s2") throw boom;
		});

		await expect(removeCaldavAccount(settings, "acc1", ports)).rejects.toThrow(boom);

		expect(ports.save).not.toHaveBeenCalled();
		expect(ports.rollbackRemoval).not.toHaveBeenCalled();
		expect(settings.externalCalendars).toEqual(before.externalCalendars); // ничего не вырезано
		expect(settings.caldavAccounts).toEqual(before.caldavAccounts);
	});

	it("save падает после splice: восстанавливает ТОЧНЫЙ исходный порядок массивов, rollbackRemoval для каждой, пробрасывает", async () => {
		const other = freshCaldavSub({ id: "other", accountId: "acc-other" });
		const s1 = freshCaldavSub({ id: "s1", accountId: "acc1" });
		const icsSub = ics("i1");
		const s2 = freshCaldavSub({ id: "s2", accountId: "acc1" });
		const settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts"> = {
			// Ссылающиеся подписки НЕ соседние — перемежены посторонними записями,
			// чтобы восстановление по индексам было настоящей проверкой порядка.
			externalCalendars: [other, s1, icsSub, s2],
			caldavAccounts: [account({ id: "acc-other" }), account()],
		};
		const before = {
			externalCalendars: [...settings.externalCalendars],
			caldavAccounts: [...settings.caldavAccounts],
		};
		const boom = new Error("saveData упал");
		const ports = makePorts();
		ports.save.mockImplementation(async () => {
			throw boom;
		});

		await expect(removeCaldavAccount(settings, "acc1", ports)).rejects.toThrow(boom);

		expect(settings.externalCalendars).toEqual(before.externalCalendars);
		expect(settings.caldavAccounts).toEqual(before.caldavAccounts);
		expect(ports.rollbackRemoval).toHaveBeenCalledTimes(2);
		expect(ports.rollbackRemoval).toHaveBeenCalledWith("s1");
		expect(ports.rollbackRemoval).toHaveBeenCalledWith("s2");
	});
});
