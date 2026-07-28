import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const RELEASE_ARTIFACTS = [
	"main.js",
	"manifest.json",
	"styles.css",
	"mcp-server.js",
	"widget-core.js",
	"LICENSE",
];

const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function readJson(root, relativePath) {
	return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

export function loadReleaseContract(root = process.cwd()) {
	const packageJson = readJson(root, "package.json");
	const manifest = readJson(root, "manifest.json");
	const versions = readJson(root, "versions.json");
	return { root, packageJson, manifest, versions };
}

export function validateReleaseContract(contract, options = {}) {
	const { root, packageJson, manifest, versions } = contract;
	const errors = [];
	const version = packageJson.version;
	const tag = options.tag;
	const normalizedTag = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : tag;

	if (typeof version !== "string" || !SEMVER_RE.test(version)) {
		errors.push(`package.json version is not valid SemVer: ${String(version)}`);
	}
	if (manifest.version !== version) {
		errors.push(
			`manifest.json version ${String(manifest.version)} does not match package.json ${version}`,
		);
	}
	if (tag !== undefined && normalizedTag !== version) {
		errors.push(
			`release tag ${tag} does not match project version ${version} (an optional leading "v" is allowed)`,
		);
	}
	if (typeof manifest.minAppVersion !== "string" || manifest.minAppVersion.length === 0) {
		errors.push("manifest.json minAppVersion is missing");
	} else if (versions[version] !== manifest.minAppVersion) {
		errors.push(
			`versions.json entry for ${version} (${String(versions[version])}) does not match minAppVersion ${manifest.minAppVersion}`,
		);
	}
	if (packageJson.private !== true) {
		errors.push(
			'package.json must set "private": true; releases are distributed as GitHub artifacts',
		);
	}
	if (typeof packageJson.engines?.node !== "string") {
		errors.push("package.json must declare the supported Node runtime");
	}
	const obsidianTypes = packageJson.devDependencies?.obsidian;
	if (
		typeof obsidianTypes !== "string" ||
		(!obsidianTypes.startsWith(`^${manifest.minAppVersion}`) &&
			obsidianTypes !== manifest.minAppVersion)
	) {
		errors.push(
			`Obsidian typings must support the declared minimum ${manifest.minAppVersion}; found ${String(obsidianTypes)}`,
		);
	}

	if (options.artifacts) {
		for (const relativePath of RELEASE_ARTIFACTS) {
			const absolutePath = resolve(root, relativePath);
			if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
				errors.push(`release artifact is missing: ${relativePath}`);
			}
		}
	}

	return errors;
}

export function assertReleaseContract(contract, options = {}) {
	const errors = validateReleaseContract(contract, options);
	if (errors.length === 0) return;
	throw new Error(`Release contract failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
