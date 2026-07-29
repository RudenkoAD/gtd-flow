import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_FILES, makeVault, removeVault } from "./testVault";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("MCP bundled contract", () => {
	it("publishes scope-based task schemas without namespace", async () => {
		const bundleDir = mkdtempSync(path.join(tmpdir(), "gtd-mcp-e2e-"));
		const bundlePath = path.join(bundleDir, "mcp-server.js");
		const vault = await makeVault(FIXTURE_FILES);
		try {
			execFileSync(process.execPath, ["esbuild.mcp.mjs"], {
				cwd: repoRoot,
				stdio: "ignore",
				env: { ...process.env, GTD_MCP_OUTFILE: bundlePath },
			});
			const source = readFileSync(bundlePath, "utf8");
			expect(source).toContain("duration_minutes");
			expect(source).toContain("cognitive_intensity");
			expect(source).toContain("emotional_intensity");
			expect(source).toContain("physical_intensity");
			// Schema prose keeps the breaking-change explanation, but no tool has a
			// registered namespace input after bundling.
			expect(source).not.toMatch(/namespace:\s*z\.string\(\)/u);
		} finally {
			await removeVault(vault);
			rmSync(bundleDir, { recursive: true, force: true });
		}
	});
});
