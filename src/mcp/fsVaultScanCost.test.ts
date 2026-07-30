/**
 * Регрессия СТОИМОСТИ проверки путей на скане (отдельный файл: здесь модуль fs
 * подменяется целиком, чтобы посчитать синхронные realpathSync).
 *
 * История: холодный скан 10 000 заметок занимал ~31 с, из них ~26 с — три
 * СИНХРОННЫХ realpathSync на файл (дубль в scanMarkdownFiles плюс два в
 * snapshot). Синхронность вдобавок обнуляла SCAN_IO_CONCURRENCY и на всё время
 * скана подвешивала MCP-процесс. Инвариант: одна проверка до чтения и одна
 * после (защита от подмены во время чтения), обе — асинхронные.
 */
import { promises as fs } from "fs";
import { describe, expect, it, vi } from "vitest";
import { makeVault, removeVault } from "./testVault";
import { FsVault } from "./fsVault";

const syncRealpath = vi.hoisted(() => ({ calls: 0 }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const counted = ((target: string, options?: unknown) => {
		syncRealpath.calls++;
		return (actual.realpathSync as (t: string, o?: unknown) => string)(target, options);
	}) as unknown as typeof actual.realpathSync;
	counted.native = actual.realpathSync.native;
	return { ...actual, realpathSync: counted, default: { ...actual, realpathSync: counted } };
});

describe("FsVault: стоимость проверки путей на скане", () => {
	it("холодный скан проверяет файл ровно дважды и не зовёт синхронный realpath", async () => {
		const root = await makeVault({
			"A.md": "a\n",
			"B.md": "b\n",
			"Sub/C.md": "c\n",
			"Sub/notes.txt": "не markdown\n",
		});
		try {
			// realpath корня в конструкторе — синхронный и однократный, до замера.
			// Он же доказывает, что счётчик действительно подменил fs у FsVault.
			syncRealpath.calls = 0;
			const vault = new FsVault(root);
			expect(syncRealpath.calls).toBe(1);
			syncRealpath.calls = 0;
			const realpathSpy = vi.spyOn(fs, "realpath");
			try {
				const scan = await vault.scanMarkdownFiles();
				expect(scan.files.map((file) => file.path).sort()).toEqual([
					"A.md",
					"B.md",
					"Sub/C.md",
				]);

				const perFile = realpathSpy.mock.calls.filter(([target]) =>
					String(target).toLowerCase().endsWith(".md"),
				);
				expect(perFile).toHaveLength(3 * 2);
				expect(syncRealpath.calls).toBe(0);
			} finally {
				realpathSpy.mockRestore();
			}
		} finally {
			await removeVault(root);
		}
	});

	it("повторный скан неизменённого vault не проверяет пути файлов вовсе", async () => {
		const root = await makeVault({ "A.md": "a\n", "Sub/C.md": "c\n" });
		try {
			await new FsVault(root).scanMarkdownFiles();
			const vault = new FsVault(root);
			syncRealpath.calls = 0;
			const realpathSpy = vi.spyOn(fs, "realpath");
			try {
				await vault.scanMarkdownFiles();
				const perFile = realpathSpy.mock.calls.filter(([target]) =>
					String(target).toLowerCase().endsWith(".md"),
				);
				expect(perFile).toHaveLength(0);
				expect(syncRealpath.calls).toBe(0);
			} finally {
				realpathSpy.mockRestore();
			}
		} finally {
			await removeVault(root);
		}
	});
});
