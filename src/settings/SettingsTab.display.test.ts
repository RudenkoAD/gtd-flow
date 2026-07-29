import { describe, expect, it, vi } from "vitest";

const settingProbe = vi.hoisted(() => ({
	thenCalls: 0,
	descriptions: [] as string[],
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

		constructor(_container: unknown) {}

		setName(): this {
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

		addText(): this {
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
			const plugin = {
				settings: createDefaultSettings(),
				scopes: {
					current: () => ({ schemaVersion: 1, scopes: [] }),
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
});
