#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import Module, { builtinModules } from "node:module";
import { resolve } from "node:path";
import {
	RELEASE_ARTIFACTS,
	loadReleaseContract,
	validateReleaseContract,
} from "./release-contract.mjs";

const root = process.cwd();
const errors = [];
const contract = loadReleaseContract(root);
const { manifest, packageJson } = contract;

errors.push(...validateReleaseContract(contract, { artifacts: true }));

if (typeof manifest.isDesktopOnly !== "boolean") {
	errors.push("manifest.json must explicitly set isDesktopOnly");
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id ?? "")) {
	errors.push("manifest.json id must be a lowercase, hyphen-separated identifier");
}
if (packageJson.main !== "main.js") {
	errors.push("package.json main must point to the Obsidian entry artifact main.js");
}

for (const artifact of RELEASE_ARTIFACTS) {
	if (!existsSync(resolve(root, artifact)))
		errors.push(`release artifact is missing: ${artifact}`);
}

const mainPath = resolve(root, "main.js");
const mainCode = existsSync(mainPath) ? readFileSync(mainPath, "utf8") : "";
if (!mainCode.includes("module.exports")) {
	errors.push("main.js is not a CommonJS Obsidian plugin bundle");
}

const externals = new Set(
	[
		...mainCode.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu),
		...mainCode.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu),
	].map((match) => match[1]),
);
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const allowedExternals = new Set(["obsidian", "electron", ...nodeBuiltins]);
const unexpectedExternals = [...externals].filter((name) => !allowedExternals.has(name)).sort();
if (unexpectedExternals.length > 0) {
	errors.push(`main.js has unexpected runtime externals: ${unexpectedExternals.join(", ")}`);
}
if (!externals.has("obsidian")) {
	errors.push("main.js does not retain the Obsidian runtime import");
}
const desktopRuntimeExternals = [...externals].filter(
	(name) => name === "electron" || nodeBuiltins.has(name),
);
const eagerDesktopLoads = [];

const concreteSecretPatterns = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/u,
	/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{16,}\b/u,
	/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/u,
	/\bAKIA[0-9A-Z]{16}\b/u,
];
if (concreteSecretPatterns.some((pattern) => pattern.test(mainCode))) {
	errors.push("main.js contains a concrete credential-shaped string");
}

if (errors.length === 0) {
	class PluginShim {}
	const obsidianShim = new Proxy(
		{ Plugin: PluginShim },
		{
			get(target, key) {
				if (typeof key !== "string") return undefined;
				return (target[key] ??= class {});
			},
		},
	);
	const originalLoad = Module._load;
	const pluginModule = new Module(mainPath);
	pluginModule.filename = mainPath;
	pluginModule.paths = Module._nodeModulePaths(root);
	try {
		Module._cache[mainPath] = pluginModule;
		Module._load = function loadWithObsidianShim(request, parent, isMain) {
			if (request === "obsidian") return obsidianShim;
			// Мобильный Obsidian не даёт ни electron, ни node-встроек. Загрузка
			// бандла обязана обходиться без них — desktop-специфика допустима
			// только за ленивым `await import()` внутри вызова.
			if (request === "electron" || nodeBuiltins.has(request)) {
				eagerDesktopLoads.push(request);
			}
			return originalLoad.call(this, request, parent, isMain);
		};
		pluginModule._compile(mainCode, mainPath);
		if (typeof pluginModule.exports.default !== "function") {
			errors.push("main.js does not export a default plugin constructor");
		} else if (!(pluginModule.exports.default.prototype instanceof PluginShim)) {
			errors.push("main.js default export does not extend Obsidian Plugin");
		}
	} catch (error) {
		errors.push(`main.js cannot load with an Obsidian API shim: ${String(error)}`);
	} finally {
		Module._load = originalLoad;
		delete Module._cache[mainPath];
	}
	if (manifest.isDesktopOnly !== true && eagerDesktopLoads.length > 0) {
		errors.push(
			`main.js loads desktop-only modules at import time: ${[...new Set(eagerDesktopLoads)].sort().join(", ")}`,
		);
	}
}

if (errors.length > 0) {
	console.error(
		`Packaged plugin check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
	);
	process.exit(1);
}

console.log(
	`packaged plugin check OK (desktop externals: ${desktopRuntimeExternals.sort().join(", ") || "none"};` +
		` eager: ${[...new Set(eagerDesktopLoads)].sort().join(", ") || "none"})`,
);
