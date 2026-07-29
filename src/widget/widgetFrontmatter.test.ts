import { describe, expect, it } from "vitest";
import { parseWidgetContainerFrontmatter, parseWidgetFrontmatter } from "./widgetFrontmatter";

describe("widget frontmatter", () => {
	it("projects supported global container flags without namespace metadata", () => {
		const content = "---\ngtd-inbox: true\ngtd-project: false\n---\n- [ ] Task\n";
		expect(parseWidgetFrontmatter(content)).toEqual({
			"gtd-inbox": true,
			"gtd-project": false,
		});
		expect(parseWidgetContainerFrontmatter(content).container).toBe("inbox");
	});

	it("refuses malformed relevant frontmatter", () => {
		expect(parseWidgetFrontmatter("---\ngtd-inbox: [\n---\n")).toBeNull();
	});
});
