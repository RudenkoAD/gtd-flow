import { describe, expect, it } from "vitest";
import { parseServerSentEvents } from "./sseParser";

async function parse(chunks: Array<Uint8Array | string>) {
	const events = [];
	for await (const event of parseServerSentEvents(chunks)) events.push(event);
	return events;
}

describe("parseServerSentEvents", () => {
	it("handles arbitrary chunks, CRLF, comments, and multiline data", async () => {
		const events = await parse([
			new TextEncoder().encode("\ufeff: keepalive\r\nevent: update\r\ndata: one"),
			"\r\ndata: two\r\nid: abc\r\nretry: 250\r\n\r\n",
		]);
		expect(events).toEqual([{ event: "update", data: "one\ntwo", id: "abc", retry: 250 }]);
	});

	it("does not dispatch comment-only or unterminated frames", async () => {
		await expect(parse([": ping\n\ndata: incomplete"])).resolves.toEqual([]);
	});

	it("does not mistake a CRLF split across chunks for two line endings", async () => {
		await expect(parse(["data: split\r", "\n\r", "\n"])).resolves.toEqual([
			{ event: "message", data: "split", id: null, retry: null },
		]);
	});

	it("accepts empty data frames and ignores invalid retry fields", async () => {
		await expect(parse(["data:\nretry: later\n\n"])).resolves.toEqual([
			{ event: "message", data: "", id: null, retry: null },
		]);
	});

	it("preserves the last event ID across frames", async () => {
		await expect(parse(["id: cursor-1\ndata: one\n\ndata: two\n\n"])).resolves.toEqual([
			{ event: "message", data: "one", id: "cursor-1", retry: null },
			{ event: "message", data: "two", id: "cursor-1", retry: null },
		]);
	});
});
