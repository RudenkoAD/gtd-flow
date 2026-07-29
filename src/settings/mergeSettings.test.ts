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
		// падать, а старый commonRoot используется только для создания inboxFile.
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			inboxSources: ["GTD/Inbox.md"],
			commonRoot: "GTD",
		});
		expect(merged.inboxFile).toBe("GTD/Inbox.md");
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
		expect(merged.inboxFile).toBe("Work/Inbox.md");
		expect(merged.externalCalendars[0]?.url).toBe("webcal://calendar.example/team.ics");
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
		expect(settings.externalCalendars).toEqual([]);
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
				"externalCalendars: invalid; default used",
				"promoteRetries: invalid; default used",
			]),
		);
		// Диагностика не раскрывает приватный ICS URL.
		expect(diagnostics.join("\n")).not.toContain("calendar.example");
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
		});

		expect(two).toEqual(DEFAULT_SETTINGS);
		expect(DEFAULT_SETTINGS.ai.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.deferPresets[0]?.label).toBe("Завтра");
	});
});
