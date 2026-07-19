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
	target: "node18",
	// node-встроенные модули (и их node: варианты) не инлайним
	external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	outfile: "mcp-server.js",
	logLevel: "info",
	sourcemap: false,
	minify: false,
});
