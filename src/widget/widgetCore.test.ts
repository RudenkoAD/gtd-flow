import { describe, expect, it } from "vitest";
import {
	buildEditedLine,
	captureTargetPath,
	computeWidgetData,
	type LineEdits,
	type WidgetData,
} from "./widgetCore";

function edit(rawLine: string, edits: LineEdits): { ok: boolean; line?: string; error?: string } {
	return JSON.parse(buildEditedLine(rawLine, edits)) as {
		ok: boolean;
		line?: string;
		error?: string;
	};
}

const files = {
	"GTD/Inbox.md":
		"---\ngtd-inbox: true\n---\n- [ ] Reconcile invoices ⏱ 90m 🧠 4 💓 2 💪 0 🧭 work\n",
	".gtd-flow/config/scopes.json": JSON.stringify({
		schemaVersion: 1,
		scopes: [{ id: "work", name: "Work", order: 0, archived: false }],
	}),
};

describe("widget metadata", () => {
	it("returns unified inbox items with parsed and resolved manual metadata", async () => {
		const data = JSON.parse(
			await computeWidgetData({
				files,
				dataJson: JSON.stringify({ inboxFile: "GTD/Inbox.md" }),
				todayIso: "2026-07-20",
				nowMinutes: 0,
				inboxScope: "work",
			}),
		) as WidgetData;
		expect(data.inbox.scope).toBe("work");
		expect(data.inbox.items[0]?.metadata).toEqual({
			durationMinutes: 90,
			durationLabel: "1h 30m",
			cognitiveIntensity: 4,
			emotionalIntensity: 2,
			physicalIntensity: 0,
			scopeId: "work",
			scopeName: "Work",
		});
		expect(data.scopes).toEqual([{ id: "work", name: "Work", archived: false }]);
	});

	it("uses the configured unified capture target", () => {
		expect(captureTargetPath(JSON.stringify({ inboxFile: "Capture.md" }))).toBe("Capture.md");
	});

	it("does not expose a legacy gtd-inbox file as a second inbox", async () => {
		const data = JSON.parse(
			await computeWidgetData({
				files: {
					...files,
					"GTD/Legacy Inbox.md": "---\ngtd-inbox: true\n---\n- [ ] Legacy task\n",
				},
				dataJson: JSON.stringify({ inboxFile: "GTD/Inbox.md" }),
				todayIso: "2026-07-20",
				nowMinutes: 0,
			}),
		) as WidgetData;
		expect(data.inbox.items.map((item) => item.title)).toEqual(["Reconcile invoices"]);
	});

	it("edits/clears all metadata fields in one returned line", () => {
		expect(
			edit("- [ ] Task", {
				durationMinutes: 90,
				cognitiveIntensity: 4,
				emotionalIntensity: 2,
				physicalIntensity: 0,
				scopeId: "work",
			}),
		).toEqual({ ok: true, line: "- [ ] Task ⏱ 90m 🧠 4 💓 2 💪 0 🧭 work" });
		expect(edit("- [ ] Task", { durationMinutes: 13 }).error).toBe("invalid-duration");
		expect(edit("- [ ] Task", { durationMinutes: 2_220 }).error).toBe("invalid-duration");
		expect(edit("- [ ] Task", { durationMinutes: 2_880 })).toEqual({
			ok: true,
			line: "- [ ] Task ⏱ 2880m",
		});
	});
});
