import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("check-core-purity analyzer", () => {
	it("passes its parser regression fixtures", () => {
		const result = spawnSync(
			process.execPath,
			["scripts/check-core-purity.mjs", "--self-test"],
			{
				cwd: process.cwd(),
				encoding: "utf8",
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("core purity analyzer self-test OK");
	});
});
