import { describe, expect, it } from "vitest";
import { projectContainerFrontmatter } from "../core/frontmatter/containerFrontmatter";
import { splitFrontmatter } from "../mcp/frontmatter";
import { parseWidgetContainerFrontmatter, parseWidgetFrontmatter } from "./widgetFrontmatter";

function expectMcpParity(content: string): void {
	const mcp = splitFrontmatter(content);
	expect(parseWidgetContainerFrontmatter(content)).toEqual(projectContainerFrontmatter(mcp.data));
}

describe("widget frontmatter scalar parity", () => {
	it("recognises YAML comments while preserving quoted hash characters", () => {
		const frontmatter = parseWidgetFrontmatter(
			"--- # metadata\n" +
				"gtd-inbox: true # managed inbox\n" +
				'gtd-namespace: "Work #1" # display name\n' +
				"url: https://example.test/feed#calendar\n" +
				"label: 'Anton''s tasks' # unrelated\n" +
				"---\n",
		);
		expect(frontmatter).toEqual({
			"gtd-inbox": true,
			"gtd-namespace": "Work #1",
		});
		expectMcpParity(
			"--- # metadata\n" +
				"gtd-inbox: true # managed inbox\n" +
				'gtd-namespace: "Work #1" # display name\n' +
				"url: https://example.test/feed#calendar\n" +
				"---\n",
		);
	});

	it("matches MCP YAML projection for every consumed key", () => {
		const cases = [
			"gtd-recurring: true",
			"gtd-events: TRUE # case-insensitive YAML boolean",
			'gtd-card-of: "card\\x2D42"',
			"gtd-project: true\nstatus: 'on-hold'",
			"gtd-board: true",
			"gtd-archive: true",
			"gtd-inbox: true",
			"gtd-external: true",
			"gtd-namespace: ' Work #1 '",
		];
		for (const yaml of cases) expectMcpParity(`---\n${yaml}\n---\n`);
	});

	it("matches full YAML for nulls, empty documents, escapes, and supported scalar numbers", () => {
		expectMcpParity(
			"---\n" +
				"gtd-card-of: 42\n" +
				"gtd-namespace: null\n" +
				"gtd-project: true\n" +
				'status: "on\\x2Dhold"\n' +
				"---\n",
		);
		expectMcpParity("---\n---\n");
		expectMcpParity(
			"---\ngtd-events: false\ngtd-card-of: null\ngtd-external: false\ngtd-namespace: ~\n---\n",
		);
		expectMcpParity("not frontmatter\n");
	});

	it("treats comment-only relevant values as YAML null", () => {
		const card = "---\ngtd-card-of: # no card\n---\n";
		const namespace = "---\ngtd-namespace: # no override\n---\n";
		const status = "---\ngtd-project: true\nstatus: # default active\n---\n";
		for (const content of [card, namespace, status]) expectMcpParity(content);
		expect(parseWidgetContainerFrontmatter(card).container).toBe("plain");
		expect(parseWidgetContainerFrontmatter(namespace).nsOverride).toBeUndefined();
		expect(parseWidgetContainerFrontmatter(status)).toEqual({ container: "project" });
	});

	it("reads simply quoted keys with YAML double-quote escapes", () => {
		const quotedStatus = '---\ngtd-project: true\n"status": done\n---\n';
		const escapedStatus = '---\ngtd-project: true\n"st\\x61tus": done\n---\n';
		const quotedInbox = "---\n'gtd-inbox': true\n---\n";
		for (const content of [quotedStatus, escapedStatus, quotedInbox]) expectMcpParity(content);
		expect(parseWidgetContainerFrontmatter(quotedStatus).projectStatus).toBe("done");
		expect(parseWidgetContainerFrontmatter(escapedStatus).projectStatus).toBe("done");
		expect(parseWidgetContainerFrontmatter(quotedInbox).container).toBe("inbox");
	});

	it("requires whitespace before an inline comment after a quoted scalar", () => {
		const malformed = '---\ngtd-namespace: "Work"#oops\n---\n';
		expectMcpParity(malformed);
		expect(parseWidgetContainerFrontmatter(malformed).nsOverride).toBeUndefined();
	});

	it("fails closed for malformed or unsupported relevant values", () => {
		// Full YAML rejects this document; bounded parsing must not retain the
		// preceding project flag and accidentally classify the file as a project.
		expectMcpParity("---\ngtd-project: true\nstatus: [unterminated\n---\n");
		expectMcpParity('---\ngtd-project: true\nstatus: "unterminated\n---\n');
		// This mapping is valid YAML but unsupported as a scalar. The shared
		// projection treats it as an invalid project status (on-hold), never active.
		expectMcpParity("---\ngtd-project: true\nstatus: { value: done }\n---\n");
		expectMcpParity("---\ngtd-card-of: [not-a-card-id]\n---\n");
	});

	it("rejects obvious unrelated YAML damage and keeps valid nested board data", () => {
		const malformedUnrelated = "---\ngtd-project: true\nbad: [unterminated\n---\n";
		const duplicateUnrelated = "---\ngtd-project: true\nx: one\nx: two\n---\n";
		const forbiddenPlainValues = ["]", "}", ","].map(
			(value) => `---\ngtd-project: true\nbad: ${value}\n---\n`,
		);
		for (const content of [malformedUnrelated, duplicateUnrelated, ...forbiddenPlainValues]) {
			expectMcpParity(content);
		}
		expect(parseWidgetContainerFrontmatter(malformedUnrelated).container).toBe("plain");
		expect(parseWidgetContainerFrontmatter(duplicateUnrelated).container).toBe("plain");

		const board =
			"---\n" +
			"gtd-board: true\n" +
			"columns:\n" +
			"  - id: todo\n" +
			"    name: Todo\n" +
			"order:\n" +
			"  todo:\n" +
			"    - card-1\n" +
			"---\n";
		expectMcpParity(board);
		expect(parseWidgetContainerFrontmatter(board).container).toBe("board");
	});

	it("rejects obvious malformed nested mapping values", () => {
		const brokenFlow = "---\ngtd-project: true\ncustom:\n  bad: [unterminated\n---\n";
		const brokenQuote = '---\ngtd-project: true\ncustom:\n  bad: "unterminated\n---\n';
		for (const content of [brokenFlow, brokenQuote]) expectMcpParity(content);
		expect(parseWidgetContainerFrontmatter(brokenFlow).container).toBe("plain");
		expect(parseWidgetContainerFrontmatter(brokenQuote).container).toBe("plain");
	});
});
