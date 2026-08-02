import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compositionProbe = vi.hoisted(() => ({
	commandDesktopFeatures: [] as boolean[],
	desktopModuleLoads: [] as string[],
	domEvents: [] as string[],
	intervals: [] as unknown[],
	mobileFactoryCalls: 0,
	mobileRegistryLoads: 0,
	onboardingConstructions: 0,
	openTaskCalls: 0,
	registeredCommands: [] as string[],
	registeredViews: [] as Array<{ type: string; creator: (...args: unknown[]) => unknown }>,
	requestCalls: 0,
	settingsDesktopFeatures: [] as boolean[],
	settingsTabs: 0,
}));

vi.mock("./sync/SyncService", () => {
	compositionProbe.desktopModuleLoads.push("sync");
	throw new Error("desktop SyncService loaded during Android startup");
});

vi.mock("./views/dnd/DndService", () => {
	compositionProbe.desktopModuleLoads.push("dnd");
	throw new Error("desktop DndService loaded during Android startup");
});

vi.mock("./ai/integration/DesktopAiServices", () => {
	compositionProbe.desktopModuleLoads.push("ai");
	throw new Error("desktop AI services loaded during Android startup");
});

vi.mock("./views/createView", () => {
	compositionProbe.desktopModuleLoads.push("desktop-views");
	throw new Error("desktop view registry loaded during Android startup");
});

vi.mock("./views/mobileRegistry", () => {
	compositionProbe.mobileRegistryLoads += 1;
	return {
		createMobileGtdView: (..._args: unknown[]) => {
			compositionProbe.mobileFactoryCalls += 1;
			return {};
		},
	};
});

vi.mock("./onboarding/WelcomeModal", () => ({
	WelcomeModal: class {
		constructor() {
			compositionProbe.onboardingConstructions += 1;
		}

		open(): void {}
	},
}));

vi.mock("./commands", () => ({
	registerCommands: (_plugin: unknown, options: { desktopFeatures?: boolean }) => {
		compositionProbe.commandDesktopFeatures.push(options.desktopFeatures ?? true);
	},
}));

vi.mock("./settings/SettingsTab", () => ({
	GtdSettingsTab: class {
		constructor(_app: unknown, _plugin: unknown, options: { desktopFeatures?: boolean }) {
			compositionProbe.settingsDesktopFeatures.push(options.desktopFeatures ?? true);
		}
	},
}));

vi.mock("./views/common/openTask", () => ({
	openTaskInFile: () => {
		compositionProbe.openTaskCalls += 1;
	},
}));

vi.mock("obsidian", () => {
	class Plugin {
		constructor(
			public app: unknown,
			public manifest?: unknown,
		) {}

		addCommand(command: { id: string }): void {
			compositionProbe.registeredCommands.push(command.id);
		}

		addRibbonIcon(): void {}

		addSettingTab(): void {
			compositionProbe.settingsTabs += 1;
		}

		async loadData(): Promise<null> {
			return null;
		}

		register(_disposer: () => void): void {}

		registerDomEvent(_target: unknown, event: string): void {
			compositionProbe.domEvents.push(event);
		}

		registerEvent(_eventRef: unknown): void {}

		registerInterval(id: unknown): void {
			compositionProbe.intervals.push(id);
		}

		registerObsidianProtocolHandler(): void {}

		registerView(type: string, creator: (...args: unknown[]) => unknown): void {
			compositionProbe.registeredViews.push({ type, creator });
		}

		async saveData(): Promise<void> {}
	}

	class Notice {}

	return {
		Notice,
		Platform: { isDesktopApp: false, isMobileApp: true, isPhone: true },
		Plugin,
		requestUrl: async () => {
			compositionProbe.requestCalls += 1;
			throw new Error("network request during Android startup");
		},
	};
});

import GtdFlowPlugin from "./main";
import { VIEW_META } from "./views/registry";

interface MobileHost {
	app: unknown;
	getLayoutReady(): (() => void) | null;
}

function createMobileHost(): MobileHost {
	let layoutReady: (() => void) | null = null;
	const eventRef = (event: string, callback: (...args: unknown[]) => unknown): object => ({
		callback,
		event,
	});
	const vault = {
		getFileByPath: vi.fn(() => null),
		getFiles: vi.fn(() => []),
		getMarkdownFiles: vi.fn(() => []),
		offref: vi.fn(),
		on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) =>
			eventRef(event, callback),
		),
	};
	const metadataCache = {
		initialized: true,
		offref: vi.fn(),
		on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) =>
			eventRef(event, callback),
		),
	};
	const workspace = {
		onLayoutReady: vi.fn((callback: () => void) => {
			layoutReady = callback;
		}),
	};
	return {
		app: {
			metadataCache,
			vault,
			workspace,
		},
		getLayoutReady: () => layoutReady,
	};
}

async function flushMicrotasks(count = 12): Promise<void> {
	for (let iteration = 0; iteration < count; iteration++) await Promise.resolve();
}

describe("GtdFlowPlugin Android composition", () => {
	beforeEach(() => {
		compositionProbe.commandDesktopFeatures = [];
		compositionProbe.desktopModuleLoads = [];
		compositionProbe.domEvents = [];
		compositionProbe.intervals = [];
		compositionProbe.mobileFactoryCalls = 0;
		compositionProbe.mobileRegistryLoads = 0;
		compositionProbe.onboardingConstructions = 0;
		compositionProbe.openTaskCalls = 0;
		compositionProbe.registeredCommands = [];
		compositionProbe.registeredViews = [];
		compositionProbe.requestCalls = 0;
		compositionProbe.settingsDesktopFeatures = [];
		compositionProbe.settingsTabs = 0;
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("boots the mobile slice without importing or starting desktop composition", async () => {
		const host = createMobileHost();
		const PluginConstructor = GtdFlowPlugin as unknown as new (
			app: unknown,
			manifest: unknown,
		) => GtdFlowPlugin;
		const plugin = new PluginConstructor(host.app, {
			id: "gtd-flow",
			name: "GTD Flow",
			version: "test",
		});

		await plugin.onload();

		expect(compositionProbe.desktopModuleLoads).toEqual([]);
		expect(compositionProbe.mobileRegistryLoads).toBe(1);
		expect(plugin.ai).toBeNull();
		expect(plugin.aiViewPort).toBeNull();
		expect(plugin.dnd).toBeNull();
		expect(plugin.sync).toBeNull();
		expect(plugin.taskMetadata).toBeDefined();
		expect(compositionProbe.commandDesktopFeatures).toEqual([false]);
		expect(compositionProbe.settingsDesktopFeatures).toEqual([false]);
		expect(compositionProbe.registeredViews.map(({ type }) => type)).toEqual([
			VIEW_META.inbox.type,
			VIEW_META.calendar.type,
			VIEW_META.recurring.type,
		]);
		for (const { creator } of compositionProbe.registeredViews) creator({});
		expect(compositionProbe.mobileFactoryCalls).toBe(3);
		expect(compositionProbe.settingsTabs).toBe(1);
		expect(compositionProbe.domEvents).toEqual([]);
		expect(compositionProbe.openTaskCalls).toBe(0);
		expect(compositionProbe.requestCalls).toBe(0);
		expect(compositionProbe.registeredCommands).toEqual([
			"open-inbox",
			"open-calendar",
			"open-recurring",
		]);
		// The only startup interval is the mobile-safe day-rollover clock. Desktop
		// calendar sync and metadata-resolve polling are both absent in this host.
		expect(compositionProbe.intervals).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);

		const promotePass = vi.spyOn(plugin.promote, "runPass");
		const recurrencePass = vi.spyOn(plugin.recurrence, "runPass");
		const reconcileOwnership = vi.spyOn(plugin.metadataServices, "reconcileOwnership");
		const layoutReady = host.getLayoutReady();
		expect(layoutReady).toBeTypeOf("function");
		layoutReady?.();
		await flushMicrotasks();

		expect(recurrencePass).toHaveBeenCalledOnce();
		expect(promotePass).not.toHaveBeenCalled();
		expect(reconcileOwnership).not.toHaveBeenCalled();
		expect(compositionProbe.desktopModuleLoads).toEqual([]);
		expect(compositionProbe.onboardingConstructions).toBe(0);
		expect(compositionProbe.intervals).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);

		plugin.onunload();
	});
});
