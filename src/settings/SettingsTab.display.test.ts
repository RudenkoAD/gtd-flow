import { describe, expect, it, vi } from "vitest";

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
}));

vi.mock("obsidian", () => {
	class FakeElement {
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

		addButton(): this {
			return this;
		}

		addText(callback: (text: FakeText) => void): this {
			callback(new FakeText(this.name));
			return this;
		}

		addTextArea(): this {
			return this;
		}

		addToggle(): this {
			return this;
		}

		addDropdown(): this {
			return this;
		}

		addExtraButton(): this {
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

	return { Modal, Notice: class {}, PluginSettingTab, Setting };
});

import { createDefaultSettings } from "./Settings";
import { GtdSettingsTab } from "./SettingsTab";

describe("GtdSettingsTab display", () => {
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
			settingProbe.thenCalls = 0;
			settingProbe.descriptions = [];
			settingProbe.names = [];
			settingProbe.textControls = [];
			settingProbe.textChanges = [];
			const plugin = {
				settings: createDefaultSettings(),
				scopes: {
					current: () => ({ schemaVersion: 1, scopes: [] }),
					isMutationSafe: () => true,
				},
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
		settingProbe.names = [];
		settingProbe.textControls = [];
		settingProbe.textChanges = [];
		const plugin = {
			settings: createDefaultSettings(),
			scopes: {
				current: () => ({ schemaVersion: 1, scopes: [] }),
				isMutationSafe: () => true,
			},
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

	it("updates the inbox path on Android without touching desktop calendar sync", async () => {
		settingProbe.names = [];
		settingProbe.textControls = [];
		settingProbe.textChanges = [];
		const settings = createDefaultSettings();
		const saveSettings = vi.fn(async () => undefined);
		const desktopCalendarSync = vi.fn(() => {
			throw new Error("desktop sync must stay unavailable on Android");
		});
		const plugin = {
			settings,
			scopes: {
				current: () => ({ schemaVersion: 1, scopes: [] }),
				isMutationSafe: () => true,
			},
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
});
