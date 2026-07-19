/**
 * End-to-end: собрать бандл mcp-server.js и поднять реальный процесс, поговорить
 * с ним по stdio (newline-delimited JSON-RPC, как транспорт MCP). Проверяет весь
 * путь: initialize → tools/list → tools/call list_tasks против временного vault'а.
 *
 * Хрупкость Windows/spawn: сборка+процесс дороги и зависят от окружения, поэтому
 * тест собирает бандл в beforeAll и держит один процесс. Если бандл собрать не
 * удалось (нет esbuild и т.п.), набор помечается пропущенным, а не падает —
 * покрытие логики даёт юнит-уровень (handlers.test.ts).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_FILES, makeVault, removeVault } from "./testVault";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const bundlePath = path.join(repoRoot, "mcp-server.js");

let built = false;
try {
	execFileSync(process.execPath, ["esbuild.mcp.mjs"], { cwd: repoRoot, stdio: "ignore" });
	built = existsSync(bundlePath);
} catch {
	built = false;
}

/** Клиент newline-delimited JSON-RPC поверх stdio дочернего процесса. */
function rpc(child: ChildProcessWithoutNullStreams) {
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	let buf = "";
	child.stdout.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		let idx: number;
		while ((idx = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (line === "") continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id !== undefined && pending.has(msg.id)) {
				const p = pending.get(msg.id)!;
				pending.delete(msg.id);
				if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
				else p.resolve(msg.result);
			}
		}
	});
	let nextId = 1;
	const request = (method: string, params: unknown): Promise<any> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
			}, 15000);
		});
	const notify = (method: string, params: unknown): void => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	};
	return { request, notify };
}

describe.skipIf(!built)("MCP server e2e (stdio)", () => {
	let root: string;
	let child: ChildProcessWithoutNullStreams;

	beforeAll(async () => {
		root = await makeVault(FIXTURE_FILES);
		child = spawn(process.execPath, [bundlePath, "--vault", root], {
			cwd: repoRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	afterAll(async () => {
		child?.kill();
		if (root) await removeVault(root);
	});

	it("initialize → tools/list → tools/call list_tasks", async () => {
		const { request, notify } = rpc(child);

		const init = await request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "vitest", version: "0" },
		});
		expect(init.serverInfo.name).toBe("gtd-flow");
		notify("notifications/initialized", {});

		const tools = await request("tools/list", {});
		const names = (tools.tools as { name: string }[]).map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"add_event",
				"add_task",
				"delete_task",
				"gtd_overview",
				"list_boards",
				"list_events",
				"list_tasks",
				"move_card",
				"update_task",
			].sort(),
		);

		const call = await request("tools/call", {
			name: "list_tasks",
			arguments: { namespace: "Общее", view: "inbox" },
		});
		expect(call.isError).toBeFalsy();
		const payload = JSON.parse(call.content[0].text);
		expect(payload.namespace).toBe("Общее");
		expect(payload.tasks.some((t: any) => t.description === "Общая задача без даты")).toBe(true);
	}, 30000);
});
