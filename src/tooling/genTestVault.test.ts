import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "gtd-flow-generator-"));
	tempRoots.push(root);
	return root;
}

function runGenerator(target: string, extra: string[] = []) {
	return spawnSync(
		process.execPath,
		["scripts/gen-test-vault.mjs", target, "--files", "1", "--tasks", "1", ...extra],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gen-test-vault destructive safety", () => {
	it("creates a new marked destination", () => {
		const target = join(tempRoot(), "new-vault");

		const result = runGenerator(target);

		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(join(target, ".gtd-flow-test-vault"))).toBe(true);
		expect(readFileSync(join(target, "GTD", "Inbox.md"), "utf8")).toContain("gtd-inbox: true");
	});

	it("refuses every existing destination by default without changing files", () => {
		const target = join(tempRoot(), "existing-vault");
		mkdirSync(join(target, "GTD"), { recursive: true });
		const inbox = join(target, "GTD", "Inbox.md");
		writeFileSync(inbox, "private user data\n", "utf8");

		const result = runGenerator(target);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("уже существует");
		expect(readFileSync(inbox, "utf8")).toBe("private user data\n");
	});

	it("refuses --force for an unmarked existing vault without changing files", () => {
		const target = join(tempRoot(), "forced-vault");
		mkdirSync(join(target, "GTD"), { recursive: true });
		const inbox = join(target, "GTD", "Inbox.md");
		writeFileSync(inbox, "replace me\n", "utf8");

		const result = runGenerator(target, ["--force"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("отмеченного");
		expect(readFileSync(inbox, "utf8")).toBe("replace me\n");
	});

	it("lists affected files before replacing a vault it generated", () => {
		const target = join(tempRoot(), "forced-vault");
		expect(runGenerator(target).status).toBe(0);
		const inbox = join(target, "GTD", "Inbox.md");
		writeFileSync(inbox, "replace me\n", "utf8");

		const result = runGenerator(target, ["--force"]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain("GTD/Inbox.md");
		expect(result.stderr).toContain("будут перезаписаны");
		expect(readFileSync(inbox, "utf8")).toContain("gtd-inbox: true");
	});
});
