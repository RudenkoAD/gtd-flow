import { promises as fs } from "fs";
import * as path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings, McpConfigError, parseMcpSettings } from "./config";
import { makeVault, removeVault } from "./testVault";
import { registerTools } from "./tools";

describe("MCP configuration trust boundary", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => removeVault(root)));
	});

	it("uses defaults only when data.json is absent", async () => {
		const root = await makeVault({ "Note.md": "- [ ] task\n" });
		roots.push(root);
		const settings = await loadSettings(root);
		expect(settings.commonRoot).toBe("GTD");
		expect(settings.namespaces).toEqual([]);
	});

	it("malformed JSON blocks MCP instead of redirecting writes to default folders", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": "{ bad json",
		});
		roots.push(root);
		await expect(loadSettings(root)).rejects.toBeInstanceOf(McpConfigError);
		await expect(loadSettings(root)).rejects.toThrow(/cannot parse data.json/);
	});

	it("wrong known shapes are rejected before normalizeActiveNamespace can crash", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": JSON.stringify({ namespaces: "not-an-array" }),
		});
		roots.push(root);
		await expect(loadSettings(root)).rejects.toThrow(/'namespaces' is invalid/);
	});

	it("schema-invalid write paths block add_task instead of falling back to GTD", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": JSON.stringify({
				commonRoot: "Private\u0000Root",
			}),
		});
		roots.push(root);
		let capturedAddTask: ((args: { text: string }) => Promise<CallToolResult>) | undefined;
		const server = {
			registerTool(name: string, _definition: unknown, handler: unknown) {
				if (name === "add_task") {
					capturedAddTask = handler as (args: {
						text: string;
					}) => Promise<CallToolResult>;
				}
			},
		};
		registerTools(server as unknown as McpServer, {
			vaultRoot: root,
			today: () => "2026-07-28",
		});

		expect(capturedAddTask).toBeDefined();
		const result = await capturedAddTask!({ text: "must not be redirected" });
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("commonRoot");
		await expect(fs.access(path.join(root, "GTD"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("unreadable/non-file configuration is an error, not a defaulted configuration", async () => {
		const root = await makeVault({});
		roots.push(root);
		const dataPath = path.join(root, ".obsidian", "plugins", "gtd-flow", "data.json");
		await fs.mkdir(dataPath, { recursive: true });
		await expect(loadSettings(root)).rejects.toThrow(/cannot read data.json/);
	});

	it("keeps valid legacy partial settings and ignores unknown future keys", () => {
		const parsed = parseMcpSettings({
			commonRoot: "Tasks",
			namespaces: [{ name: "Work", root: "Work" }],
			futureSetting: { allowed: true },
		});
		expect(parsed.commonRoot).toBe("Tasks");
		expect(parsed.futureSetting).toEqual({ allowed: true });
	});

	it("rejects namespace roots that cannot survive strict merging", async () => {
		const root = await makeVault({
			".obsidian/plugins/gtd-flow/data.json": JSON.stringify({
				namespaces: [{ name: "Work", root: "/" }],
			}),
		});
		roots.push(root);
		await expect(loadSettings(root)).rejects.toThrow(
			/'namespaces' cannot be loaded without recovery/,
		);
	});
});
