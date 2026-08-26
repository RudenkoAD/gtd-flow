// Enforces the portability boundaries:
//  • src/core and src/services must not import Obsidian.
//  • src/mcp must not import Obsidian.
//  • src/widget must import neither Obsidian nor Node built-ins.
//  • src/sync must not import Obsidian (network/vault arrive as ports).
//
// Import discovery uses the TypeScript parser rather than regular expressions so
// side-effect imports, re-exports, require(), and dynamic import() are all covered.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const toDir = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const CHECKED = [
	{ label: "core", dir: toDir("../src/core"), node: false },
	{ label: "services", dir: toDir("../src/services"), node: false },
	{ label: "mcp", dir: toDir("../src/mcp"), node: false },
	{ label: "widget", dir: toDir("../src/widget"), node: true },
	// src/sync держит сетевую/парсинговую логику за структурными портами:
	// Obsidian-адаптеры живут в composition root (main.ts), не здесь.
	{ label: "sync", dir: toDir("../src/sync"), node: false },
];

const NODE_NAMES = new Set(
	builtinModules.map((name) =>
		name.startsWith("node:") ? name.slice(5).split("/")[0] : name.split("/")[0],
	),
);

function scriptKind(fileName) {
	switch (extname(fileName)) {
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".tsx":
			return ts.ScriptKind.TSX;
		default:
			return ts.ScriptKind.TS;
	}
}

function literalText(node) {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: null;
}

/** Return every statically identifiable module reference in one JS/TS source. */
function collectModuleReferences(src, fileName = "fixture.ts") {
	const source = ts.createSourceFile(
		fileName,
		src,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(fileName),
	);
	const references = [];

	function visit(node) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			const specifier = literalText(node.moduleSpecifier);
			if (specifier !== null) references.push(specifier);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			const specifier = literalText(node.moduleReference.expression);
			if (specifier !== null) references.push(specifier);
		} else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire =
				ts.isIdentifier(node.expression) && node.expression.text === "require";
			if (isDynamicImport || isRequire) {
				const specifier = literalText(node.arguments[0]);
				if (specifier !== null) references.push(specifier);
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(source);
	return references;
}

function sourceSegments(src, fileName) {
	if (extname(fileName) !== ".svelte") return [src];
	const segments = [];
	const scriptTag = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
	let match;
	while ((match = scriptTag.exec(src)) !== null) segments.push(match[1] ?? "");
	return segments;
}

function importsForFile(src, fileName) {
	return sourceSegments(src, fileName).flatMap((segment, index) =>
		collectModuleReferences(segment, `${fileName}#script-${index}`),
	);
}

function nodeBuiltin(specifier) {
	const unprefixed = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
	const root = unprefixed.split("/")[0];
	return specifier.startsWith("node:") || NODE_NAMES.has(root) ? specifier : null;
}

function walk(dir) {
	let files = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) files = files.concat(walk(full));
		else if (/\.(?:[cm]?[jt]sx?|svelte)$/.test(entry)) files.push(full);
	}
	return files;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte"];

function isTestFile(file) {
	return /\.test\.[cm]?[jt]sx?$/.test(file);
}

/** Resolve only local source imports. Package imports remain leaf dependencies. */
function resolveLocalModule(file, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = resolve(dirname(file), specifier);
	const candidates = [
		base,
		...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
		...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/**
 * Follow local imports from a runtime boundary, so a seemingly pure file cannot
 * hide an Obsidian/Node dependency one re-export or bridge away.
 */
function analyzeBoundary({ label, dir, node }) {
	const pending = walk(dir).filter((file) => !isTestFile(file));
	const visited = new Set();
	const obsidianViolations = [];
	const nodeViolations = [];

	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);

		const imports = importsForFile(readFileSync(file, "utf8"), file);
		for (const specifier of imports) {
			if (specifier === "obsidian" || specifier.startsWith("obsidian/")) {
				obsidianViolations.push(`${label}: ${file} → ${specifier}`);
			}
			if (node) {
				const hit = nodeBuiltin(specifier);
				if (hit !== null) nodeViolations.push(`${label}: ${file} → ${hit}`);
			}

			const localDependency = resolveLocalModule(file, specifier);
			if (localDependency !== null && !isTestFile(localDependency))
				pending.push(localDependency);
		}
	}

	return { obsidianViolations, nodeViolations };
}

function runAnalyzerSelfTest() {
	assert.deepEqual(
		collectModuleReferences(
			[
				'import value from "alpha";',
				'import "side-effect";',
				'export { x } from "re-export";',
				'const one = require("required");',
				'const two = import("dynamic");',
				'const ignored = "import from \\"not-a-module\\"";',
			].join("\n"),
		),
		["alpha", "side-effect", "re-export", "required", "dynamic"],
	);
	assert.deepEqual(collectModuleReferences('import fs from "node:fs";'), ["node:fs"]);
	assert.deepEqual(collectModuleReferences('import path from "node:path";'), ["node:path"]);
	assert.equal(nodeBuiltin("node:fs/promises"), "node:fs/promises");
	assert.equal(nodeBuiltin("path/posix"), "path/posix");
	assert.equal(nodeBuiltin("@scope/not-node"), null);
	assert.deepEqual(
		importsForFile('<script lang="ts">import "obsidian";</script><div>ok</div>', "x.svelte"),
		["obsidian"],
	);

	const fixtureRoot = mkdtempSync(join(tmpdir(), "gtd-flow-purity-"));
	try {
		const fixtureCore = join(fixtureRoot, "core");
		const fixtureWidget = join(fixtureRoot, "widget");
		mkdirSync(fixtureCore, { recursive: true });
		mkdirSync(fixtureWidget, { recursive: true });
		writeFileSync(join(fixtureCore, "entry.ts"), 'export * from "./bridge";\n');
		writeFileSync(join(fixtureCore, "bridge.ts"), 'export * from "../adapter";\n');
		writeFileSync(join(fixtureRoot, "adapter.ts"), 'import "obsidian";\n');
		writeFileSync(join(fixtureWidget, "entry.ts"), 'export * from "../node-bridge";\n');
		writeFileSync(join(fixtureRoot, "node-bridge.ts"), 'import "node:fs";\n');

		const coreResult = analyzeBoundary({
			label: "fixture-core",
			dir: fixtureCore,
			node: false,
		});
		const widgetResult = analyzeBoundary({
			label: "fixture-widget",
			dir: fixtureWidget,
			node: true,
		});
		assert.equal(coreResult.obsidianViolations.length, 1);
		assert.equal(widgetResult.nodeViolations.length, 1);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

runAnalyzerSelfTest();
if (process.argv.includes("--self-test")) {
	console.log("core purity analyzer self-test OK");
	process.exit(0);
}

const obsidianViolations = [];
const nodeViolations = [];
for (const boundary of CHECKED) {
	let files;
	try {
		files = walk(boundary.dir);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			continue;
		throw error;
	}
	if (files.length === 0) continue;
	const result = analyzeBoundary(boundary);
	obsidianViolations.push(...result.obsidianViolations);
	nodeViolations.push(...result.nodeViolations);
}

let failed = false;
if (obsidianViolations.length > 0) {
	failed = true;
	console.error("core/services/mcp/widget purity violated — Obsidian imported from:");
	for (const violation of obsidianViolations) console.error(`  ${violation}`);
}
if (nodeViolations.length > 0) {
	failed = true;
	console.error("widget purity violated — Node built-in imported from:");
	for (const violation of nodeViolations) console.error(`  ${violation}`);
}
if (failed) process.exit(1);
console.log("core purity OK");
