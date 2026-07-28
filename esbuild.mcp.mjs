/**
 * Сборка автономного MCP-сервера в один файл mcp-server.js (по образцу
 * esbuild.config.mjs плагина, но platform node и БЕЗ external'ов Obsidian).
 *
 * Формат ESM (package.json "type":"module" ⇒ *.js исполняется как ESM). Node-
 * builtins помечены external, всё остальное (SDK, zod, yaml + чистое ядро/сервисы)
 * инлайнится. Banner добавляет createRequire — на случай CJS-зависимостей SDK,
 * использующих require в рантайме внутри ESM-бандла.
 */
import esbuild from "esbuild";
import { builtinModules } from "module";
import { readFileSync } from "fs";

/** package.json is the release-version source of truth. Embed it at build time so
 * the standalone server never carries a hand-maintained version literal. */
const packageInfo = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
if (typeof packageInfo.version !== "string" || packageInfo.version === "") {
	throw new Error("package.json must contain a non-empty version for MCP build");
}
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
if (manifest.version !== packageInfo.version) {
	throw new Error(
		`MCP build refused: package.json (${packageInfo.version}) and manifest.json (${manifest.version}) differ`,
	);
}
/** Tests may direct an isolated bundle outside the repository. Release/default
 * output remains mcp-server.js in the project root. */
const outfile = process.env.GTD_MCP_OUTFILE ?? "mcp-server.js";

const banner = `/*
GENERATED/BUNDLED FILE BY ESBUILD — GTD Flow MCP server.
Source: src/mcp (see the plugin's GitHub repository).
*/
import { createRequire as __mcpCreateRequire } from "module";
const require = __mcpCreateRequire(import.meta.url);
`;

await esbuild.build({
	banner: { js: banner },
	entryPoints: ["src/mcp/server.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	// node-встроенные модули (и их node: варианты) не инлайним
	external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	outfile,
	logLevel: "info",
	sourcemap: false,
	minify: false,
	define: { __GTD_FLOW_VERSION__: JSON.stringify(packageInfo.version) },
});
