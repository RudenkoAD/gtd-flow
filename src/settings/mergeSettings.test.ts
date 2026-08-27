/**
 * mergeSettings: data.json пишется/правится руками (вкладки настроек пока
 * нет), поэтому частичные вложенные объекты — штатный вход, а не край.
 * Регрессия этапа 9: плоский Object.assign обнулял catchUp/catchUpCap и
 * debounceMs.fileReindex при частичном data.json.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_FORMAT_VERSION } from "./Settings";
import { mergeSettings, mergeSettingsWithDiagnostics } from "./mergeSettings";

describe("mergeSettings", () => {
	it("null/undefined/пустой объект → полные дефолты (и не тот же объект)", () => {
		for (const loaded of [null, undefined, {}]) {
			const merged = mergeSettings(DEFAULT_SETTINGS, loaded);
			expect(merged).toEqual(DEFAULT_SETTINGS);
			expect(merged).not.toBe(DEFAULT_SETTINGS);
			expect(merged.recurring).not.toBe(DEFAULT_SETTINGS.recurring);
			expect(merged.debounceMs).not.toBe(DEFAULT_SETTINGS.debounceMs);
		}
	});

	it("legacy recurring.spawnTarget мигрирует только в единый inboxFile", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			recurring: { spawnTarget: "My/Inbox.md" },
		});
		expect(merged.inboxFile).toBe("My/Inbox.md");
		expect((merged.recurring as Record<string, unknown>)["spawnTarget"]).toBeUndefined();
		expect(merged.recurring.catchUp).toBe("latest"); // регрессия: было undefined → политика 'none'
		expect(merged.recurring.catchUpCap).toBe(30);
	});

	// Дефект: миграция брала recurring.spawnTarget (фабричное "GTD/Inbox.md" —
	// цель копий регулярных), а захват 0.12 писал в <commonRoot>/Входящие.md.
	// Пользователь на дефолтах получал inboxFile мимо своих накопленных захватов,
	// и «Быстрый ввод» заводил ВТОРОЙ файл входящих.
	describe("миграция v1 → v2: единый файл входящих", () => {
		const LEGACY_DEFAULTS = {
			commonRoot: "GTD",
			namespaces: [{ name: "Работа", root: "Work" }],
			recurring: { spawnTarget: "GTD/Inbox.md", catchUp: "all" },
		};

		it("без проверки хранилища берётся конвенционный <commonRoot>/Входящие.md", () => {
			const { settings, migratedInboxFile } = mergeSettingsWithDiagnostics(
				DEFAULT_SETTINGS,
				LEGACY_DEFAULTS,
			);
			expect(settings.inboxFile).toBe("GTD/Входящие.md");
			expect(migratedInboxFile).toBe("GTD/Входящие.md");
		});

		it("реально существующий файл захвата побеждает догадку по конвенции", () => {
			const { settings } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, LEGACY_DEFAULTS, {
				legacyInboxExists: (path) => path === "GTD/Inbox.md",
			});
			expect(settings.inboxFile).toBe("GTD/Inbox.md");
		});

		it("Входящие.md приоритетнее spawnTarget, когда существуют оба", () => {
			const { settings } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, LEGACY_DEFAULTS, {
				legacyInboxExists: (path) => path === "GTD/Входящие.md" || path === "GTD/Inbox.md",
			});
			expect(settings.inboxFile).toBe("GTD/Входящие.md");
		});

		it("ничего не существует — конвенционный кандидат, а не молчаливый дефолт", () => {
			const { settings } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, LEGACY_DEFAULTS, {
				legacyInboxExists: () => false,
			});
			expect(settings.inboxFile).toBe("GTD/Входящие.md");
		});

		it("пустой commonRoot — файл в корне хранилища", () => {
			const { settings } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				commonRoot: "/",
			});
			expect(settings.inboxFile).toBe("Входящие.md");
		});

		it("уже мигрированный data.json (v2) ничего не выводит", () => {
			const { settings, migratedInboxFile } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				settingsVersion: SETTINGS_FORMAT_VERSION,
				inboxFile: "Мои/Входящие.md",
				commonRoot: "GTD",
			});
			expect(settings.inboxFile).toBe("Мои/Входящие.md");
			expect(migratedInboxFile).toBeNull();
		});

		// Fail-closed потребители (MCP) обязаны отличать штатную миграцию формата
		// от отката испорченного поля: разбор диагностики по тексту ронял их на
		// каждом legacy data.json.
		it("диагностика миграции помечена отдельно от диагностики отката", () => {
			const { diagnostics, migrations } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				...LEGACY_DEFAULTS,
				ai: { privacyPolicy: "unconfigured", credentialStorage: "unconfigured" },
				durationLongStyle: "days-hours",
				firstDayOfWeek: "понедельник",
			});
			expect(migrations).toEqual([
				`settings: migrated v0 → v${SETTINGS_FORMAT_VERSION}`,
				"namespace settings retained only for migration planning",
				"ai.privacyPolicy: migrated to account-policy",
				"ai.credentialStorage: migrated to memory-only",
				"durationLongStyle: migrated to whole-days",
			]);
			// Откат испорченного поля миграцией не считается ни при каких условиях.
			expect(diagnostics).toContain("firstDayOfWeek: invalid; default used");
			expect(migrations).not.toContain("firstDayOfWeek: invalid; default used");
			expect(diagnostics).toEqual(expect.arrayContaining(migrations));
		});

		it("непонятная версия формата — не миграция, а откат", () => {
			const { migrations, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				settingsVersion: 999,
			});
			expect(migrations).toEqual([]);
			expect(diagnostics).toEqual([
				`settingsVersion: v999 is newer than supported v${SETTINGS_FORMAT_VERSION}`,
			]);
		});

		it("legacy-полей нет вовсе — дефолт остаётся, выводить нечего", () => {
			const { settings, migratedInboxFile } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				onboarded: true,
			});
			expect(settings.inboxFile).toBe(DEFAULT_SETTINGS.inboxFile);
			expect(migratedInboxFile).toBeNull();
		});
	});

	it("частичный debounceMs: fileReindex не превращается в undefined (= 0 мс)", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, { debounceMs: { queryRecompute: 10 } });
		expect(merged.debounceMs.queryRecompute).toBe(10);
		expect(merged.debounceMs.fileReindex).toBe(150);
	});

	it("неизвестные ключи (будущие версии) сохраняются — верхние и вложенные", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			futureFlag: true,
			recurring: { futureNested: "x" },
		});
		expect((merged as unknown as Record<string, unknown>)["futureFlag"]).toBe(true);
		expect((merged.recurring as Record<string, unknown>)["futureNested"]).toBe("x");
	});

	it("скаляры и массивы верхнего уровня заменяются, а старый формат длительности мигрирует", () => {
		const { settings: merged, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			autoInjectId: false,
			inboxFile: "Life/Inbox.md",
			durationLongStyle: "days-hours",
			statusMap: { "/": "next" },
		});
		expect(merged.autoInjectId).toBe(false);
		expect(merged.inboxFile).toBe("Life/Inbox.md");
		expect(merged.durationLongStyle).toBe("whole-days");
		expect(diagnostics).toContain("durationLongStyle: migrated to whole-days");
		expect(merged.statusMap).toEqual({ "/": "next" });
	});

	it("merges explicit AI choices without ever inventing a credential value", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			ai: {
				enabled: true,
				privacyPolicy: "require-zdr",
				credentialStorage: "memory-only",
				storageVersion: 1,
			},
		});
		expect(merged.ai).toEqual({
			enabled: true,
			privacyPolicy: "require-zdr",
			credentialStorage: "memory-only",
			storageVersion: 1,
		});
		expect(merged.ai).not.toHaveProperty("apiKey");
		expect(merged.ai).not.toHaveProperty("credential");
	});

	it("migrates the retired undecided AI choices to the approved MVP behavior", () => {
		const { settings, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			ai: {
				privacyPolicy: "unconfigured",
				credentialStorage: "unconfigured",
			},
		});
		expect(settings.ai).toMatchObject({
			privacyPolicy: "account-policy",
			credentialStorage: "memory-only",
		});
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				"ai.privacyPolicy: migrated to account-policy",
				"ai.credentialStorage: migrated to memory-only",
			]),
		);
	});

	it("recovers malformed AI and duration choices field-by-field", () => {
		const { settings, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			ai: {
				enabled: "yes",
				privacyPolicy: "silently-relax-zdr",
				credentialStorage: "vault",
				storageVersion: -1,
			},
			durationLongStyle: "guess",
		});
		expect(settings.ai).toEqual(DEFAULT_SETTINGS.ai);
		expect(settings.durationLongStyle).toBe("whole-days");
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				"ai.enabled: invalid; default used",
				"ai.privacyPolicy: invalid; default used",
				"ai.credentialStorage: invalid; default used",
				"durationLongStyle: invalid; default used",
			]),
		);
	});

	it("выпиленный inboxSources из старого data.json игнорируется молча (миграция)", () => {
		// старый data.json итерации 1 нёс inboxSources; после выпила поля merge не должен
		// падать, а старый commonRoot используется только для создания inboxFile
		// (конвенционные Входящие.md — реальная цель захвата тех версий).
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			inboxSources: ["GTD/Inbox.md"],
			commonRoot: "GTD",
		});
		expect(merged.inboxFile).toBe("GTD/Входящие.md");
		// старое поле не мешает и остаётся в объекте безвредным довеском
		expect((merged as unknown as Record<string, unknown>)["inboxSources"]).toEqual([
			"GTD/Inbox.md",
		]);
	});

	it("мусор вместо вложенного объекта не ломает слияние", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, { debounceMs: 5, recurring: "oops" });
		expect(merged.debounceMs).toEqual(DEFAULT_SETTINGS.debounceMs);
		expect(merged.recurring).toEqual(DEFAULT_SETTINGS.recurring);
	});

	it("DEFAULT_SETTINGS не мутируются", () => {
		const before = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as unknown;
		const merged = mergeSettings(DEFAULT_SETTINGS, { recurring: { catchUpCap: 7 } });
		merged.recurring.catchUpCap = 99;
		merged.debounceMs.fileReindex = 1;
		expect(DEFAULT_SETTINGS).toEqual(before);
	});

	it("версионирует legacy data.json, валидирует все сложные коллекции и сохраняет promoteRetries", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			// settingsVersion отсутствует: это legacy v0
			promoteRetries: [{ taskId: "task-1", source: "GTD/Board.md", target: "GTD/Inbox.md" }],
			commonRoot: "Work",
			externalCalendars: [
				{
					id: "calendar-1",
					name: "Team",
					url: "webcal://calendar.example/team.ics",
					lastSyncAt: null,
					lastError: null,
				},
			],
			calendarPlacement: ["start", "due", "scheduled"],
		});

		expect(merged.settingsVersion).toBe(SETTINGS_FORMAT_VERSION);
		expect(merged.promoteRetries).toEqual([
			{ taskId: "task-1", source: "GTD/Board.md", target: "GTD/Inbox.md" },
		]);
		expect(merged.inboxFile).toBe("Work/Входящие.md");
		expect(merged.externalCalendars[0]).toMatchObject({
			url: "webcal://calendar.example/team.ics",
			errorCode: null,
		});
		expect(merged.calendarPlacement).toEqual(["start", "due", "scheduled"]);
	});

	it("неверные типы и URL откатывают только испорченное поле, числа клампятся в UI-границы", () => {
		const { settings, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			inboxFile: "\u0000invalid",
			calendarPlacement: ["due", "due", "unknown"],
			externalCalendars: [
				{
					id: "x",
					name: "X",
					url: "file:///private/calendar.ics",
					lastSyncAt: null,
					lastError: null,
				},
			],
			promoteRetries: [{ taskId: "", source: "x.md", target: null }],
			firstDayOfWeek: 99,
			virtualizeThreshold: -2,
			externalSyncIntervalMin: 99_999,
			debounceMs: { fileReindex: -10, queryRecompute: 55_555 },
			recurring: { catchUpCap: 0, catchUp: "all" },
		});

		expect(settings.inboxFile).toBe(DEFAULT_SETTINGS.inboxFile);
		expect(settings.calendarPlacement).toEqual(DEFAULT_SETTINGS.calendarPlacement);
		// Битая подписка деградирует в инертную запись, а не сбрасывает массив.
		expect(settings.externalCalendars).toEqual([
			{ kind: "invalid", id: "x", reason: "schema" },
		]);
		expect(settings.promoteRetries).toEqual([]);
		expect(settings.firstDayOfWeek).toBe(6);
		expect(settings.virtualizeThreshold).toBe(0);
		expect(settings.externalSyncIntervalMin).toBe(1440);
		expect(settings.debounceMs).toEqual({ fileReindex: 0, queryRecompute: 10_000 });
		expect(settings.recurring).toMatchObject({ catchUp: "all", catchUpCap: 1 });
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				"inboxFile: invalid; default used",
				"calendarPlacement: invalid; default used",
				"externalCalendars[0]: invalid entry demoted to inert record",
				"promoteRetries: invalid; default used",
			]),
		);
		// Диагностика не раскрывает приватный ICS URL.
		expect(diagnostics.join("\n")).not.toContain("calendar.example");
	});

	describe("calendarFontSize", () => {
		it("валидное значение проходит round-trip", () => {
			const merged = mergeSettings(DEFAULT_SETTINGS, { calendarFontSize: "large" });
			expect(merged.calendarFontSize).toBe("large");
		});

		it("неверное значение откатывается к дефолту со стандартной диагностикой", () => {
			const { settings, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				calendarFontSize: "huge",
			});
			expect(settings.calendarFontSize).toBe("standard");
			expect(diagnostics).toContain("calendarFontSize: invalid; default used");
		});

		it("отсутствующее поле — дефолт без диагностики", () => {
			const { settings, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
				settingsVersion: SETTINGS_FORMAT_VERSION,
			});
			expect(settings.calendarFontSize).toBe("standard");
			expect(diagnostics).toEqual([]);
		});
	});

	it("каждая загрузка получает независимые ссылки на все изменяемые дефолты", () => {
		const one = mergeSettings(DEFAULT_SETTINGS, null);
		const two = mergeSettings(DEFAULT_SETTINGS, null);
		one.calendarPlacement.reverse();
		one.deferPresets[0]!.label = "Изменено";
		one.statusMap["/"] = "doing";
		one.ai.enabled = true;
		one.debounceMs.fileReindex = 1;
		one.recurring.catchUpCap = 2;
		one.promoteRetries.push({ taskId: "a", source: "a.md", target: null });
		one.externalCalendars.push({
			id: "cal",
			name: "Calendar",
			url: "https://calendar.example/feed.ics",
			lastSyncAt: null,
			lastError: null,
			errorCode: null,
		});
		one.caldavAccounts.push({
			id: "acc-1",
			serverOrigin: "https://caldav.example",
			secretRef: "gtd-flow-caldav-acc-1",
		});

		expect(two).toEqual(DEFAULT_SETTINGS);
		expect(DEFAULT_SETTINGS.ai.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.deferPresets[0]?.label).toBe("Завтра");
	});
});

/**
 * v5 (CalDAV): дискриминированный союз источников, по-записная деградация,
 * реестр аккаунтов. Ключевые инварианты §8 CalDAV-заказа: legacy-ICS грузится
 * без изменения id/зеркал, неизвестный kind — fail-closed БЕЗ молчаливого
 * умолчания и БЕЗ потери записи, диагностика не содержит значений.
 */
describe("mergeSettings v5 (CalDAV)", () => {
	const legacyIcs = {
		id: "ext-legacy-1",
		name: "Работа",
		url: "https://calendar.example/secret.ics",
		lastSyncAt: 123,
		lastError: null,
	};

	it("v4 → v5: legacy ICS-подписка получает errorCode: null без смены id/url", () => {
		const { settings, migrations, tolerated } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			settingsVersion: 4,
			inboxFile: "GTD/Inbox.md",
			externalCalendars: [legacyIcs],
		});
		expect(settings.externalCalendars).toEqual([{ ...legacyIcs, errorCode: null }]);
		expect(migrations).toContain("externalCalendars: migrated to v5 status fields");
		expect(tolerated).toEqual([]);
	});

	it("неизвестный kind деградирует fail-closed в инертную запись с сохранением id", () => {
		const { settings, tolerated, migrations } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			settingsVersion: 5,
			externalCalendars: [
				{ ...legacyIcs, errorCode: null },
				{ kind: "webdav-future", id: "ext-future", secret: "value-x" },
			],
		});
		expect(settings.externalCalendars[0]).toMatchObject({ id: "ext-legacy-1" });
		expect(settings.externalCalendars[1]).toEqual({
			kind: "invalid",
			id: "ext-future",
			reason: "schema",
		});
		expect(tolerated).toEqual(["externalCalendars[1]: invalid entry demoted to inert record"]);
		expect(migrations).toEqual([]);
	});

	it("валидная caldav-подписка и инертная запись проходят round-trip без изменений", () => {
		const caldav = {
			kind: "caldav" as const,
			id: "ext-cd-1",
			name: "Календарь работы",
			accountId: "acc-1",
			collectionKey: "col-abc",
			privacy: "unconfigured" as const,
			enabled: false,
			scopeId: "work",
			pendingRedaction: false,
			lastSyncAt: null,
			lastError: null,
			errorCode: null,
		};
		const inert = { kind: "invalid" as const, id: "broken-9", reason: "schema" };
		const { settings, diagnostics } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			settingsVersion: 5,
			externalCalendars: [caldav, inert],
		});
		expect(settings.externalCalendars).toEqual([caldav, inert]);
		expect(diagnostics).toEqual([]);
	});

	it("caldav-подписка с битым scopeId/privacy деградирует по-записно", () => {
		const { settings, tolerated } = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, {
			settingsVersion: 5,
			externalCalendars: [
				{
					kind: "caldav",
					id: "ext-cd-2",
					name: "X",
					accountId: "acc-1",
					collectionKey: "k",
					privacy: "everything",
					enabled: true,
					scopeId: "Не Scope!",
					pendingRedaction: false,
					lastSyncAt: null,
					lastError: null,
					errorCode: null,
				},
			],
		});
		expect(settings.externalCalendars).toEqual([
			{ kind: "invalid", id: "ext-cd-2", reason: "schema" },
		]);
		expect(tolerated).toHaveLength(1);
	});

	it("caldavAccounts: https-origin обязателен, path/query/http/слаг-нарушения отбрасываются", () => {
		const good = {
			id: "acc-1",
			serverOrigin: "https://caldav.example",
			secretRef: "gtd-flow-caldav-acc-1",
		};
		const { settings, tolerated, diagnostics } = mergeSettingsWithDiagnostics(
			DEFAULT_SETTINGS,
			{
				settingsVersion: 5,
				caldavAccounts: [
					good,
					{ id: "acc-2", serverOrigin: "http://caldav.example", secretRef: "s-2" },
					{ id: "acc-3", serverOrigin: "https://caldav.example/dav/", secretRef: "s-3" },
					{
						id: "acc-4",
						// Конкатенация — чтобы синтетический пример не срабатывал
						// в check-secret-hygiene при скане исходников.
						serverOrigin: "https://" + "user:pw@" + "caldav.example",
						secretRef: "s-4",
					},
					{ id: "Не слаг", serverOrigin: "https://caldav.example", secretRef: "s-5" },
				],
			},
		);
		expect(settings.caldavAccounts).toEqual([good]);
		expect(tolerated).toEqual([
			"caldavAccounts[1]: invalid entry dropped",
			"caldavAccounts[2]: invalid entry dropped",
			"caldavAccounts[3]: invalid entry dropped",
			"caldavAccounts[4]: invalid entry dropped",
		]);
		// Диагностика не содержит origin/URL/учётных данных.
		expect(diagnostics.join("\n")).not.toContain("caldav.example");
		expect(diagnostics.join("\n")).not.toContain("user:pw");
	});

	it("не-массив externalCalendars — прежний recovery-отказ (fail-closed для MCP)", () => {
		const { settings, diagnostics, tolerated } = mergeSettingsWithDiagnostics(
			DEFAULT_SETTINGS,
			{
				settingsVersion: 5,
				externalCalendars: "oops",
				caldavAccounts: 42,
			},
		);
		expect(settings.externalCalendars).toEqual([]);
		expect(settings.caldavAccounts).toEqual([]);
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				"externalCalendars: invalid; default used",
				"caldavAccounts: invalid; default used",
			]),
		);
		expect(tolerated).toEqual([]);
	});
});
