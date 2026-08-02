import { describe, expect, it } from "vitest";
import type GtdFlowPlugin from "../../main";
import { taskMenuPortsFromPlugin } from "./taskMenu";

function pluginStub(): GtdFlowPlugin {
	return {
		boards: {},
		projects: {},
		cards: {},
		taskMetadata: {},
		vaultAdapter: {},
		taskStore: { epoch: {}, index: () => ({ all: () => [] }) },
		settings: { inboxFile: "GTD/Inbox.md" },
	} as unknown as GtdFlowPlugin;
}

describe("taskMenuPortsFromPlugin runtime boundary", () => {
	it("keeps only the shared metadata editor on Android", () => {
		const ports = taskMenuPortsFromPlugin(pluginStub(), { desktopFeatures: false });

		expect(ports.metadata).toBeDefined();
		expect(ports.boards).toBeNull();
		expect(ports.projects).toBeNull();
		expect(ports.cards).toBeNull();
		expect(ports.archive).toBeNull();
		expect(ports.template).toBeNull();
		expect(ports.epoch).toBeNull();
	});

	it("retains the existing desktop task actions", () => {
		const ports = taskMenuPortsFromPlugin(pluginStub(), { desktopFeatures: true });

		expect(ports.boards).toBeDefined();
		expect(ports.projects).toBeDefined();
		expect(ports.cards).toBeDefined();
		expect(ports.archive).toBeDefined();
		expect(ports.template).toBeDefined();
		expect(ports.epoch).toBeDefined();
	});
});
