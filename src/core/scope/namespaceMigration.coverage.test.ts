import { describe, expect, it } from "vitest";
import { createScopeCatalog } from "./scope";
import {
	createNamespaceMigrationJournal,
	finishNamespaceMigration,
	markMigrationPathCompleted,
	planNamespaceMigration,
	readLegacyNamespaceSettings,
} from "./namespaceMigration";

const catalog = createScopeCatalog([{ id: "work", name: "Work", order: 0, archived: false }]);

describe("legacy namespace migration guard rails", () => {
	it("reads only valid legacy settings fields", () => {
		expect(
			readLegacyNamespaceSettings({
				commonRoot: "  GTD  ",
				activeNamespace: " Work ",
				namespaces: [
					{ name: " Work ", root: " Projects " },
					{ name: "", root: "missing" },
					"not-an-object",
				],
			}),
		).toEqual({
			commonRoot: "GTD",
			activeNamespace: "Work",
			namespaces: [{ name: "Work", root: "Projects" }],
		});
		expect(readLegacyNamespaceSettings(null)).toEqual({
			commonRoot: null,
			activeNamespace: null,
			namespaces: [],
		});
	});

	it("fails closed for every ambiguous migration input and journal transition", () => {
		const result = planNamespaceMigration(
			{
				namespaces: [
					{ name: "Work", root: "Work" },
					{ name: "Work", root: "Duplicate" },
				],
				inboxes: [{ namespace: "Work", path: "Work/Inbox.md", activeTaskIds: ["missing"] }],
				tasks: [
					{
						taskId: "",
						filePath: "Work/a.md",
						line: -1,
						namespace: "Unknown",
						inLegacyInbox: false,
						scopeId: null,
					},
					{
						taskId: "",
						filePath: "Work/b.md",
						line: 0,
						namespace: "Work",
						inLegacyInbox: false,
						scopeId: null,
					},
				],
			},
			{ byNamespace: { Work: "missing", Extra: "work" } },
			{
				taskCoverage: "all-tasks",
				commonTasks: { kind: "assign", scopeId: "missing" },
				targetInboxPath: " / ",
			},
			catalog,
		);
		expect(result).toEqual({
			ok: false,
			errors: expect.arrayContaining([
				"A unified inbox path is required.",
				"Legacy namespace 'Work' is duplicated.",
				"Scope 'missing' for namespace 'Work' is not active.",
				"Mapping references unknown namespace 'Extra'.",
				"Scope 'missing' for Common tasks is not active.",
				"A legacy task is missing a stable task ID.",
				"Task ID '' is duplicated.",
				"Task '' belongs to unknown namespace 'Unknown'.",
				"Task '' has an invalid line number.",
				"Inbox 'Work/Inbox.md' references unknown task 'missing'.",
			]),
		});

		const preview = {
			schemaVersion: 1 as const,
			policy: {
				taskCoverage: "all-tasks" as const,
				commonTasks: { kind: "leave-unscoped" as const },
				targetInboxPath: "GTD/Inbox.md",
			},
			namespaceMappings: [],
			annotations: [],
			inboxMoves: [],
			skipped: [],
			affectedFiles: ["GTD/Inbox.md"],
		};
		expect(() =>
			createNamespaceMigrationJournal({ id: " ", now: "now", preview, before: [] }),
		).toThrow("migration-id-required");
		const journal = createNamespaceMigrationJournal({
			id: "migration",
			now: "now",
			preview,
			before: [{ path: "GTD/Inbox.md", content: null }],
		});
		expect(() => finishNamespaceMigration(journal, "later")).toThrow("migration-files-pending");
		expect(() => markMigrationPathCompleted(journal, "Other.md", "later")).toThrow(
			"migration-path-not-planned:Other.md",
		);
		expect(
			finishNamespaceMigration(
				markMigrationPathCompleted(journal, "/GTD//Inbox.md", "later"),
				"done",
			),
		).toMatchObject({
			state: "applied",
			settingsUpdated: true,
		});
	});
});
