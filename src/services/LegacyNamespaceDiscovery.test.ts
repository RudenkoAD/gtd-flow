import { describe, expect, it } from "vitest";
import { makeTask } from "../stores/testSupport";
import { LEGACY_DEFAULT_NAMESPACE } from "../core/scope/namespaceMigration";
import {
	discoverLegacyNamespaceInventory,
	legacyNamespaceForPath,
} from "./LegacyNamespaceDiscovery";

describe("LegacyNamespaceDiscovery", () => {
	it("reads path membership and compatibility override only while building the migration inventory", () => {
		const discovered = discoverLegacyNamespaceInventory({
			namespaces: [
				{ name: "Work", root: "Areas/Work" },
				{ name: "Deep", root: "Areas/Work/Deep" },
			],
			today: "2026-07-28",
			inboxPaths: ["GTD/Inbox.md"],
			overrideForPath: (path) => (path === "Areas/Work/Private.md" ? "Life" : null),
			tasks: [
				makeTask({
					taskId: "work",
					filePath: "Areas/Work/Inbox.md",
					container: "inbox",
				}),
				makeTask({
					taskId: "private",
					filePath: "Areas/Work/Private.md",
					container: "plain",
				}),
				makeTask({ taskId: null, filePath: "Areas/Work/No id.md", container: "plain" }),
			],
		});
		expect(discovered.inventory.inboxes).toEqual([
			{ namespace: "Work", path: "Areas/Work/Inbox.md", activeTaskIds: ["work"] },
			{ namespace: LEGACY_DEFAULT_NAMESPACE, path: "GTD/Inbox.md", activeTaskIds: [] },
		]);
		expect(discovered.inventory.tasks.map((task) => [task.taskId, task.namespace])).toEqual([
			["work", "Work"],
			[expect.stringMatching(/^migration_/u), "Work"],
			["private", "Life"],
		]);
		expect(discovered.missingTaskIds).toEqual([
			{
				key: expect.any(String),
				filePath: "Areas/Work/No id.md",
				line: 2,
				proposedTaskId: expect.stringMatching(/^migration_/u),
			},
		]);
		expect(
			discovered.inventory.tasks.find((task) => task.filePath === "Areas/Work/No id.md"),
		).toMatchObject({
			requiresAnchor: true,
			descriptionHash: expect.stringMatching(/^[0-9a-f]{8}$/u),
		});
	});

	it("proposes collision-safe deterministic IDs without writing or excluding id-less tasks", () => {
		const task = makeTask({
			taskId: null,
			filePath: "Areas/Work/Inbox.md",
			container: "inbox",
		});
		const first = discoverLegacyNamespaceInventory({
			namespaces: [{ name: "Work", root: "Areas/Work" }],
			today: "2026-07-28",
			tasks: [task],
		});
		const second = discoverLegacyNamespaceInventory({
			namespaces: [{ name: "Work", root: "Areas/Work" }],
			today: "2026-07-28",
			tasks: [task],
		});
		expect(second).toEqual(first);
		expect(first.inventory.inboxes[0]?.activeTaskIds).toEqual([
			first.missingTaskIds[0]?.proposedTaskId,
		]);
	});

	it("moves the highest active task block without stranding children of inactive or non-task parents", () => {
		const path = "Areas/Work/Inbox.md";
		const discovered = discoverLegacyNamespaceInventory({
			namespaces: [{ name: "Work", root: "Areas/Work" }],
			today: "2026-07-28",
			tasks: [
				makeTask({
					taskId: "active-parent",
					filePath: path,
					container: "inbox",
					lineStart: 1,
					lineEnd: 3,
					rawLine: "- [ ] Active parent 🆔 active-parent",
				}),
				makeTask({
					taskId: "active-child-covered",
					filePath: path,
					container: "inbox",
					lineStart: 2,
					lineEnd: 2,
					parentLine: 1,
					rawLine: "  - [ ] Covered child 🆔 active-child-covered",
				}),
				makeTask({
					taskId: "done-parent",
					filePath: path,
					container: "inbox",
					lineStart: 4,
					lineEnd: 6,
					statusChar: "x",
					rawLine: "- [x] Done parent 🆔 done-parent",
				}),
				makeTask({
					taskId: "active-child-under-done",
					filePath: path,
					container: "inbox",
					lineStart: 5,
					lineEnd: 5,
					parentLine: 4,
					rawLine: "  - [ ] Active child 🆔 active-child-under-done",
				}),
				makeTask({
					taskId: "active-child-under-nontask",
					filePath: path,
					container: "inbox",
					lineStart: 8,
					lineEnd: 8,
					parentLine: 7,
					rawLine: "  - [ ] Nested under bullet 🆔 active-child-under-nontask",
				}),
			],
		});

		expect(discovered.inventory.inboxes[0]?.activeTaskIds).toEqual([
			"active-parent",
			"active-child-under-done",
			"active-child-under-nontask",
		]);
	});

	it("handles a large flat inbox without quadratic ancestor searches", () => {
		const path = "Areas/Work/Large Inbox.md";
		const tasks = Array.from({ length: 2_000 }, (_, index) =>
			makeTask({
				taskId: `task-${index}`,
				filePath: path,
				container: "inbox",
				lineStart: index,
				lineEnd: index,
				rawLine: `- [ ] Task ${index} 🆔 task-${index}`,
			}),
		);
		const discovered = discoverLegacyNamespaceInventory({
			namespaces: [{ name: "Work", root: "Areas/Work" }],
			today: "2026-07-28",
			tasks,
		});

		expect(discovered.inventory.inboxes[0]?.activeTaskIds).toHaveLength(tasks.length);
	});

	it("preserves source-line order instead of sorting moves by opaque task ID", () => {
		const path = "Areas/Work/Inbox.md";
		const discovered = discoverLegacyNamespaceInventory({
			namespaces: [{ name: "Work", root: "Areas/Work" }],
			today: "2026-07-28",
			tasks: [
				makeTask({
					taskId: "z-first",
					filePath: path,
					container: "inbox",
					lineStart: 1,
					lineEnd: 1,
					rawLine: "- [ ] First 🆔 z-first",
				}),
				makeTask({
					taskId: "a-second",
					filePath: path,
					container: "inbox",
					lineStart: 2,
					lineEnd: 2,
					rawLine: "- [ ] Second 🆔 a-second",
				}),
			],
		});

		expect(discovered.inventory.inboxes[0]?.activeTaskIds).toEqual(["z-first", "a-second"]);
	});

	it("uses the deepest matching root and falls back to Common", () => {
		const defs = [
			{ name: "Work", root: "Work" },
			{ name: "Deep", root: "Work/Deep" },
		];
		expect(legacyNamespaceForPath("Work/Deep/t.md", defs, null)).toBe("Deep");
		expect(legacyNamespaceForPath("Workspace/t.md", defs, null)).toBe(LEGACY_DEFAULT_NAMESPACE);
	});
});
