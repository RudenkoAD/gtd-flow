import { beforeEach, describe, expect, it, vi } from "vitest";

const { notice } = vi.hoisted(() => ({ notice: vi.fn() }));
vi.mock("obsidian", () => ({ Notice: notice }));

import { reportAsync, runAction, runVoidAction } from "./runAction";

describe("runAction", () => {
	beforeEach(() => notice.mockClear());

	it("keeps expected write refusals observable", async () => {
		const result = await runAction("сохранение", async () => ({ ok: false, reason: "stale" }));
		expect(result).toEqual({ ok: false, reason: "stale" });
		expect(notice).toHaveBeenCalledWith("GTD Flow: сохранение: stale");
	});

	it("catches thrown async actions and returns null for rollback", async () => {
		const result = await runAction("сохранение", async () => {
			throw new Error("disk full");
		});
		expect(result).toBeNull();
		expect(notice).toHaveBeenCalledWith(expect.stringContaining("disk full"));
	});

	it("observes rejections from markup-boundary fire-and-forget work", async () => {
		reportAsync("фон", async () => {
			throw new Error("boom");
		});
		await Promise.resolve();
		expect(notice).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});

	it("observes a synchronous throw before an action returns its promise", async () => {
		reportAsync("фон", () => {
			throw new Error("sync boom");
		});
		expect(notice).toHaveBeenCalledWith(expect.stringContaining("sync boom"));
	});

	it("allows background operations to resolve to a report", async () => {
		reportAsync("фон", async () => ({ spawned: 2, errors: [] as string[] }));
		await Promise.resolve();
		expect(notice).not.toHaveBeenCalled();
	});

	it("returns false for thrown void ports", async () => {
		expect(
			await runVoidAction("layout", async () => Promise.reject(new Error("readonly"))),
		).toBe(false);
		expect(notice).toHaveBeenCalledWith(expect.stringContaining("readonly"));
	});
});
