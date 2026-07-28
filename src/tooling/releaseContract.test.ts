import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;

function verifyRelease(args: string[] = [], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, ["scripts/verify-release.mjs", ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, GITHUB_REF_NAME: "", GITHUB_REF_TYPE: "branch", ...env },
	});
}

describe("release contract", () => {
	it("accepts the repository version", () => {
		const result = verifyRelease(["--tag", packageVersion]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("release contract OK");
	});

	it("accepts npm's default v-prefixed version tag", () => {
		const result = verifyRelease(["--tag", `v${packageVersion}`]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(`tag v${packageVersion}`);
	});

	it("rejects a mismatched tag before publication", () => {
		const result = verifyRelease(["--tag", `${packageVersion}.invalid`]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("does not match");
	});

	it("does not confuse a branch name with a release tag", () => {
		const result = verifyRelease([], { GITHUB_REF_NAME: "master", GITHUB_REF_TYPE: "branch" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).not.toContain(", tag master");
	});
});
