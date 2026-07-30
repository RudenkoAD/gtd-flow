import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Регресс: преамбула релиза была ЗАШИТА в publish-шаг workflow, поэтому текст
 * breaking-релиза 0.13.0 попадал бы в заметки каждого следующего тега (включая
 * патчи). Теперь заметки версионные: docs/release-notes/<version>.md → bundle →
 * `gh release create --notes-file`.
 */
const RELEASE_ARTIFACTS = [
	"main.js",
	"manifest.json",
	"styles.css",
	"mcp-server.js",
	"widget-core.js",
	"LICENSE",
];

const prepareRelease = resolve(process.cwd(), "scripts/prepare-release.mjs");
const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const releasedVersions = Object.keys(
	JSON.parse(readFileSync("versions.json", "utf8")) as Record<string, string>,
);

const tempRoots: string[] = [];

/** Минимальный корень репозитория, проходящий release contract. */
function fixture(version: string, notes: string | null): string {
	const root = mkdtempSync(join(tmpdir(), "gtd-flow-release-notes-"));
	tempRoots.push(root);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "gtd-flow",
			version,
			private: true,
			engines: { node: ">=20.19.0" },
			devDependencies: { obsidian: "^1.7.2" },
		}),
		"utf8",
	);
	writeFileSync(
		join(root, "manifest.json"),
		JSON.stringify({ version, minAppVersion: "1.7.2" }),
		"utf8",
	);
	writeFileSync(join(root, "versions.json"), JSON.stringify({ [version]: "1.7.2" }), "utf8");
	for (const artifact of RELEASE_ARTIFACTS) {
		if (artifact === "manifest.json") continue;
		writeFileSync(join(root, artifact), `${artifact} payload\n`, "utf8");
	}
	if (notes !== null) {
		mkdirSync(join(root, "docs", "release-notes"), { recursive: true });
		writeFileSync(join(root, "docs", "release-notes", `${version}.md`), notes, "utf8");
	}
	return root;
}

function runPrepareRelease(root: string, tag: string) {
	return spawnSync(process.execPath, [prepareRelease, "--tag", tag], {
		cwd: root,
		encoding: "utf8",
	});
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prepare-release: заметки версии", () => {
	it("кладёт заметки версии в bundle и покрывает их SHA256SUMS", () => {
		const root = fixture("9.9.9", "**Breaking release:** сделайте бэкап хранилища.\n");

		const result = runPrepareRelease(root, "v9.9.9");

		expect(result.status, result.stderr).toBe(0);
		const notes = readFileSync(join(root, "dist", "release", "RELEASE_NOTES.md"), "utf8");
		expect(notes).toBe("**Breaking release:** сделайте бэкап хранилища.\n");
		// publish не делает checkout: заметки должны пройти тот же sha256sum --check,
		// что и артефакты, иначе их подмена не была бы замечена
		const digest = createHash("sha256").update(notes, "utf8").digest("hex");
		expect(readFileSync(join(root, "dist", "release", "SHA256SUMS"), "utf8")).toContain(
			`${digest}  RELEASE_NOTES.md`,
		);
		expect(result.stdout).toContain("docs/release-notes/9.9.9.md");
	});

	it("без заметок версии кладёт пустой по смыслу файл — публикуются только автогенерируемые", () => {
		const root = fixture("9.9.10", null);

		const result = runPrepareRelease(root, "9.9.10");

		expect(result.status, result.stderr).toBe(0);
		// не нулевой размер (файл обязан пережить upload/download артефакта и
		// сойтись по SHA256SUMS), но и без единого непробельного символа
		const notes = readFileSync(join(root, "dist", "release", "RELEASE_NOTES.md"), "utf8");
		expect(notes).toBe("\n");
		expect(notes).not.toMatch(/\S/);
		expect(result.stdout).toContain("release notes: none");
	});

	it("берёт заметки по версии проекта, а не по произвольному тексту тега", () => {
		const root = fixture("9.9.11", "патч без миграции\n");
		mkdirSync(join(root, "docs", "release-notes"), { recursive: true });
		writeFileSync(join(root, "docs", "release-notes", "v9.9.11.md"), "не тот файл\n", "utf8");

		const result = runPrepareRelease(root, "v9.9.11");

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(root, "dist", "release", "RELEASE_NOTES.md"), "utf8")).toBe(
			"патч без миграции\n",
		);
	});
});

describe("release workflow", () => {
	it("не зашивает текст релиза в publish-шаг", () => {
		expect(workflow).not.toContain("RELEASE_PREAMBLE");
		expect(workflow).not.toContain("Breaking release");
		expect(workflow).not.toContain("Back up the vault");
	});

	it("публикует заметки из проверенного bundle и только при их наличии", () => {
		expect(workflow).toContain("grep -q '[^[:space:]]' dist/release/RELEASE_NOTES.md");
		expect(workflow).toContain("--notes-file dist/release/RELEASE_NOTES.md");
		// заметки — вход для --notes-file, а не публикуемый asset релиза
		for (const line of workflow.split("\n").filter((l) => l.includes("RELEASE_NOTES.md"))) {
			expect(line).toMatch(/grep -q |--notes-file /);
		}
	});
});

describe("docs/release-notes", () => {
	it("каждый файл назван выпущенной версией", () => {
		for (const name of readdirSync("docs/release-notes")) {
			expect(name, name).toMatch(/\.md$/);
			expect(releasedVersions, name).toContain(name.slice(0, -".md".length));
		}
	});

	it("breaking-предупреждение живёт в заметках 0.13.0 и ссылается на её тег", () => {
		const notes = readFileSync("docs/release-notes/0.13.0.md", "utf8");
		expect(notes).toContain("**Breaking release:**");
		expect(notes).toContain("blob/v0.13.0/docs/BREAKING_AI_INBOX_MVP.md");
	});

	it("заметки патча 0.13.1 не наследуют breaking-преамбулу 0.13.0", () => {
		const notes = readFileSync("docs/release-notes/0.13.1.md", "utf8");
		expect(notes).not.toContain("**Breaking release:**");
		expect(notes).not.toContain("Back up the vault");
	});
});
