// Enforces the portability hedges:
//  • src/core must never import the `obsidian` module — keeps the core portable to a
//    standalone app (see spec §0).
//  • src/mcp is held to the same obsidian rule: the standalone MCP server bundles pure
//    core + services with fs-backed ports and must never pull `obsidian` into it.
//  • src/widget is the QuickJS bundle for Android widgets — held to the STRICTER rule:
//    no `obsidian` AND no node built-ins (fs/path/module/…). It runs in an embedded
//    engine with input-provided files/time, so a node import would break it. The MCP
//    server may use node freely; the widget may not.
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { builtinModules } from "module";

const toDir = (rel) => new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Директории и применяемые к ним правила: obsidian всегда; node — только для widget.
const CHECKED = [
	{ dir: toDir("../src/core"), node: false },
	{ dir: toDir("../src/mcp"), node: false },
	{ dir: toDir("../src/widget"), node: true },
];

const OBSIDIAN_RE = /(from\s+['"]obsidian['"]|require\(\s*['"]obsidian['"]\s*\))/;
const NODE_NAMES = new Set(builtinModules);
const IMPORT_RE = /(?:from|require\(\s*)\s*['"]([^'"]+)['"]/g;

/** Первый node-builtin, импортируемый файлом (учёт node:-префикса и подпутей), либо null. */
function importsNode(src) {
	let m;
	while ((m = IMPORT_RE.exec(src)) !== null) {
		let name = m[1];
		const isNodePrefixed = name.startsWith("node:");
		if (isNodePrefixed) name = name.slice(5);
		const root = name.split("/")[0];
		if (isNodePrefixed || NODE_NAMES.has(root)) return m[1];
	}
	return null;
}

function walk(dir) {
	let files = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) files = files.concat(walk(full));
		else if (/\.(ts|js|svelte)$/.test(entry)) files.push(full);
	}
	return files;
}

const obsidianViolations = [];
const nodeViolations = [];
for (const { dir, node } of CHECKED) {
	let files;
	try {
		files = walk(dir);
	} catch (e) {
		if (e.code === "ENOENT") continue; // директория ещё не создана
		throw e;
	}
	for (const f of files) {
		// тесты — не рантайм бандла: узлы node в *.test.ts (vm/fs smoke-теста) допустимы
		const isTest = /\.test\.[tj]s$/.test(f);
		const src = readFileSync(f, "utf8");
		if (OBSIDIAN_RE.test(src)) obsidianViolations.push(f);
		if (node && !isTest) {
			const hit = importsNode(src);
			if (hit !== null) nodeViolations.push(`${f} → ${hit}`);
		}
	}
}

let failed = false;
if (obsidianViolations.length) {
	failed = true;
	console.error("core/mcp/widget purity violated — `obsidian` imported from:");
	for (const f of obsidianViolations) console.error("  " + f);
}
if (nodeViolations.length) {
	failed = true;
	console.error("widget purity violated — node built-in imported from:");
	for (const f of nodeViolations) console.error("  " + f);
}
if (failed) process.exit(1);
console.log("core purity OK");
