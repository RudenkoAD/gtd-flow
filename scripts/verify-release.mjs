#!/usr/bin/env node
import process from "node:process";
import { assertReleaseContract, loadReleaseContract } from "./release-contract.mjs";

function valueAfter(flag) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function releaseTagFromEnvironment(env = process.env) {
	return env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME?.trim()
		? env.GITHUB_REF_NAME
		: undefined;
}

try {
	// GITHUB_REF_NAME is also a branch name in normal CI. Only use it implicitly
	// for a tag-triggered workflow; callers can always validate a tag explicitly.
	const tag = valueAfter("--tag") ?? releaseTagFromEnvironment();
	const artifacts = process.argv.includes("--artifacts");
	const contract = loadReleaseContract();
	assertReleaseContract(contract, { tag, artifacts });
	console.log(
		`release contract OK (${contract.packageJson.version}${tag ? `, tag ${tag}` : ""}${artifacts ? ", artifacts present" : ""})`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
