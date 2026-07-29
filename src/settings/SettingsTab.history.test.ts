import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class FakeElement {
		text = "";
		children: FakeElement[] = [];

		setText(value: string): void {
			this.text = value;
		}

		empty(): void {
			this.text = "";
			this.children = [];
		}

		createEl(_tag: string, options?: { text?: string }): FakeElement {
			const child = new FakeElement();
			child.text = options?.text ?? "";
			this.children.push(child);
			return child;
		}
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
		setName(): this {
			return this;
		}
		setHeading(): this {
			return this;
		}
		setDesc(): this {
			return this;
		}
		addButton(): this {
			return this;
		}
		addText(): this {
			return this;
		}
		addToggle(): this {
			return this;
		}
		addDropdown(): this {
			return this;
		}
	}

	return { Modal, Notice: class {}, PluginSettingTab, Setting };
});

import type {
	AiFeedbackInspection,
	AiFeedbackInspectionEvent,
} from "../ai/integration/AiPluginServices";
import { AiLearningHistoryModal } from "./SettingsTab";

describe("AiLearningHistoryModal", () => {
	it("renders at most the bounded service limit and explains hidden sensitive content", () => {
		const event = (index: number): AiFeedbackInspectionEvent => ({
			id: `event-${index}`,
			taskId: "task-1",
			createdAt: "2026-07-28T00:00:00.000Z",
			kind: "field-locked",
			detail: "locked duration",
			provenance: [],
		});
		const inspection: AiFeedbackInspection = {
			totalEvents: 55,
			invalidRecords: 1,
			omittedEvents: 5,
			events: Array.from({ length: 55 }, (_, index) => event(index)),
		};
		const modal = new AiLearningHistoryModal({} as never, inspection);

		modal.onOpen();
		const rendered = allText((modal as unknown as { contentEl: FakeElementShape }).contentEl);

		expect(rendered).toContain("Показано последних событий: 50 из 55");
		expect(rendered).toContain("данные авторизации здесь намеренно не показываются");
		expect(rendered).toContain("event-49");
		expect(rendered).not.toContain("event-50");
		modal.onClose();
		expect(allText((modal as unknown as { contentEl: FakeElementShape }).contentEl)).toBe("");
	});
});

interface FakeElementShape {
	text: string;
	children: FakeElementShape[];
}

function allText(element: FakeElementShape): string {
	return [element.text, ...element.children.map(allText)].join("\n");
}
