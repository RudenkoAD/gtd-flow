import { beforeEach, describe, expect, it, vi } from "vitest";

const { notice, TFileMock, MarkdownViewMock } = vi.hoisted(() => ({
	notice: vi.fn(),
	TFileMock: class {},
	MarkdownViewMock: class {},
}));

vi.mock("obsidian", () => ({
	Notice: notice,
	TFile: TFileMock,
	MarkdownView: MarkdownViewMock,
}));

import { openTaskInFile } from "./openTask";

describe("openTaskInFile", () => {
	beforeEach(() => notice.mockClear());

	it("reports a rejected leaf open instead of leaking it to the click boundary", async () => {
		const file = new TFileMock();
		const app = {
			vault: { getAbstractFileByPath: vi.fn(() => file) },
			workspace: {
				getLeaf: vi.fn(() => ({
					openFile: vi.fn().mockRejectedValue(new Error("workspace closed")),
				})),
			},
		};

		await expect(
			openTaskInFile(app as never, { filePath: "GTD/Inbox.md", lineStart: 3 }),
		).resolves.toBeUndefined();
		expect(notice).toHaveBeenCalledWith(expect.stringContaining("workspace closed"));
	});
});
