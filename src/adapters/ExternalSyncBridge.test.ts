/**
 * ExternalSyncBridge — фейковый BridgeFsPort поверх Map, БЕЗ импорта
 * 'obsidian' (см. модульный докблок адаптера). Покрытие: публикация статуса,
 * защита от репликации на чужое устройство (§5.1/D7), TTL запросов/ответов,
 * fail-closed разбор мусора, строгая последовательность исполнения, гигиена
 * предупреждений (никаких сырых payload'ов).
 */
import { describe, expect, it, vi } from "vitest";
import {
	BRIDGE_FORMAT_VERSION,
	BRIDGE_REQUEST_DIR,
	BRIDGE_REQUEST_TTL_MS,
	BRIDGE_RESPONSE_TTL_MS,
	BRIDGE_STATUS_FILE,
	bridgeRequestPath,
	bridgeResponsePath,
} from "../sync/bridgeProtocol";
import type { ExternalSyncReport } from "../sync/externalSyncStatus";
import type { BridgeFsPort, ExternalSyncBridgeDeps } from "./ExternalSyncBridge";
import { ExternalSyncBridge, bridgeDeviceIdOf } from "./ExternalSyncBridge";

function makeFs(initial: Record<string, string> = {}): {
	fs: BridgeFsPort;
	files: Map<string, string>;
} {
	const files = new Map<string, string>(Object.entries(initial));
	const fs: BridgeFsPort = {
		async read(path: string): Promise<string> {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing:${path}`);
			return value;
		},
		async write(path: string, data: string): Promise<void> {
			files.set(path, data);
		},
		async exists(path: string): Promise<boolean> {
			return files.has(path);
		},
		async list(dirPath: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = `${dirPath}/`;
			return {
				files: [...files.keys()].filter((path) => path.startsWith(prefix)),
				folders: [],
			};
		},
		async remove(path: string): Promise<void> {
			files.delete(path);
		},
		async mkdir(): Promise<void> {
			// фейковой ФС не нужно реально отслеживать каталоги
		},
	};
	return { fs, files };
}

function sampleReport(overrides: Partial<ExternalSyncReport> = {}): ExternalSyncReport {
	return {
		status: "ok",
		startedAt: 1,
		finishedAt: 2,
		changedMirrors: 0,
		subscriptions: [],
		...overrides,
	};
}

function putRequest(
	files: Map<string, string>,
	requestId: string,
	targetDeviceId: string,
	requestedAt: number,
): void {
	files.set(
		bridgeRequestPath(requestId),
		JSON.stringify({
			formatVersion: BRIDGE_FORMAT_VERSION,
			requestId,
			targetDeviceId,
			requestedAt,
		}),
	);
}

function putResponse(
	files: Map<string, string>,
	requestId: string,
	deviceId: string,
	finishedAt: number,
): void {
	files.set(
		bridgeResponsePath(requestId),
		JSON.stringify({
			formatVersion: BRIDGE_FORMAT_VERSION,
			requestId,
			deviceId,
			finishedAt,
			report: sampleReport(),
		}),
	);
}

function makeBridge(
	overrides: Partial<ExternalSyncBridgeDeps> & { fs: BridgeFsPort },
): ExternalSyncBridge {
	return new ExternalSyncBridge({
		deviceId: "dev-1",
		syncAll: async () => sampleReport(),
		now: () => 1_000,
		...overrides,
	});
}

describe("ExternalSyncBridge.publishStatus", () => {
	it("пишет парсируемый артефакт с deviceId и отчётом; перезаписывает при повторном вызове", async () => {
		const { fs, files } = makeFs();
		const bridge = makeBridge({ fs, now: () => 1_000 });

		await bridge.publishStatus(sampleReport());
		expect(JSON.parse(files.get(BRIDGE_STATUS_FILE)!)).toEqual({
			formatVersion: BRIDGE_FORMAT_VERSION,
			deviceId: "dev-1",
			updatedAt: 1_000,
			report: sampleReport(),
		});

		const report2 = sampleReport({ changedMirrors: 7, status: "partial" });
		await bridge.publishStatus(report2);
		expect(JSON.parse(files.get(BRIDGE_STATUS_FILE)!)).toEqual({
			formatVersion: BRIDGE_FORMAT_VERSION,
			deviceId: "dev-1",
			updatedAt: 1_000,
			report: report2,
		});
	});
});

describe("ExternalSyncBridge.processRequests — исполнение", () => {
	it("свежий адресованный нам запрос: syncAll вызывается один раз, ответ пишется, запрос удаляется", async () => {
		const { fs, files } = makeFs();
		putRequest(files, "req-fresh", "dev-1", 1_000);
		const syncAll = vi.fn(async () => sampleReport({ changedMirrors: 3 }));
		const bridge = makeBridge({ fs, syncAll, now: () => 1_000 });

		const executed = await bridge.processRequests();

		expect(executed).toBe(1);
		expect(syncAll).toHaveBeenCalledTimes(1);
		expect(files.has(bridgeRequestPath("req-fresh"))).toBe(false);
		expect(JSON.parse(files.get(bridgeResponsePath("req-fresh"))!)).toEqual({
			formatVersion: BRIDGE_FORMAT_VERSION,
			requestId: "req-fresh",
			deviceId: "dev-1",
			finishedAt: 1_000,
			report: sampleReport({ changedMirrors: 3 }),
		});
	});

	it("запрос для чужого устройства: файл остаётся нетронутым, syncAll не вызывается", async () => {
		const { fs, files } = makeFs();
		putRequest(files, "req-foreign", "dev-other", 1_000);
		const syncAll = vi.fn(async () => sampleReport());
		const bridge = makeBridge({ fs, syncAll, now: () => 1_000 });

		const executed = await bridge.processRequests();

		expect(executed).toBe(0);
		expect(syncAll).not.toHaveBeenCalled();
		expect(files.has(bridgeRequestPath("req-foreign"))).toBe(true);
	});

	it("просроченный запрос (в прошлом) удаляется без исполнения", async () => {
		const { fs, files } = makeFs();
		const now = 1_000_000;
		putRequest(files, "req-old", "dev-1", now - BRIDGE_REQUEST_TTL_MS - 1);
		const syncAll = vi.fn(async () => sampleReport());
		const bridge = makeBridge({ fs, syncAll, now: () => now });

		const executed = await bridge.processRequests();

		expect(executed).toBe(0);
		expect(syncAll).not.toHaveBeenCalled();
		expect(files.has(bridgeRequestPath("req-old"))).toBe(false);
	});

	it("запрос с requestedAt далеко в будущем ('часы вперёд') удаляется без исполнения", async () => {
		const { fs, files } = makeFs();
		const now = 1_000_000;
		putRequest(files, "req-future", "dev-1", now + BRIDGE_REQUEST_TTL_MS + 1);
		const syncAll = vi.fn(async () => sampleReport());
		const bridge = makeBridge({ fs, syncAll, now: () => now });

		const executed = await bridge.processRequests();

		expect(executed).toBe(0);
		expect(syncAll).not.toHaveBeenCalled();
		expect(files.has(bridgeRequestPath("req-future"))).toBe(false);
	});

	it("мусорный/непарсируемый файл запроса удаляется, паники нет, предупреждение записано", async () => {
		const { fs, files } = makeFs();
		files.set(`${BRIDGE_REQUEST_DIR}/sync-garbage.json`, "not json at all {{{");
		const warnings: string[] = [];
		const syncAll = vi.fn(async () => sampleReport());
		const bridge = makeBridge({
			fs,
			syncAll,
			onWarning: (message) => warnings.push(message),
		});

		const executed = await expect(bridge.processRequests()).resolves.toBe(0);
		void executed;

		expect(syncAll).not.toHaveBeenCalled();
		expect(files.has(`${BRIDGE_REQUEST_DIR}/sync-garbage.json`)).toBe(false);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("два свежих запроса исполняются строго последовательно (без параллельных syncAll)", async () => {
		const { fs, files } = makeFs();
		putRequest(files, "req-aaa", "dev-1", 1_000);
		putRequest(files, "req-bbb", "dev-1", 1_000);

		const events: string[] = [];
		const gates: Array<() => void> = [];
		const syncAll = vi.fn(() => {
			const index = gates.length;
			events.push(`start${index}`);
			return new Promise<ExternalSyncReport>((resolve) => {
				gates.push(() => {
					events.push(`end${index}`);
					resolve(sampleReport());
				});
			});
		});
		const bridge = makeBridge({ fs, syncAll, now: () => 1_000 });

		const pending = bridge.processRequests();

		await vi.waitFor(() => expect(gates.length).toBe(1));
		expect(events).toEqual(["start0"]);
		gates[0]?.();

		await vi.waitFor(() => expect(gates.length).toBe(2));
		expect(events).toEqual(["start0", "end0", "start1"]);
		gates[1]?.();

		const executed = await pending;

		expect(executed).toBe(2);
		expect(events).toEqual(["start0", "end0", "start1", "end1"]);
		expect(syncAll).toHaveBeenCalledTimes(2);
		expect(files.has(bridgeResponsePath("req-aaa"))).toBe(true);
		expect(files.has(bridgeResponsePath("req-bbb"))).toBe(true);
	});

	it("отказ syncAll: запрос удаляется, ответ не пишется, предупреждение записано, executed не считает провал", async () => {
		const { fs, files } = makeFs();
		putRequest(files, "req-boom", "dev-1", 1_000);
		const warnings: string[] = [];
		const syncAll = vi.fn(async () => {
			throw new Error("network exploded");
		});
		const bridge = makeBridge({
			fs,
			syncAll,
			now: () => 1_000,
			onWarning: (message) => warnings.push(message),
		});

		const executed = await bridge.processRequests();

		expect(executed).toBe(0);
		expect(files.has(bridgeRequestPath("req-boom"))).toBe(false);
		expect(files.has(bridgeResponsePath("req-boom"))).toBe(false);
		expect(warnings.length).toBeGreaterThan(0);
	});
});

describe("ExternalSyncBridge.processRequests — уборка ответов", () => {
	it("старый свой ответ удаляется; свежий свой остаётся; чужой не трогается", async () => {
		const { fs, files } = makeFs();
		const now = 1_000_000;
		putResponse(files, "resp-old-own", "dev-1", now - BRIDGE_RESPONSE_TTL_MS - 1);
		putResponse(files, "resp-fresh-own", "dev-1", now - 1_000);
		putResponse(files, "resp-foreign", "dev-other", now - BRIDGE_RESPONSE_TTL_MS - 1);
		const bridge = makeBridge({ fs, now: () => now });

		const executed = await bridge.processRequests();

		expect(executed).toBe(0);
		expect(files.has(bridgeResponsePath("resp-old-own"))).toBe(false);
		expect(files.has(bridgeResponsePath("resp-fresh-own"))).toBe(true);
		expect(files.has(bridgeResponsePath("resp-foreign"))).toBe(true);
	});
});

describe("ExternalSyncBridge — гигиена предупреждений", () => {
	it("маркер из мусорного файла не попадает ни в одно предупреждение", async () => {
		const { fs, files } = makeFs();
		const marker = "SECRET_MARKER_SHOULD_NOT_LEAK_9f3a";
		files.set(`${BRIDGE_REQUEST_DIR}/sync-garbage.json`, `totally not json ${marker}`);
		const warnings: string[] = [];
		const bridge = makeBridge({ fs, onWarning: (message) => warnings.push(message) });

		await bridge.processRequests();

		expect(warnings.length).toBeGreaterThan(0);
		for (const warning of warnings) expect(warning).not.toContain(marker);
	});
});

describe("bridgeDeviceIdOf", () => {
	it("app.appId непустой строкой -> используется как есть", () => {
		expect(bridgeDeviceIdOf({ appId: "installed-app-id" })).toBe("installed-app-id");
	});

	it("appId отсутствует и fallbackStore пуст -> генерируется И персистится через set()", () => {
		let stored: string | null = null;
		const store = {
			get: (): string | null => stored,
			set: (id: string): void => {
				stored = id;
			},
		};

		const id = bridgeDeviceIdOf({}, store);

		expect(id).toMatch(/^dev-[a-z0-9]{12}$/u);
		expect(stored).toBe(id);
	});

	it("второй вызов со store, вернувшим уже сохранённый id -> тот же id, set() не вызывается снова", () => {
		const store = {
			get: (): string | null => "dev-alreadypersisted",
			set: vi.fn(),
		};

		expect(bridgeDeviceIdOf({}, store)).toBe("dev-alreadypersisted");
		expect(store.set).not.toHaveBeenCalled();
	});

	it("без fallbackStore: генерируется непостоянный id (валидный формат)", () => {
		expect(bridgeDeviceIdOf({})).toMatch(/^dev-[a-z0-9]{12}$/u);
	});

	it("appId не строка (или пустая) -> fallback используется", () => {
		const store = { get: (): string | null => "dev-fallback-1", set: vi.fn() };
		expect(bridgeDeviceIdOf({ appId: "" }, store)).toBe("dev-fallback-1");
		expect(bridgeDeviceIdOf({ appId: 42 }, store)).toBe("dev-fallback-1");
	});
});
