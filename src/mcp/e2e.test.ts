/**
 * End-to-end: собрать бандл mcp-server.js и поднять реальный процесс, поговорить
 * с ним по stdio (newline-delimited JSON-RPC, как транспорт MCP). Проверяет весь
 * путь: initialize → tools/list → tools/call list_tasks против временного vault'а.
 *
 * Сборка+процесс дороги, поэтому набор собирает один временный бандл и держит
 * один процесс. Сборка — обязательная precondition: её отказ должен падать, а не
 * скрываться skip'ом, иначе MCP release artifact остаётся непроверенным.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_FILES, makeVault, removeVault } from "./testVault";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const expectedServerVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
	.version as string;
const bundleDir = mkdtempSync(path.join(tmpdir(), "gtd-mcp-e2e-"));
const bundlePath = path.join(bundleDir, "mcp-server.js");
try {
	execFileSync(process.execPath, ["esbuild.mcp.mjs"], {
		cwd: repoRoot,
		stdio: "ignore",
		env: { ...process.env, GTD_MCP_OUTFILE: bundlePath },
	});
} catch (e) {
	rmSync(bundleDir, { recursive: true, force: true });
	throw new Error(`MCP e2e precondition failed: could not build temporary bundle (${String(e)})`);
}
if (!existsSync(bundlePath)) {
	rmSync(bundleDir, { recursive: true, force: true });
	throw new Error("MCP e2e precondition failed: build completed without mcp-server.js");
}

/** Клиент newline-delimited JSON-RPC поверх stdio дочернего процесса. */
function rpc(child: ChildProcessWithoutNullStreams) {
	const pending = new Map<
		number,
		{
			resolve: (v: any) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let buf = "";
	let stderr = "";
	let terminalError: Error | null = null;
	child.stderr.on("data", (data: Buffer) => {
		stderr = (stderr + data.toString("utf8")).slice(-4000);
	});
	const terminate = (message: string): void => {
		if (terminalError !== null) return;
		const diagnostic = stderr.trim();
		terminalError = new Error(diagnostic === "" ? message : `${message}\n${diagnostic}`);
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(terminalError);
		}
		pending.clear();
	};
	child.once("error", (error) => terminate(`MCP child process error: ${error.message}`));
	child.once("exit", (code, signal) =>
		terminate(
			`MCP child exited before replying (code=${String(code)}, signal=${String(signal)})`,
		),
	);
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
				clearTimeout(p.timer);
				if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
				else p.resolve(msg.result);
			}
		}
	});
	let nextId = 1;
	const request = (method: string, params: unknown): Promise<any> =>
		new Promise((resolve, reject) => {
			if (terminalError !== null || child.exitCode !== null) {
				reject(
					terminalError ??
						new Error(`MCP child already exited with code ${String(child.exitCode)}`),
				);
				return;
			}
			const id = nextId++;
			const timer = setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
			}, 15000);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const notify = (method: string, params: unknown): void => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	};
	return { request, notify };
}

describe("MCP server e2e (stdio)", () => {
	let root: string;
	let child: ChildProcessWithoutNullStreams;

	beforeAll(async () => {
		root = await makeVault({
			...FIXTURE_FILES,
			// файл-паритет с кэшем Obsidian: цитаты/коллауты и отступный код —
			// НЕ задачи; вложенная подзадача — задача (см. scanFile.ts)
			"GTD/Паритет.md": [
				"- [ ] Паритет корневая",
				"    - [ ] Паритет подзадача",
				"> - [ ] Паритет в цитате",
				"> [!note]",
				"> - [ ] Паритет в коллауте",
				"",
				"Текст.",
				"",
				"    - [ ] Паритет отступный код",
				"",
			].join("\n"),
		});
		child = spawn(process.execPath, [bundlePath, "--vault", root], {
			cwd: repoRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	afterAll(async () => {
		child?.kill();
		if (root) await removeVault(root);
		rmSync(bundleDir, { recursive: true, force: true });
	});

	it("initialize → tools/list → tools/call list_tasks", async () => {
		const { request, notify } = rpc(child);

		const init = await request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "vitest", version: "0" },
		});
		expect(init.serverInfo.name).toBe("gtd-flow");
		expect(init.serverInfo.version).toBe(expectedServerVersion);
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
		expect(payload.tasks.some((t: any) => t.description === "Общая задача без даты")).toBe(
			true,
		);
	}, 30000);

	it("паритет скана с кэшем Obsidian: цитаты/коллауты и отступный код исключены", async () => {
		const { request } = rpc(child);
		const call = await request("tools/call", {
			name: "list_tasks",
			arguments: { namespace: "Общее", view: "all" },
		});
		expect(call.isError).toBeFalsy();
		const payload = JSON.parse(call.content[0].text);
		const descs = payload.tasks.map((t: any) => t.description);
		expect(descs).toContain("Паритет корневая");
		expect(descs).toContain("Паритет подзадача");
		expect(descs).not.toContain("Паритет в цитате");
		expect(descs).not.toContain("Паритет в коллауте");
		expect(descs).not.toContain("Паритет отступный код");
	}, 30000);

	it("100 concurrent add_task calls all survive in one MCP process", async () => {
		const { request } = rpc(child);
		const calls = Array.from({ length: 100 }, (_, i) =>
			request("tools/call", {
				name: "add_task",
				arguments: { namespace: "Общее", text: `Concurrent MCP ${i}` },
			}),
		);
		const results = await Promise.all(calls);
		for (const result of results) {
			expect(result.isError).toBeFalsy();
			expect(JSON.parse(result.content[0].text).ok).toBe(true);
		}
		const listed = await request("tools/call", {
			name: "list_tasks",
			arguments: { namespace: "Общее", view: "all" },
		});
		const tasks = JSON.parse(listed.content[0].text).tasks as { description: string }[];
		const concurrent = tasks.filter((task) => task.description.startsWith("Concurrent MCP "));
		expect(concurrent).toHaveLength(100);
		expect(new Set(concurrent.map((task) => task.description))).toHaveLength(100);
	}, 30000);

	it("битая конфигурация не default-ит write tool в GTD/", async () => {
		const brokenRoot = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": "{ definitely not JSON",
		});
		const brokenChild = spawn(process.execPath, [bundlePath, "--vault", brokenRoot], {
			cwd: repoRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
		try {
			const { request, notify } = rpc(brokenChild);
			await request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "vitest", version: "0" },
			});
			notify("notifications/initialized", {});
			const call = await request("tools/call", {
				name: "add_task",
				arguments: { text: "must not be redirected" },
			});
			expect(call.isError).toBe(true);
			expect(JSON.parse(call.content[0].text).error).toMatch(/configuration error/);
			expect(existsSync(path.join(brokenRoot, "GTD", "Входящие.md"))).toBe(false);
		} finally {
			brokenChild.kill();
			await removeVault(brokenRoot);
		}
	}, 30000);
});
