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

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? process.env.GITHUB_REF_NAME : process.argv[tagIndex + 1];

try {
	if (!tag) throw new Error("prepare-release requires --tag <version> or GITHUB_REF_NAME");
	const contract = loadReleaseContract();
	assertReleaseContract(contract, { tag, artifacts: true });

	const outputDir = resolve("dist/release");
	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });

	const checksumLines = [];
	for (const relativePath of RELEASE_ARTIFACTS) {
		const source = resolve(relativePath);
		const name = basename(relativePath);
		const destination = resolve(outputDir, name);
		copyFileSync(source, destination);
		const checksum = createHash("sha256").update(readFileSync(destination)).digest("hex");
		checksumLines.push(`${checksum}  ${name}`);
	}
	writeFileSync(resolve(outputDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");
	console.log(`release bundle prepared: ${outputDir}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
