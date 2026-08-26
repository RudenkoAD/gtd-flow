#!/usr/bin/env node
// Секрет-гигиена поверх узкого скана в check-packaged-plugin.mjs (он смотрит
// только main.js). Здесь проверяются ВСЕ собранные бандлы и все отслеживаемые
// git текстовые файлы: конкретные credential-образные строки (API-ключи,
// OAuth-токены, включая формы, характерные для CalDAV-учёток) и URL со
// встроенными учётными данными не должны попадать ни в исходники, ни в
// фикстуры, ни в документацию, ни в артефакты релиза.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const errors = [];

// Конкретные формы секретов. Шаблоны вида `Basic ${...}` не совпадают: после
// схемы требуется длинный литерал из узкого алфавита.
const SECRET_PATTERNS = [
	{ name: "OpenAI/OpenRouter key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/u },
	{ name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/u },
	{ name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/u },
	{ name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/u },
	{ name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/u },
	{ name: "Yandex OAuth token", re: /\by[0-3]_[A-Za-z0-9_-]{20,}\b/u },
	{
		name: "inline Basic-auth literal",
		re: /\bBasic\s+[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/u,
	},
	{ name: "inline Bearer literal", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/u },
	{
		name: "URL with embedded credentials",
		re: /\bhttps?:\/\/[^\s/:@"'`]+:[^\s@"'`]+@[^\s"'`]+/u,
	},
];

const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".mjs",
	".cjs",
	".svelte",
	".json",
	".md",
	".txt",
	".yml",
	".yaml",
	".css",
	".html",
	".ics",
	".xml",
]);

const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

function scanText(label, text) {
	for (const { name, re } of SECRET_PATTERNS) {
		if (re.test(text)) {
			// Само значение намеренно не печатается — только файл и класс паттерна.
			errors.push(`${label}: contains a ${name}-shaped string`);
		}
	}
}

// 1. Собранные бандлы (если присутствуют).
for (const bundle of ["main.js", "mcp-server.js", "widget-core.js"]) {
	const path = resolve(root, bundle);
	if (existsSync(path)) scanText(bundle, readFileSync(path, "utf8"));
}

// 2. Все отслеживаемые git текстовые файлы (включая staged-изменения — скан
// идёт по рабочему дереву, поэтому покрывает и то, что попадёт в diff).
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
	.split("\0")
	.filter(Boolean);
for (const rel of tracked) {
	if (!TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
	const path = resolve(root, rel);
	if (!existsSync(path)) continue;
	if (statSync(path).size > MAX_SCANNED_BYTES) continue;
	scanText(rel, readFileSync(path, "utf8"));
}

if (errors.length > 0) {
	console.error(`Secret hygiene check failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
	process.exit(1);
}
console.log(`secret hygiene OK (${tracked.length} tracked files + bundles scanned)`);
