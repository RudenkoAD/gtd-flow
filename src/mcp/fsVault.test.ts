import { promises as fs } from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsVault, McpMutationConflictError, McpVaultScanError } from "./fsVault";
import { makeVault, readVaultFile, removeVault } from "./testVault";

/**
 * Размер фикстуры для регрессии счётчиков ввода-вывода. Тест проверяет РАБОТУ
 * второго скана («ровно один fs.open, ноль readdir»), а не время: на 3 000
 * заметок гарантия та же, а прогон укладывается в бюджет и на обычном диске с
 * антивирусом (10 000 стоили ~31 с и делали гейт `npm run verify` красным на
 * машине мейнтейнера). Полномасштабный замер — `GTD_PERF_NOTES=10000`.
 */
const SCALE_NOTES = ((): number => {
	const configured = Number(process.env.GTD_PERF_NOTES);
	return Number.isSafeInteger(configured) && configured >= 100 ? configured : 3_000;
})();

describe("FsVault", () => {
	let root: string;
	let vault: FsVault;

	beforeEach(async () => {
		root = await makeVault({
			"Note.md": "hello\n",
			"Sub/Deep.md": "deep\n",
			"Board.md": "---\ngtd-board: true\nid: b\n---\n- [ ] card\n",
		});
		vault = new FsVault(root);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	it("read-modify-write заменяет содержимое; no-op не пишет", async () => {
		const changed = await vault.processFile("Note.md", (c) => c.toUpperCase());
		expect(changed).toBe(true);
		expect(await readVaultFile(root, "Note.md")).toBe("HELLO\n");

		// transform вернул исходную строку — записи нет
		const noop = await vault.processFile("Note.md", (c) => c);
		expect(noop).toBe(false);

		// transform вернул null — записи нет
		const nullNoop = await vault.processFile("Note.md", () => null);
		expect(nullNoop).toBe(false);
	});

	it("processFile для несуществующего файла → false, без создания", async () => {
		const changed = await vault.processFile("Missing.md", () => "x");
		expect(changed).toBe(false);
		await expect(fs.access(path.join(root, "Missing.md"))).rejects.toBeDefined();
	});

	it("запись атомарна: temp-файлы не остаются", async () => {
		await vault.processFile("Note.md", (c) => c + "more\n");
		const entries = await fs.readdir(root);
		expect(entries.some((e) => e.includes(".tmp"))).toBe(false);
		expect(await readVaultFile(root, "Note.md")).toBe("hello\nmore\n");
	});

	// Явный бюджет: 100 сериализованных мутаций (по три realpath на снимок плюс
	// writeFile+chmod+rename) на изолированном прогоне занимают ~2 с, но под
	// нагрузкой всего сюита стабильно перебирали дефолтные 5 с vitest.
	it("100 параллельных append из разных FsVault сохраняют все успешные изменения", async () => {
		const writes = Array.from({ length: 100 }, (_, i) =>
			new FsVault(root).processFile("Note.md", (content) => `${content}parallel-${i}\n`),
		);
		expect(await Promise.all(writes)).toEqual(Array.from({ length: 100 }, () => true));
		const lines = (await readVaultFile(root, "Note.md"))
			.split("\n")
			.filter((line) => line.startsWith("parallel-"));
		expect(lines).toHaveLength(100);
		expect(new Set(lines)).toHaveLength(100);
	}, 30_000);

	it("очередь мутаций не блокирует независимые файлы", async () => {
		let enterSlowCommit!: () => void;
		let releaseSlowCommit!: () => void;
		const slowCommitEntered = new Promise<void>((resolve) => {
			enterSlowCommit = resolve;
		});
		const slowCommitGate = new Promise<void>((resolve) => {
			releaseSlowCommit = resolve;
		});
		const slowVault = new FsVault(root, {
			beforeCommit: async ({ relPath }) => {
				if (relPath !== "Note.md") return;
				enterSlowCommit();
				await slowCommitGate;
			},
		});

		const slowWrite = slowVault.processFile("Note.md", (content) => `${content}slow\n`);
		await slowCommitEntered;
		// A global coordinator would deadlock here behind slowWrite. The queue is
		// intentionally keyed by canonical path, so another file can commit now.
		expect(
			await new FsVault(root).processFile("Sub/Deep.md", (content) => `${content}fast\n`),
		).toBe(true);
		releaseSlowCommit();
		expect(await slowWrite).toBe(true);
		expect(await readVaultFile(root, "Sub/Deep.md")).toContain("fast\n");
	});

	it("внешняя правка между read и commit повторяет transform на актуальном содержимом", async () => {
		let injected = false;
		const racing = new FsVault(root, {
			beforeCommit: async () => {
				if (injected) return;
				injected = true;
				await fs.writeFile(path.join(root, "Note.md"), "external edit\n", "utf8");
			},
		});
		expect(await racing.processFile("Note.md", (content) => `${content}from MCP\n`)).toBe(true);
		expect(await readVaultFile(root, "Note.md")).toBe("external edit\nfrom MCP\n");
	});

	it("не сообщает успех при непрекращающемся внешнем конфликте", async () => {
		let serial = 0;
		const racing = new FsVault(root, {
			maxMutationAttempts: 2,
			beforeCommit: async () => {
				serial++;
				await fs.writeFile(path.join(root, "Note.md"), `external-${serial}\n`, "utf8");
			},
		});
		await expect(
			racing.processFile("Note.md", (content) => `${content}from MCP\n`),
		).rejects.toBeInstanceOf(McpMutationConflictError);
		expect(await readVaultFile(root, "Note.md")).toBe("external-2\n");
	});

	it("отказывается писать за пределами vault (../ и абсолютный путь)", async () => {
		expect(() => new FsVault(root)).not.toThrow();
		await expect(vault.processFile("../escape.md", () => "x")).rejects.toThrow(
			/выходит за пределы/,
		);
		await expect(vault.processFile("Sub/../../escape.md", () => "x")).rejects.toThrow(
			/выходит за пределы/,
		);
		// путь ВНУТРИ через ../ обратно допустим
		const ok = await vault.processFile("Sub/../Note.md", (c) => c + "!");
		expect(ok).toBe(true);
	});

	it("симлинк внутри vault, ведущий наружу, не пробивает песочницу", async () => {
		// внешняя папка-жертва рядом с vault
		const outside = path.join(path.dirname(root), `outside-${path.basename(root)}`);
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "secret.md"), "secret\n", "utf8");
		try {
			try {
				await fs.symlink(outside, path.join(root, "link"), "dir");
			} catch {
				return; // нет прав на симлинки (Windows CI) — тест не о том
			}
			// чтение и запись через симлинк-обход должны быть отвергнуты
			await expect(vault.processFile("link/secret.md", () => "pwned")).rejects.toThrow(
				/выходит за пределы/,
			);
			await expect(vault.readFile("link/secret.md")).rejects.toThrow(/выходит за пределы/);
			// ...и файл снаружи не тронут
			expect(await fs.readFile(path.join(outside, "secret.md"), "utf8")).toBe("secret\n");
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("vault, сам являющийся симлинком, работает (realpath-корень)", async () => {
		const linkRoot = path.join(path.dirname(root), `linkroot-${path.basename(root)}`);
		try {
			try {
				await fs.symlink(root, linkRoot, "dir");
			} catch {
				return; // нет прав на симлинки
			}
			const linked = new FsVault(linkRoot);
			const ok = await linked.processFile("Note.md", (c) => c + "via-link\n");
			expect(ok).toBe(true);
			await expect(linked.processFile("../escape.md", () => "x")).rejects.toThrow(
				/выходит за пределы/,
			);
		} finally {
			await fs.rm(linkRoot, { force: true });
		}
	});

	it("ensureFile создаёт файл и родительские папки, существующий не трогает", async () => {
		await vault.ensureFile("New/Folder/File.md");
		expect(await readVaultFile(root, "New/Folder/File.md")).toBe("");
		// существующий файл не перезаписывается
		await vault.ensureFile("Note.md");
		expect(await readVaultFile(root, "Note.md")).toBe("hello\n");
	});

	it("processFrontmatter создаёт и мутирует frontmatter, тело сохраняет", async () => {
		// файл без frontmatter — блок создаётся в начале
		const ok = await vault.processFrontmatter("Note.md", (fm) => {
			fm["gtd-inbox"] = true;
		});
		expect(ok).toBe(true);
		const content = await readVaultFile(root, "Note.md");
		expect(content.startsWith("---\n")).toBe(true);
		expect(content).toContain("gtd-inbox: true");
		expect(content.trimEnd().endsWith("hello")).toBe(true);
	});

	it("processFrontmatter мутирует существующий frontmatter, не теряя чужие ключи", async () => {
		await vault.processFrontmatter("Board.md", (fm) => {
			fm["order"] = { todo: ["card01"] };
		});
		const fm = vault.readFrontmatterSync("Board.md");
		expect(fm).not.toBeNull();
		expect(fm!["gtd-board"]).toBe(true);
		expect(fm!["id"]).toBe("b");
		expect(fm!["order"]).toEqual({ todo: ["card01"] });
	});

	it("битый существующий YAML fail-closed и оставляет байты заметки нетронутыми", async () => {
		const broken = "---\ngtd-board: [unterminated\n---\n- [ ] important\n";
		await fs.writeFile(path.join(root, "Broken.md"), broken, "utf8");
		await expect(
			vault.processFrontmatter("Broken.md", (fm) => {
				fm["gtd-board"] = true;
			}),
		).rejects.toThrow(/invalid YAML frontmatter/);
		await expect(
			vault.processFrontmatter("Broken.md", (fm) => {
				fm["gtd-board"] = true;
			}),
		).rejects.toThrow(/Broken\.md/);
		expect(await readVaultFile(root, "Broken.md")).toBe(broken);
	});

	it("незакрытый frontmatter не считается отсутствующим и сохраняется побайтно", async () => {
		const unterminated = "---\ngtd-board: true\nprivate-token: keep-me\n- [ ] important\n";
		await fs.writeFile(path.join(root, "Unterminated.md"), unterminated, "utf8");

		await expect(
			vault.processFrontmatter("Unterminated.md", (fm) => {
				fm["gtd-board"] = false;
			}),
		).rejects.toThrow(/opening delimiter has no closing delimiter/);
		expect(await readVaultFile(root, "Unterminated.md")).toBe(unterminated);
	});

	it("opening delimiter с пробелами/комментарием считается существующим frontmatter", async () => {
		const commented =
			"--- \t# managed metadata\nprivate-token: keep-me\ngtd-board: [broken\n---\n- [ ] important\n";
		await fs.writeFile(path.join(root, "CommentedBroken.md"), commented, "utf8");

		await expect(
			vault.processFrontmatter("CommentedBroken.md", (fm) => {
				fm["gtd-board"] = true;
			}),
		).rejects.toThrow(/invalid YAML frontmatter/);
		expect(await readVaultFile(root, "CommentedBroken.md")).toBe(commented);
	});

	it("валидный opening delimiter с комментарием разбирается и не теряет ключи", async () => {
		await fs.writeFile(
			path.join(root, "Commented.md"),
			"--- # metadata\nprivate-token: keep-me\n---\nbody\n",
			"utf8",
		);

		expect(
			await vault.processFrontmatter("Commented.md", (fm) => {
				fm["gtd-inbox"] = true;
			}),
		).toBe(true);
		expect(await readVaultFile(root, "Commented.md")).toBe(
			"---\nprivate-token: keep-me\ngtd-inbox: true\n---\nbody\n",
		);
	});

	it("пустой закрытый frontmatter остаётся валидным", async () => {
		await fs.writeFile(path.join(root, "EmptyFm.md"), "---\n---\nbody\n", "utf8");

		expect(
			await vault.processFrontmatter("EmptyFm.md", (fm) => {
				fm["gtd-inbox"] = true;
			}),
		).toBe(true);
		expect(await readVaultFile(root, "EmptyFm.md")).toBe("---\ngtd-inbox: true\n---\nbody\n");
	});

	it("listMarkdownFiles обходит рекурсивно и пропускает .obsidian/.git", async () => {
		await makeVaultDot(root);
		const files = await vault.listMarkdownFiles();
		const paths = files.map((f) => f.path).sort();
		expect(paths).toContain("Note.md");
		expect(paths).toContain("Sub/Deep.md");
		expect(paths).toContain("Board.md");
		expect(paths.some((p) => p.startsWith(".obsidian"))).toBe(false);
		expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
	});

	it("инкрементальный scan не перечисляет неизменённый vault, но видит внешние edit/add/remove", async () => {
		const first = await vault.scanMarkdownFiles();
		const bodyOpenSpy = vi.spyOn(fs, "open");
		const readdirSpy = vi.spyOn(fs, "readdir");
		try {
			const unchanged = await new FsVault(root).scanMarkdownFiles();
			expect(unchanged.revision).toBe(first.revision);
			expect(bodyOpenSpy).not.toHaveBeenCalled();
			expect(readdirSpy).not.toHaveBeenCalled();

			await fs.writeFile(path.join(root, "Note.md"), "changed externally\n", "utf8");
			const changed = await new FsVault(root).scanMarkdownFiles();
			expect(changed.revision).not.toBe(first.revision);
			expect(changed.files.find((file) => file.path === "Note.md")?.content).toBe(
				"changed externally\n",
			);
			expect(bodyOpenSpy).toHaveBeenCalledTimes(1);
			expect(readdirSpy).not.toHaveBeenCalled();

			await fs.writeFile(path.join(root, "Sub", "Added.md"), "added externally\n", "utf8");
			const withAddition = await new FsVault(root).scanMarkdownFiles();
			expect(withAddition.files.find((file) => file.path === "Sub/Added.md")?.content).toBe(
				"added externally\n",
			);
			expect(readdirSpy).toHaveBeenCalled();

			readdirSpy.mockClear();
			await fs.unlink(path.join(root, "Sub", "Added.md"));
			const withoutAddition = await new FsVault(root).scanMarkdownFiles();
			expect(withoutAddition.files.some((file) => file.path === "Sub/Added.md")).toBe(false);
			expect(readdirSpy).toHaveBeenCalled();
		} finally {
			bodyOpenSpy.mockRestore();
			readdirSpy.mockRestore();
		}
	});

	it("кэш скана канонизирует допустимый путь с .. и не дублирует файл", async () => {
		await vault.scanMarkdownFiles();
		expect(await vault.processFile("Sub/../Note.md", (content) => `${content}updated\n`)).toBe(
			true,
		);

		const scan = await new FsVault(root).scanMarkdownFiles();
		expect(scan.files.filter((file) => file.path === "Note.md")).toHaveLength(1);
		expect(scan.files.some((file) => file.path.includes(".."))).toBe(false);
	});

	it("fail-closed, если каталог исчезает между lstat и readdir", async () => {
		await fs.mkdir(path.join(root, "Race"));
		await fs.writeFile(path.join(root, "Race", "Task.md"), "- [ ] race\n", "utf8");
		const racing = new FsVault(root, {
			beforeDirectoryRead: async (relPath) => {
				if (relPath === "Race")
					await fs.rm(path.join(root, "Race"), { recursive: true, force: true });
			},
		});

		await expect(racing.scanMarkdownFiles()).rejects.toBeInstanceOf(McpVaultScanError);
	});

	it("cached scan rejects a note swapped for an outside symlink without opening its target", async () => {
		const outside = path.join(path.dirname(root), `outside-scan-${path.basename(root)}`);
		const outsideFile = path.join(outside, "secret.md");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(outsideFile, "outside-secret\n", "utf8");
		try {
			await vault.scanMarkdownFiles();
			try {
				await fs.unlink(path.join(root, "Note.md"));
				await fs.symlink(outsideFile, path.join(root, "Note.md"), "file");
			} catch {
				return; // symlinks are unavailable in this environment
			}

			const bodyOpenSpy = vi.spyOn(fs, "open");
			try {
				const scan = await new FsVault(root).scanMarkdownFiles();
				expect(scan.files.some((file) => file.path === "Note.md")).toBe(false);
				expect(scan.files.some((file) => file.content.includes("outside-secret"))).toBe(
					false,
				);
				expect(bodyOpenSpy).not.toHaveBeenCalled();
			} finally {
				bodyOpenSpy.mockRestore();
			}
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("large metadata index rereads exactly one externally edited body without re-enumerating", async () => {
		const scaleDir = path.join(root, "Scale");
		await fs.mkdir(scaleDir);
		// Batches keep this representative fixture from opening thousands of file
		// descriptors at once. This is a regression benchmark, not a wall-clock
		// assertion: it verifies the I/O work performed by the second scan.
		for (let start = 0; start < SCALE_NOTES; start += 64) {
			await Promise.all(
				Array.from({ length: Math.min(64, SCALE_NOTES - start) }, (_, offset) => {
					const index = start + offset;
					return fs.writeFile(
						path.join(scaleDir, `note-${index.toString().padStart(5, "0")}.md`),
						`- [ ] task ${index}\n`,
						"utf8",
					);
				}),
			);
		}

		const first = await new FsVault(root).scanMarkdownFiles();
		expect(first.files).toHaveLength(SCALE_NOTES + 3);
		const bodyOpenSpy = vi.spyOn(fs, "open");
		const readdirSpy = vi.spyOn(fs, "readdir");
		try {
			const unchanged = await new FsVault(root).scanMarkdownFiles();
			expect(unchanged.revision).toBe(first.revision);
			expect(bodyOpenSpy).not.toHaveBeenCalled();
			expect(readdirSpy).not.toHaveBeenCalled();

			const editedPath = `Scale/note-${Math.floor(SCALE_NOTES / 2)
				.toString()
				.padStart(5, "0")}.md`;
			await fs.writeFile(path.join(root, editedPath), "- [ ] changed task\n", "utf8");
			const changed = await new FsVault(root).scanMarkdownFiles();
			expect(changed.revision).not.toBe(first.revision);
			expect(changed.files.find((file) => file.path === editedPath)?.content).toBe(
				"- [ ] changed task\n",
			);
			expect(bodyOpenSpy).toHaveBeenCalledTimes(1);
			expect(readdirSpy).not.toHaveBeenCalled();
		} finally {
			bodyOpenSpy.mockRestore();
			readdirSpy.mockRestore();
		}
	}, 30_000);

	it("атомарная замена сохраняет private file mode", async () => {
		if (process.platform === "win32") return; // POSIX mode bits отсутствуют
		const target = path.join(root, "Note.md");
		await fs.chmod(target, 0o600);
		await vault.processFile("Note.md", (content) => `${content}private\n`);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	});
});

/** Дописать скрытые папки, которые скан обязан пропустить. */
async function makeVaultDot(root: string): Promise<void> {
	await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
	await fs.writeFile(path.join(root, ".obsidian", "config.md"), "x", "utf8");
	await fs.mkdir(path.join(root, ".git"), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD.md"), "x", "utf8");
}
