import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalDavAccount, CalDavCalendarSub } from "./Settings";
import { NEVER_ATTEMPTED_STATUS } from "../sync/externalSyncStatus";

const settingProbe = vi.hoisted(() => ({
	thenCalls: 0,
	descriptions: [] as string[],
	names: [] as string[],
	textControls: [] as Array<{
		name: string;
		setValue: (value: string) => void;
		listeners: Map<string, (event: { key?: string; preventDefault?: () => void }) => void>;
	}>,
	textChanges: [] as Array<{ name: string; handler: (value: string) => unknown }>,
	buttons: [] as Array<{
		name: string;
		buttonText: string;
		cta: boolean;
		warning: boolean;
		disabled: boolean;
		click: () => unknown;
	}>,
	extraButtons: [] as Array<{
		name: string;
		icon: string;
		tooltip: string;
		disabled: boolean;
		click: () => unknown;
	}>,
	dropdowns: [] as Array<{
		name: string;
		options: Array<{ value: string; label: string }>;
		value: string;
		disabled: boolean;
		change: (value: string) => unknown;
	}>,
	toggles: [] as Array<{
		name: string;
		value: boolean;
		disabled: boolean;
		change: (value: boolean) => unknown;
	}>,
	secretComponents: [] as Array<{ value: string; change: (value: string) => unknown }>,
}));

function resetSettingProbe(): void {
	settingProbe.thenCalls = 0;
	settingProbe.descriptions = [];
	settingProbe.names = [];
	settingProbe.textControls = [];
	settingProbe.textChanges = [];
	settingProbe.buttons = [];
	settingProbe.extraButtons = [];
	settingProbe.dropdowns = [];
	settingProbe.toggles = [];
	settingProbe.secretComponents = [];
}

vi.mock("obsidian", () => {
	class FakeElement {
		readonly style: Record<string, string> = {};

		empty(): void {}

		createDiv(): FakeElement {
			return new FakeElement();
		}

		setText(): void {}
	}

	class Modal {
		readonly titleEl = new FakeElement();
		readonly contentEl = new FakeElement();
		constructor(public app: unknown) {}
		open(): void {}
		close(): void {}
	}

	class PluginSettingTab {
		readonly containerEl = new FakeElement();
		constructor(
			public app: unknown,
			public plugin: unknown,
		) {}
	}

	class FakeButton {
		buttonText = "";
		cta = false;
		warning = false;
		disabled = false;
		private handler: (() => unknown) | null = null;

		constructor(readonly name: string) {
			settingProbe.buttons.push(this);
		}

		setButtonText(text: string): this {
			this.buttonText = text;
			return this;
		}

		setCta(): this {
			this.cta = true;
			return this;
		}

		setWarning(): this {
			this.warning = true;
			return this;
		}

		setTooltip(_tooltip: string): this {
			return this;
		}

		setDisabled(disabled: boolean): this {
			this.disabled = disabled;
			return this;
		}

		onClick(handler: () => unknown): this {
			this.handler = handler;
			return this;
		}

		click(): unknown {
			return this.handler?.();
		}
	}

	class FakeExtraButton {
		icon = "";
		tooltip = "";
		disabled = false;
		private handler: (() => unknown) | null = null;

		constructor(readonly name: string) {
			settingProbe.extraButtons.push(this);
		}

		setIcon(icon: string): this {
			this.icon = icon;
			return this;
		}

		setTooltip(tooltip: string): this {
			this.tooltip = tooltip;
			return this;
		}

		setDisabled(disabled: boolean): this {
			this.disabled = disabled;
			return this;
		}

		onClick(handler: () => unknown): this {
			this.handler = handler;
			return this;
		}

		click(): unknown {
			return this.handler?.();
		}
	}

	class FakeDropdown {
		options: Array<{ value: string; label: string }> = [];
		value = "";
		disabled = false;
		private handler: ((value: string) => unknown) | null = null;

		constructor(readonly name: string) {
			settingProbe.dropdowns.push(this);
		}

		addOption(value: string, label: string): this {
			this.options.push({ value, label });
			return this;
		}

		setValue(value: string): this {
			this.value = value;
			return this;
		}

		getValue(): string {
			return this.value;
		}

		setDisabled(disabled: boolean): this {
			this.disabled = disabled;
			return this;
		}

		onChange(handler: (value: string) => unknown): this {
			this.handler = handler;
			return this;
		}

		change(value: string): unknown {
			this.value = value;
			return this.handler?.(value);
		}
	}

	class FakeToggle {
		value = false;
		disabled = false;
		private handler: ((value: boolean) => unknown) | null = null;

		constructor(readonly name: string) {
			settingProbe.toggles.push(this);
		}

		setValue(value: boolean): this {
			this.value = value;
			return this;
		}

		getValue(): boolean {
			return this.value;
		}

		setDisabled(disabled: boolean): this {
			this.disabled = disabled;
			return this;
		}

		onChange(handler: (value: boolean) => unknown): this {
			this.handler = handler;
			return this;
		}

		change(value: boolean): unknown {
			this.value = value;
			return this.handler?.(value);
		}
	}

	/** Fake обёртки obsidian.SecretComponent (masked OAuth-токен, §9). */
	class SecretComponent {
		value = "";
		private handler: ((value: string) => unknown) | null = null;

		constructor(
			public app: unknown,
			public containerEl: unknown,
		) {
			settingProbe.secretComponents.push(this);
		}

		setValue(value: string): this {
			this.value = value;
			return this;
		}

		onChange(handler: (value: string) => unknown): this {
			this.handler = handler;
			return this;
		}

		change(value: string): unknown {
			this.value = value;
			return this.handler?.(value);
		}
	}

	class Setting {
		readonly settingEl = new FakeElement();
		private name = "";

		constructor(_container: unknown) {}

		setName(name: string): this {
			this.name = name;
			settingProbe.names.push(name);
			return this;
		}

		setHeading(): this {
			return this;
		}

		setDesc(description: string): this {
			settingProbe.descriptions.push(description);
			return this;
		}

		addButton(callback: (component: FakeButton) => void): this {
			callback(new FakeButton(this.name));
			return this;
		}

		addText(callback: (text: FakeText) => void): this {
			callback(new FakeText(this.name));
			return this;
		}

		addTextArea(): this {
			return this;
		}

		addToggle(callback: (component: FakeToggle) => void): this {
			callback(new FakeToggle(this.name));
			return this;
		}

		addDropdown(callback: (component: FakeDropdown) => void): this {
			callback(new FakeDropdown(this.name));
			return this;
		}

		addExtraButton(callback: (component: FakeExtraButton) => void): this {
			callback(new FakeExtraButton(this.name));
			return this;
		}

		addComponent<T>(callback: (el: unknown) => T): this {
			callback({});
			return this;
		}

		/**
		 * Obsidian Settings are thenables. Resolve safely to `undefined`
		 * here so a regression is observable without recreating the runtime's
		 * infinite self-assimilation loop inside Vitest.
		 */
		then(resolve: (value: undefined) => void): this {
			settingProbe.thenCalls += 1;
			resolve(undefined);
			return this;
		}
	}

	class FakeText {
		readonly inputEl: HTMLInputElement;
		private value = "";

		constructor(private readonly settingName: string) {
			const listeners = new Map<
				string,
				(event: { key?: string; preventDefault?: () => void }) => void
			>();
			this.inputEl = {
				addEventListener: vi.fn((event: string, handler: (event: never) => void) => {
					listeners.set(
						event,
						handler as (event: { key?: string; preventDefault?: () => void }) => void,
					);
				}),
				blur: vi.fn(() => listeners.get("blur")?.({})),
				style: {},
				type: "",
			} as unknown as HTMLInputElement;
			settingProbe.textControls.push({
				name: settingName,
				setValue: (value) => this.setValue(value),
				listeners,
			});
		}

		setPlaceholder(_placeholder: string): this {
			return this;
		}

		setValue(value: string): this {
			this.value = value;
			return this;
		}

		getValue(): string {
			return this.value;
		}

		onChange(handler: (value: string) => unknown): this {
			settingProbe.textChanges.push({ name: this.settingName, handler });
			return this;
		}
	}

	return { Modal, Notice: class {}, PluginSettingTab, SecretComponent, Setting };
});

import { createDefaultSettings } from "./Settings";
import { GtdSettingsTab } from "./SettingsTab";

/** Минимальный фейк-план каталога scope: пустой, мутации разрешены. */
function emptyScopes() {
	return {
		current: () => ({ schemaVersion: 1 as const, scopes: [] }),
		isMutationSafe: () => true,
	};
}

/** Фейк-синк текущего процесса: только runtimeStatus нужен рендеру строк подписки. */
function fakeDesktopCalendarSync() {
	return () => ({ runtimeStatus: () => NEVER_ATTEMPTED_STATUS });
}

function accountFixture(overrides: Partial<CalDavAccount> = {}): CalDavAccount {
	return {
		id: "acc-1",
		serverOrigin: "https://caldav.fixture.example",
		secretRef: "gtd-flow-caldav-acc-1",
		...overrides,
	};
}

function caldavSubFixture(overrides: Partial<CalDavCalendarSub> = {}): CalDavCalendarSub {
	return {
		kind: "caldav",
		id: "sub-1",
		name: "Личный",
		accountId: "acc-1",
		collectionKey: "ck-abc123",
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

describe("GtdSettingsTab display", () => {
	beforeEach(() => {
		resetSettingProbe();
	});

	it.each([
		{
			name: "resolved",
			summary: () =>
				Promise.resolve({
					events: 0,
					invalidRecords: 0,
					pendingOutbox: 0,
					conflictedOutbox: 0,
					invalidOutboxRecords: 0,
				}),
			description: "Синхронизированных событий: 0",
		},
		{
			name: "rejected",
			summary: () => Promise.reject(new Error("unavailable")),
			description: "Историю сейчас прочитать не удалось.",
		},
	])(
		"does not return Obsidian Setting thenables when feedback loading is $name",
		async ({ summary, description }) => {
			const plugin = {
				settings: createDefaultSettings(),
				scopes: emptyScopes(),
				ai: {
					feedbackSummary: summary,
				},
			};
			const tab = new GtdSettingsTab({} as never, plugin as never);

			tab.display();
			await Promise.resolve();
			await Promise.resolve();

			expect(settingProbe.thenCalls).toBe(0);
			expect(settingProbe.descriptions).toContainEqual(expect.stringContaining(description));
		},
	);

	it("shows only Android-MVP settings when desktop features are disabled", () => {
		const plugin = {
			settings: createDefaultSettings(),
			scopes: emptyScopes(),
		};
		const tab = new GtdSettingsTab({} as never, plugin as never, {
			desktopFeatures: false,
		});

		tab.display();

		expect(settingProbe.names).toContain("Входящие");
		expect(settingProbe.names).toContain("Scope");
		expect(settingProbe.names).toContain("Календарь");
		expect(settingProbe.names).toContain("Регулярные");
		expect(settingProbe.names).not.toContain("AI и оценки");
		expect(settingProbe.names).not.toContain("Внешние календари");
		expect(settingProbe.names).not.toContain("Возврат отложенной задачи");
	});

	it("renders the calendar font size dropdown with all four presets", () => {
		const plugin = {
			settings: createDefaultSettings(),
			scopes: emptyScopes(),
			ai: null,
		};
		const tab = new GtdSettingsTab({} as never, plugin as never);

		tab.display();

		expect(settingProbe.names).toContain("Размер шрифта календаря");
		const fontSize = settingProbe.dropdowns.find((d) => d.name === "Размер шрифта календаря");
		expect(fontSize).toBeDefined();
		expect(fontSize?.value).toBe("standard");
		expect(fontSize?.options).toEqual([
			{ value: "small", label: "Мелкий" },
			{ value: "standard", label: "Стандартный" },
			{ value: "large", label: "Крупный" },
			{ value: "x-large", label: "Очень крупный" },
		]);
	});

	it("updates the inbox path on Android without touching desktop calendar sync", async () => {
		const settings = createDefaultSettings();
		const saveSettings = vi.fn(async () => undefined);
		const desktopCalendarSync = vi.fn(() => {
			throw new Error("desktop sync must stay unavailable on Android");
		});
		const plugin = {
			settings,
			scopes: emptyScopes(),
			saveSettings,
			desktopCalendarSync,
		};
		const tab = new GtdSettingsTab({} as never, plugin as never, {
			desktopFeatures: false,
		});
		tab.display();
		const inboxText = settingProbe.textControls.find(
			(control) => control.name === "Файл входящих",
		);

		expect(inboxText).toBeDefined();
		inboxText?.setValue("  GTD/Mobile Inbox.md  ");
		expect(() => inboxText?.listeners.get("blur")?.({})).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();

		expect(settings.inboxFile).toBe("GTD/Mobile Inbox.md");
		expect(saveSettings).toHaveBeenCalledOnce();
		expect(desktopCalendarSync).not.toHaveBeenCalled();
	});

	describe("CalDAV (§9 CalDAV-заказа)", () => {
		it("renders the CalDAV accounts heading and the add-account button on desktop", () => {
			const plugin = {
				settings: createDefaultSettings(),
				scopes: emptyScopes(),
				ai: null,
				caldavCredentials: { get: () => null, setPayload: vi.fn(), clearPayload: vi.fn() },
				desktopCalendarSync: fakeDesktopCalendarSync(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, { calendarSync: true });

			tab.display();

			expect(settingProbe.names).toContain("CalDAV-аккаунты (read-only)");
			expect(
				settingProbe.buttons.some((b) => b.buttonText === "Добавить CalDAV-аккаунт"),
			).toBe(true);
		});

		it("omits the CalDAV heading and add-account button when calendar sync is disabled (mobile)", () => {
			const plugin = {
				settings: createDefaultSettings(),
				scopes: emptyScopes(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, {
				desktopFeatures: false,
				calendarSync: false,
			});

			tab.display();

			expect(settingProbe.names).not.toContain("CalDAV-аккаунты (read-only)");
			expect(
				settingProbe.buttons.some((b) => b.buttonText === "Добавить CalDAV-аккаунт"),
			).toBe(false);
		});

		it("account row + caldav sub row: privacy dropdown defaults to unconfigured, Включена is disabled", () => {
			const settings = createDefaultSettings();
			settings.caldavAccounts.push(accountFixture());
			settings.externalCalendars.push(caldavSubFixture());
			const plugin = {
				settings,
				scopes: emptyScopes(),
				ai: null,
				caldavCredentials: {
					get: () => ({ username: "u", token: "t" }),
					setPayload: vi.fn(),
					clearPayload: vi.fn(),
				},
				desktopCalendarSync: fakeDesktopCalendarSync(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, { calendarSync: true });

			tab.display();

			expect(settingProbe.names).toContain("https://caldav.fixture.example");

			const privacy = settingProbe.dropdowns.find((d) => d.name === "Приватность");
			expect(privacy).toBeDefined();
			expect(privacy?.value).toBe("unconfigured");
			expect(privacy?.options).toContainEqual({
				value: "unconfigured",
				label: "— выберите режим —",
			});

			const enabledToggle = settingProbe.toggles.find((t) => t.name === "Включена");
			expect(enabledToggle).toBeDefined();
			expect(enabledToggle?.disabled).toBe(true);
		});

		it("caldav sub row: Включена becomes available once privacy is busy (and unconfigured is no longer offered)", () => {
			const settings = createDefaultSettings();
			settings.caldavAccounts.push(accountFixture());
			settings.externalCalendars.push(caldavSubFixture({ privacy: "busy" }));
			const plugin = {
				settings,
				scopes: emptyScopes(),
				ai: null,
				caldavCredentials: {
					get: () => ({ username: "u", token: "t" }),
					setPayload: vi.fn(),
					clearPayload: vi.fn(),
				},
				desktopCalendarSync: fakeDesktopCalendarSync(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, { calendarSync: true });

			tab.display();

			const privacy = settingProbe.dropdowns.find((d) => d.name === "Приватность");
			expect(privacy?.value).toBe("busy");
			expect(privacy?.options.some((o) => o.value === "unconfigured")).toBe(false);

			const enabledToggle = settingProbe.toggles.find((t) => t.name === "Включена");
			expect(enabledToggle?.disabled).toBe(false);
		});

		it("shows the missing-credential marker only for the account without a stored secret", () => {
			const settings = createDefaultSettings();
			settings.caldavAccounts.push(
				accountFixture({
					id: "acc-ok",
					serverOrigin: "https://ok.fixture.example",
					secretRef: "gtd-flow-caldav-acc-ok",
				}),
				accountFixture({
					id: "acc-missing",
					serverOrigin: "https://missing.fixture.example",
					secretRef: "gtd-flow-caldav-acc-missing",
				}),
			);
			const plugin = {
				settings,
				scopes: emptyScopes(),
				ai: null,
				caldavCredentials: {
					get: (id: string) => (id === "acc-ok" ? { username: "u", token: "t" } : null),
					setPayload: vi.fn(),
					clearPayload: vi.fn(),
				},
				desktopCalendarSync: fakeDesktopCalendarSync(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, { calendarSync: true });

			tab.display();

			const okDesc = settingProbe.descriptions.find((d) =>
				d.includes("gtd-flow-caldav-acc-ok"),
			);
			const missingDesc = settingProbe.descriptions.find((d) =>
				d.includes("gtd-flow-caldav-acc-missing"),
			);
			expect(okDesc).toBeDefined();
			expect(okDesc).toContain("учётные данные заданы");
			expect(okDesc).not.toContain("не заданы");
			expect(missingDesc).toBeDefined();
			expect(missingDesc).toContain("не заданы на этом устройстве");
		});

		it("regression: invalid-record and ICS subscription rows still render; CalDAV gate shows when SecretStorage is absent", () => {
			const settings = createDefaultSettings();
			settings.externalCalendars.push(
				{ kind: "invalid", id: "bad-1", reason: "schema" },
				{
					id: "ics-1",
					name: "Праздники",
					url: "https://ics.fixture.example/feed.ics",
					lastSyncAt: null,
					lastError: null,
					errorCode: null,
				},
			);
			const plugin = {
				settings,
				scopes: emptyScopes(),
				ai: null,
				caldavCredentials: null,
				desktopCalendarSync: fakeDesktopCalendarSync(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, { calendarSync: true });

			tab.display();

			expect(settingProbe.names).toContain("Повреждённая запись подписки");
			expect(settingProbe.names).toContain("Праздники");
			expect(settingProbe.names).toContain("Адрес ленты (.ics)");
			// caldavCredentials === null → гейт "недоступен", БЕЗ добавления аккаунтов.
			expect(settingProbe.names).toContain("CalDAV недоступен");
			expect(
				settingProbe.buttons.some((b) => b.buttonText === "Добавить CalDAV-аккаунт"),
			).toBe(false);
		});

		it("hygiene: never renders the cached href or the stored token/login — only the bare account origin and opaque refs", () => {
			const FIXTURE_ORIGIN = "https://caldav.fixture.example";
			const FIXTURE_TOKEN = "s3cr3t-token-fixture-9f2a";
			const FIXTURE_LOGIN = "corp-user-fixture";
			const FIXTURE_HREF = "https://caldav.fixture.example/dav/personal-calendar/";
			const settings = createDefaultSettings();
			settings.caldavAccounts.push(
				accountFixture({
					serverOrigin: FIXTURE_ORIGIN,
					secretRef: "gtd-flow-caldav-acc-1",
				}),
			);
			settings.externalCalendars.push(caldavSubFixture());
			const plugin = {
				settings,
				scopes: emptyScopes(),
				ai: null,
				caldavCredentials: {
					get: () => ({
						username: FIXTURE_LOGIN,
						token: FIXTURE_TOKEN,
						collections: { "ck-abc123": FIXTURE_HREF },
					}),
					setPayload: vi.fn(),
					clearPayload: vi.fn(),
				},
				desktopCalendarSync: fakeDesktopCalendarSync(),
			};
			const tab = new GtdSettingsTab({} as never, plugin as never, { calendarSync: true });

			tab.display();

			const allText = [...settingProbe.names, ...settingProbe.descriptions];
			// Секретные значения (токен, кэшированный href коллекции, логин) не имеют
			// права появиться ни в одной строке настройки — рендерятся только opaque
			// secretRef, origin (не identity-bearing сам по себе) и collectionKey.
			expect(allText.some((s) => s.includes(FIXTURE_TOKEN))).toBe(false);
			expect(allText.some((s) => s.includes(FIXTURE_HREF))).toBe(false);
			expect(allText.some((s) => s.includes(FIXTURE_LOGIN))).toBe(false);
			// Единственное место, где вообще появляется origin, — строка самого аккаунта.
			expect(allText.filter((s) => s.includes(FIXTURE_ORIGIN)).length).toBeGreaterThan(0);
		});
	});
});
