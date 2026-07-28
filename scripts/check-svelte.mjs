#!/usr/bin/env node
/**
 * Compile every project-owned Svelte component without Vite/esbuild. This catches
 * Svelte parser/compiler/a11y warnings even though Vitest aliases components to a
 * stub and TypeScript's standard CLI does not inspect .svelte files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { compile, preprocess } from "svelte/compiler";
import { sveltePreprocess } from "svelte-preprocess";

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const file = join(dir, entry);
		if (statSync(file).isDirectory()) files.push(...walk(file));
		else if (file.endsWith(".svelte")) files.push(file);
	}
	return files;
}

function formatWarning(file, warning) {
	const location = warning.start ? `:${warning.start.line}:${warning.start.column}` : "";
	const code = warning.code ? ` [${warning.code}]` : "";
	return `${file}${location}${code} ${warning.message}`;
}

const files = walk("src").sort();
const warnings = [];
const failures = [];
const preprocessor = sveltePreprocess();

for (const file of files) {
	try {
		const source = readFileSync(file, "utf8");
		const transformed = await preprocess(source, preprocessor, { filename: file });
		const result = compile(transformed.code, {
			filename: file,
			generate: "client",
			css: "injected",
		});
		for (const warning of result.warnings) warnings.push(formatWarning(file, warning));
	} catch (error) {
		failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (files.length === 0) failures.push("no .svelte components found under src/");
if (failures.length > 0) {
	console.error("Svelte compiler failures:");
	for (const failure of failures) console.error(`  ${failure}`);
}
if (warnings.length > 0) {
	console.error("Svelte compiler warnings (project source):");
	for (const warning of warnings) console.error(`  ${warning}`);
}
if (failures.length > 0 || warnings.length > 0) process.exit(1);

console.log(`Svelte compiler check OK (${files.length} components)`);
