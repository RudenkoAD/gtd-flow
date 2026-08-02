import { describe, expect, it, vi } from "vitest";
import { FeedbackStorageAdapter, type FeedbackFilePort } from "./FeedbackStorageAdapter";

function files(writeNew: FeedbackFilePort["writeNew"]): FeedbackFilePort {
	return {
		list: vi.fn().mockResolvedValue([]),
		read: vi.fn().mockResolvedValue(null),
		writeAtomic: vi.fn().mockResolvedValue(undefined),
		writeNew,
		remove: vi.fn().mockResolvedValue(undefined),
	};
}

describe("FeedbackStorageAdapter", () => {
	it("maps immutable vault collisions to feedback conflicts", async () => {
		const adapter = new FeedbackStorageAdapter(
			files(vi.fn().mockRejectedValue(new Error("vault-file-exists:.gtd-flow/event.json"))),
		);

		await expect(adapter.writeNew(".gtd-flow/event.json", "{}\n")).rejects.toThrow(
			"feedback-event-conflict",
		);
	});

	it("preserves unrelated storage failures", async () => {
		const failure = new Error("disk-unavailable");
		const adapter = new FeedbackStorageAdapter(files(vi.fn().mockRejectedValue(failure)));

		await expect(adapter.writeNew(".gtd-flow/event.json", "{}\n")).rejects.toBe(failure);
	});
});
