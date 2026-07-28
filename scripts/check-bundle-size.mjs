#!/usr/bin/env node
import { statSync } from "node:fs";
import process from "node:process";

const budgets = new Map([
	// Settings schema validation intentionally adds runtime code to the Obsidian
	// bundle. Keep roughly 17% headroom over the validated 1.115 MB baseline while
	// still catching accidental large dependency imports.
	["main.js", 1_300_000],
	["mcp-server.js", 2_000_000],
	["widget-core.js", 150_000],
]);

let failed = false;
for (const [file, budget] of budgets) {
	let size;
	try {
		size = statSync(file).size;
	} catch {
		console.error(`bundle size check: missing ${file}`);
		failed = true;
		continue;
	}
	const percentage = ((size / budget) * 100).toFixed(1);
	console.log(`${file}: ${size} / ${budget} bytes (${percentage}%)`);
	if (size > budget) {
		console.error(
			`bundle size check: ${file} exceeds its ${budget}-byte budget by ${size - budget}`,
		);
		failed = true;
	}
}

if (failed) process.exit(1);
console.log("bundle size budgets OK");
