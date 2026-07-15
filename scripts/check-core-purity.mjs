// Enforces the portability hedge: src/core must never import the `obsidian` module.
// This is what keeps the core portable to a standalone app (see spec §0).
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const CORE_DIR = new URL("../src/core", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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
try {
	violations = walk(CORE_DIR).filter((f) => PATTERN.test(readFileSync(f, "utf8")));
} catch (e) {
	if (e.code === "ENOENT") process.exit(0); // core not created yet
	throw e;
}

if (violations.length) {
	console.error("core purity violated — `obsidian` imported from:");
	for (const f of violations) console.error("  " + f);
	process.exit(1);
}
console.log("core purity OK");
