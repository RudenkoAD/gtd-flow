// Enforces the portability hedge: src/core must never import the `obsidian` module.
// This is what keeps the core portable to a standalone app (see spec §0).
// src/mcp is held to the same rule: the standalone MCP server bundles pure core +
// services with fs-backed ports and must never pull `obsidian` into that bundle.
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const CHECKED_DIRS = ["../src/core", "../src/mcp"].map((rel) =>
	new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const PATTERN = /(from\s+['"]obsidian['"]|require\(\s*['"]obsidian['"]\s*\))/;

function walk(dir) {
	let files = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) files = files.concat(walk(full));
		else if (/\.(ts|js|svelte)$/.test(entry)) files.push(full);
	}
	return files;
}

let violations = [];
for (const dir of CHECKED_DIRS) {
	try {
		violations = violations.concat(walk(dir).filter((f) => PATTERN.test(readFileSync(f, "utf8"))));
	} catch (e) {
		if (e.code === "ENOENT") continue; // directory not created yet
		throw e;
	}
}

if (violations.length) {
	console.error("core/mcp purity violated — `obsidian` imported from:");
	for (const f of violations) console.error("  " + f);
	process.exit(1);
}
console.log("core purity OK");
