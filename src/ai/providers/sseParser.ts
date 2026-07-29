/**
 * Small SSE parser following the event-stream framing rules. It accepts arbitrary
 * chunk boundaries, CRLF/LF/CR line endings, multiline data, comments and a UTF-8
 * BOM. No frame content is logged or retained after it is yielded.
 */
export interface ServerSentEvent {
	event: string;
	data: string;
	id: string | null;
	retry: number | null;
}

export async function* parseServerSentEvents(
	chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
): AsyncGenerator<ServerSentEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let firstChunk = true;
	let eventName = "message";
	let dataLines: string[] = [];
	let lastEventId: string | null = null;
	let retry: number | null = null;
	let sawData = false;

	const dispatch = (): ServerSentEvent | null => {
		if (!sawData) return null;
		const result: ServerSentEvent = {
			event: eventName,
			data: dataLines.join("\n"),
			id: lastEventId,
			retry,
		};
		eventName = "message";
		dataLines = [];
		sawData = false;
		return result;
	};
	const processLine = (line: string): ServerSentEvent | null => {
		if (line.length === 0) return dispatch();
		if (line.startsWith(":")) return null;

		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? "" : line.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (field) {
			case "event":
				eventName = value;
				break;
			case "data":
				dataLines.push(value);
				sawData = true;
				break;
			case "id":
				// The SSE spec ignores IDs that contain a NUL.
				if (!value.includes("\0")) lastEventId = value;
				break;
			case "retry": {
				if (/^\d+$/.test(value)) retry = Number(value);
				break;
			}
		}
		return null;
	};

	for await (const chunk of chunks) {
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		if (firstChunk && buffer.length > 0) {
			firstChunk = false;
			if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
		}

		for (;;) {
			const lineEnd = nextLineEnd(buffer, false);
			if (!lineEnd) break;
			const line = buffer.slice(0, lineEnd.index);
			buffer = buffer.slice(lineEnd.index + lineEnd.length);
			const complete = processLine(line);
			if (complete) yield complete;
		}
	}

	buffer += decoder.decode();
	if (firstChunk && buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
	for (;;) {
		const lineEnd = nextLineEnd(buffer, true);
		if (!lineEnd) break;
		const line = buffer.slice(0, lineEnd.index);
		buffer = buffer.slice(lineEnd.index + lineEnd.length);
		const complete = processLine(line);
		if (complete) yield complete;
	}
}

function nextLineEnd(
	value: string,
	allowTrailingCarriageReturn: boolean,
): { index: number; length: number } | null {
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === "\n") return { index, length: 1 };
		if (char === "\r") {
			if (index + 1 === value.length && !allowTrailingCarriageReturn) return null;
			return { index, length: value[index + 1] === "\n" ? 2 : 1 };
		}
	}
	return null;
}
