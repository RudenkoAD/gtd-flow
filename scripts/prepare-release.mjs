#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";
import {
	RELEASE_ARTIFACTS,
	assertReleaseContract,
	loadReleaseContract,
} from "./release-contract.mjs";
import { RELEASE_NOTES_FILE, releaseNotesSource, writeReleaseNotes } from "./release-notes.mjs";

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? process.env.GITHUB_REF_NAME : process.argv[tagIndex + 1];

try {
	if (!tag) throw new Error("prepare-release requires --tag <version> or GITHUB_REF_NAME");
	const contract = loadReleaseContract();
	assertReleaseContract(contract, { tag, artifacts: true });

	const outputDir = resolve("dist/release");
	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });

	const checksumOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
	const checksumLines = [];
	for (const relativePath of RELEASE_ARTIFACTS) {
		const source = resolve(relativePath);
		const name = basename(relativePath);
		const destination = resolve(outputDir, name);
		copyFileSync(source, destination);
		checksumLines.push(`${checksumOf(destination)}  ${name}`);
	}
	// Version notes belong to the verified bundle but are not a published asset:
	// `publish` never checks out the repository, so it reads them from the bundle
	// (--notes-file) after `sha256sum --check` instead of embedding release prose.
	const version = contract.packageJson.version;
	const notes = writeReleaseNotes(contract.root, version, outputDir);
	checksumLines.push(`${checksumOf(notes.destination)}  ${RELEASE_NOTES_FILE}`);
	writeFileSync(resolve(outputDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");
	console.log(`release bundle prepared: ${outputDir}`);
	console.log(
		notes.source === null
			? `release notes: none (${releaseNotesSource(version)} is absent; generated notes only)`
			: `release notes: ${notes.source}`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
