/**
 * Точка входа MCP-сервера GTD Flow.
 *
 * Запуск: node mcp-server.js --vault "D:\путь\к\vault"  (или env GTD_VAULT).
 * Даёт агентам читать и править GTD пользователя НАПРЯМУЮ по файлам vault'а —
 * без запущенного Obsidian. Транспорт — stdio (Claude Code / Claude Desktop).
 *
 * ВНИМАНИЕ: сервер пишет в файлы vault'а (add_task/update_task/delete_task/
 * move_card/add_event). Все операции заперты внутри корня vault'а; файлы не
 * удаляются (только строки задач).
 */
import { existsSync, statSync } from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools";

/** Replaced by esbuild.mcp.mjs from package.json. Keeping this as a build-time
 * symbol prevents an independently hand-edited MCP version from drifting. */
declare const __GTD_FLOW_VERSION__: string;

/** --vault <path> из argv, иначе env GTD_VAULT. */
function resolveVaultArg(argv: readonly string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--vault") return argv[i + 1] ?? null;
		const eq = argv[i]!.startsWith("--vault=") ? argv[i]!.slice("--vault=".length) : null;
		if (eq !== null) return eq;
	}
	return process.env.GTD_VAULT ?? null;
}

async function main(): Promise<void> {
	const raw = resolveVaultArg(process.argv.slice(2));
	if (raw === null || raw.trim() === "") {
		process.stderr.write(
			"GTD Flow MCP: no vault path. Pass --vault <path> or set GTD_VAULT.\n",
		);
		process.exit(2);
	}
	const vaultRoot = path.resolve(raw);
	if (!existsSync(vaultRoot) || !statSync(vaultRoot).isDirectory()) {
		process.stderr.write(`GTD Flow MCP: vault path is not a directory: ${vaultRoot}\n`);
		process.exit(2);
	}

	const server = new McpServer({ name: "gtd-flow", version: __GTD_FLOW_VERSION__ });
	registerTools(server, { vaultRoot });

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stderr — не мешает stdio-протоколу (он на stdout), виден в логах клиента
	process.stderr.write(`GTD Flow MCP server ready (vault: ${vaultRoot})\n`);
}

main().catch((e: unknown) => {
	process.stderr.write(
		`GTD Flow MCP: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
	);
	process.exit(1);
});
