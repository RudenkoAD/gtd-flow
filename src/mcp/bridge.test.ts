import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BRIDGE_FORMAT_VERSION,
	BRIDGE_REQUEST_DIR,
	BRIDGE_RESPONSE_DIR,
	BRIDGE_STATUS_FILE,
	isBridgeRequestId,
} from "../sync/bridgeProtocol";
import type { ExternalSyncReport } from "../sync/externalSyncStatus";
import { readExternalSyncStatus, syncExternalCalendarsViaBridge } from "./bridge";

async function makeVaultRoot(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), "gtd-bridge-"));
}

async function removeVaultRoot(root: string): Promise<void> {
	await fs.rm(root, { recursive: true, force: true });
}

function relToAbs(root: string, relPosix: string): string {
	return path.join(root, ...relPosix.split("/"));
}

async function writeStatusArtifact(
	root: string,
	deviceId: string,
	report: ExternalSyncReport,
	updatedAt = 1_000_000,
): Promise<void> {
	const abs = relToAbs(root, BRIDGE_STATUS_FILE);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(
		abs,
		JSON.stringify({ formatVersion: BRIDGE_FORMAT_VERSION, deviceId, updatedAt, report }),
		"utf8",
	);
}

function makeReport(status: ExternalSyncReport["status"]): ExternalSyncReport {
	const subscriptionStatus = status === "ok" ? "ok" : "error";
	return {
		status,
		startedAt: 1_000,
		finishedAt: 2_000,
		changedMirrors: status === "ok" ? 3 : 0,
		subscriptions: [
			{
				id: "sub-1",
				status: subscriptionStatus,
				lastSuccessAt: subscriptionStatus === "error" ? null : 2_000,
				errorCode: subscriptionStatus === "error" ? "network_error" : null,
			},
		],
	};
}

/**
 * Fake `sleep` standing in for a live plugin: on its first call it discovers
 * the request file the bridge just wrote (there is exactly one at a time in
 * these tests), and drops a matching response before the poll loop's next
 * check. `capture` receives the parsed request so the test can assert on it.
 */
function respondingSleep(
	root: string,
	report: ExternalSyncReport,
	capture: { request?: Record<string, unknown> },
): (ms: number) => Promise<void> {
	let responded = false;
	return async () => {
		if (responded) return;
		responded = true;
		const requestsDir = relToAbs(root, BRIDGE_REQUEST_DIR);
		const [requestFile] = await fs.readdir(requestsDir);
		if (requestFile === undefined) return;
		const requestRaw = JSON.parse(
			await fs.readFile(path.join(requestsDir, requestFile), "utf8"),
		) as Record<string, unknown>;
		capture.request = requestRaw;
		const requestId = requestRaw["requestId"] as string;
		const responsesDir = relToAbs(root, BRIDGE_RESPONSE_DIR);
		await fs.mkdir(responsesDir, { recursive: true });
		const response = {
			formatVersion: BRIDGE_FORMAT_VERSION,
			requestId,
			deviceId: requestRaw["targetDeviceId"],
			finishedAt: 5_000,
			report,
		};
		await fs.writeFile(
			path.join(responsesDir, `sync-${requestId}.json`),
			JSON.stringify(response),
			"utf8",
		);
	};
}

describe("readExternalSyncStatus", () => {
	it("no-status when the artifact is missing", async () => {
		const root = await makeVaultRoot();
		try {
			await expect(readExternalSyncStatus({ vaultRoot: root })).resolves.toEqual({
				available: false,
				reason: "no-status",
			});
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("invalid-status on unparsable content", async () => {
		const root = await makeVaultRoot();
		try {
			const abs = relToAbs(root, BRIDGE_STATUS_FILE);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, "{ not json", "utf8");
			await expect(readExternalSyncStatus({ vaultRoot: root })).resolves.toEqual({
				available: false,
				reason: "invalid-status",
			});
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("invalid-status when required fields fail validation", async () => {
		const root = await makeVaultRoot();
		try {
			const abs = relToAbs(root, BRIDGE_STATUS_FILE);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(
				abs,
				JSON.stringify({
					formatVersion: BRIDGE_FORMAT_VERSION,
					deviceId: "",
					updatedAt: 1,
					report: {},
				}),
				"utf8",
			);
			await expect(readExternalSyncStatus({ vaultRoot: root })).resolves.toEqual({
				available: false,
				reason: "invalid-status",
			});
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("reads a valid status artifact", async () => {
		const root = await makeVaultRoot();
		try {
			const report = makeReport("ok");
			await writeStatusArtifact(root, "device-a", report, 42);
			await expect(readExternalSyncStatus({ vaultRoot: root })).resolves.toEqual({
				available: true,
				deviceId: "device-a",
				updatedAt: 42,
				report,
			});
		} finally {
			await removeVaultRoot(root);
		}
	});
});

describe("syncExternalCalendarsViaBridge", () => {
	it("plugin-unavailable without a status artifact, and writes no request", async () => {
		const root = await makeVaultRoot();
		try {
			await expect(syncExternalCalendarsViaBridge({ vaultRoot: root }, {})).resolves.toEqual({
				outcome: "plugin-unavailable",
			});
			await expect(fs.readdir(relToAbs(root, BRIDGE_REQUEST_DIR))).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("completes with the report and proceed:true when the plugin answers ok", async () => {
		const root = await makeVaultRoot();
		try {
			await writeStatusArtifact(root, "device-a", makeReport("ok"));
			const report = makeReport("ok");
			const capture: { request?: Record<string, unknown> } = {};
			const result = await syncExternalCalendarsViaBridge(
				{ vaultRoot: root, sleep: respondingSleep(root, report, capture) },
				{},
			);
			expect(result).toEqual({
				outcome: "completed",
				report,
				vaultSync: { proceed: true, reason: "ok" },
			});
			expect(capture.request?.["targetDeviceId"]).toBe("device-a");
			expect(isBridgeRequestId(capture.request?.["requestId"])).toBe(true);
			// The consumed response is cleaned up best-effort.
			await expect(fs.readdir(relToAbs(root, BRIDGE_RESPONSE_DIR))).resolves.toEqual([]);
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("partial report with force_partial=false does not proceed", async () => {
		const root = await makeVaultRoot();
		try {
			await writeStatusArtifact(root, "device-a", makeReport("ok"));
			const report = makeReport("partial");
			const result = await syncExternalCalendarsViaBridge(
				{ vaultRoot: root, sleep: respondingSleep(root, report, {}) },
				{ forcePartial: false },
			);
			expect(result.outcome).toBe("completed");
			expect(result.vaultSync).toEqual({ proceed: false, reason: "partial" });
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("partial report with force_partial=true proceeds as forced-partial", async () => {
		const root = await makeVaultRoot();
		try {
			await writeStatusArtifact(root, "device-a", makeReport("ok"));
			const report = makeReport("partial");
			const result = await syncExternalCalendarsViaBridge(
				{ vaultRoot: root, sleep: respondingSleep(root, report, {}) },
				{ forcePartial: true },
			);
			expect(result.vaultSync).toEqual({ proceed: true, reason: "forced-partial" });
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("error report never proceeds, even with force_partial", async () => {
		const root = await makeVaultRoot();
		try {
			await writeStatusArtifact(root, "device-a", makeReport("ok"));
			const report = makeReport("error");
			const result = await syncExternalCalendarsViaBridge(
				{ vaultRoot: root, sleep: respondingSleep(root, report, {}) },
				{ forcePartial: true },
			);
			expect(result.vaultSync).toEqual({ proceed: false, reason: "error" });
		} finally {
			await removeVaultRoot(root);
		}
	});

	it("times out when no response ever arrives, and removes its own request file", async () => {
		const root = await makeVaultRoot();
		try {
			await writeStatusArtifact(root, "device-a", makeReport("ok"));
			// Deterministic clock: jumps 4000ms on every read, so the (clamped to
			// the 5000ms floor) timeout is crossed after one polling sleep without
			// any real wall-clock wait.
			let ticks = 0;
			const now = () => {
				ticks += 1;
				return ticks * 4_000;
			};
			let sleepCalls = 0;
			const neverSleep = async () => {
				sleepCalls += 1;
				// Never writes a response: the plugin never picks up the request.
			};
			const result = await syncExternalCalendarsViaBridge(
				{ vaultRoot: root, now, sleep: neverSleep },
				{ timeoutMs: 100 },
			);
			expect(result).toEqual({ outcome: "timeout" });
			expect(sleepCalls).toBeGreaterThan(0);
			await expect(fs.readdir(relToAbs(root, BRIDGE_REQUEST_DIR))).resolves.toEqual([]);
		} finally {
			await removeVaultRoot(root);
		}
	});
});
