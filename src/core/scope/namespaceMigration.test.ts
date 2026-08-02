import { describe, expect, it } from "vitest";
import { createScopeCatalog } from "./scope";
import {
	LEGACY_DEFAULT_NAMESPACE,
	createNamespaceMigrationJournal,
	finishNamespaceMigration,
	legacyInboxCandidates,
	markMigrationPathCompleted,
	pendingMigrationPaths,
	planNamespaceMigration,
} from "./namespaceMigration";

const catalog = createScopeCatalog([
	{ id: "work", name: "Work", order: 0, archived: false },
	{ id: "life", name: "Life", order: 1, archived: false },
	{ id: "old", name: "Old", order: 2, archived: true },
]);

const inventory = {
	namespaces: [{ name: "Работа", root: "Work" }],
	inboxes: [
		{ namespace: "Работа", path: "Work/Входящие.md", activeTaskIds: ["work-inbox"] },
		{ namespace: LEGACY_DEFAULT_NAMESPACE, path: "GTD/Входящие.md", activeTaskIds: ["common"] },
	],
	tasks: [
		{
			taskId: "work-project",
			filePath: "Work/Проекты/A.md",
			line: 4,
			namespace: "Работа",
			inLegacyInbox: false,
			scopeId: null,
			sourceLineHash: "00000001",
		},
		{
			taskId: "work-inbox",
			filePath: "Work/Входящие.md",
			line: 2,
			namespace: "Работа",
			inLegacyInbox: true,
			scopeId: null,
			sourceLineHash: "00000002",
		},
		{
			taskId: "common",
			filePath: "GTD/Входящие.md",
			line: 1,
			namespace: LEGACY_DEFAULT_NAMESPACE,
			inLegacyInbox: true,
			scopeId: null,
			sourceLineHash: "00000003",
		},
		{
			taskId: "manual",
			filePath: "Work/Входящие.md",
			line: 8,
			namespace: "Работа",
			inLegacyInbox: true,
			scopeId: "life",
			sourceLineHash: "00000004",
		},
	],
} as const;

describe("namespace migration planning", () => {
	it("requires every unresolved product choice as explicit policy", () => {
		const result = planNamespaceMigration(
			inventory,
			{ byNamespace: { Работа: "work" } },
			{
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			catalog,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.annotations.map((item) => item.taskId)).toEqual(["work-inbox"]);
		expect(result.preview.skipped).toEqual([
			{
				taskId: "common",
				filePath: "GTD/Входящие.md",
				reason: "common-left-unscoped",
			},
			{
				taskId: "manual",
				filePath: "Work/Входящие.md",
				reason: "already-scoped",
			},
			{
				taskId: "work-project",
				filePath: "Work/Проекты/A.md",
				reason: "outside-coverage",
			},
		]);
		expect(result.preview.inboxMoves.map((item) => item.taskId)).toEqual([
			"common",
			"work-inbox",
		]);
	});

	// §«Общее»: имя встроенного пространства — обычная строка, поэтому
	// пользовательское пространство с тем же именем молча уезжало в политику
	// commonTasks вместо своего сопоставления. Явный отказ вместо тихой потери.
	it("refuses a user namespace that collides with the built-in Common one", () => {
		const collided = {
			...inventory,
			namespaces: [
				{ name: "Работа", root: "Work" },
				{ name: LEGACY_DEFAULT_NAMESPACE, root: "Shared" },
			],
		};
		const result = planNamespaceMigration(
			collided,
			{ byNamespace: { Работа: "work", [LEGACY_DEFAULT_NAMESPACE]: "life" } },
			{
				taskCoverage: "all-tasks",
				commonTasks: { kind: "assign", scopeId: "life" },
				targetInboxPath: "GTD/Inbox.md",
			},
			catalog,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toEqual([expect.stringContaining("built-in Common namespace")]);
	});

	it("supports all-task coverage and an explicit Common mapping", () => {
		const result = planNamespaceMigration(
			inventory,
			{ byNamespace: { Работа: "work" } },
			{
				taskCoverage: "all-tasks",
				commonTasks: { kind: "assign", scopeId: "life" },
				targetInboxPath: "GTD/Inbox.md",
			},
			catalog,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.preview.annotations.map(({ taskId, scopeId }) => ({ taskId, scopeId })),
		).toEqual([
			{ taskId: "common", scopeId: "life" },
			{ taskId: "work-inbox", scopeId: "work" },
			{ taskId: "work-project", scopeId: "work" },
		]);
	});

	it("journals proposed IDs only for id-less tasks selected by the approved plan", () => {
		const withIdlessTasks = {
			...inventory,
			inboxes: [
				{
					namespace: "Работа",
					path: "Work/Входящие.md",
					activeTaskIds: ["proposed-inbox"],
				},
			],
			tasks: [
				{
					taskId: "proposed-inbox",
					filePath: "Work/Входящие.md",
					line: 2,
					namespace: "Работа",
					inLegacyInbox: true,
					scopeId: null,
					requiresAnchor: true,
					descriptionHash: "1234abcd",
					sourceLineHash: "1111abcd",
				},
				{
					taskId: "proposed-project",
					filePath: "Work/Проекты/A.md",
					line: 4,
					namespace: "Работа",
					inLegacyInbox: false,
					scopeId: null,
					requiresAnchor: true,
					descriptionHash: "5678abcd",
					sourceLineHash: "2222abcd",
				},
			],
		} as const;
		const result = planNamespaceMigration(
			withIdlessTasks,
			{ byNamespace: { Работа: "work" } },
			{
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			catalog,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.anchors).toEqual([
			{
				taskId: "proposed-inbox",
				filePath: "Work/Входящие.md",
				line: 2,
				descriptionHash: "1234abcd",
			},
		]);
		expect(result.preview.skipped).toContainEqual({
			taskId: "proposed-project",
			filePath: "Work/Проекты/A.md",
			reason: "outside-coverage",
		});
		expect(result.preview.affectedFiles).not.toContain("Work/Проекты/A.md");
	});

	it("rejects missing, unknown, and archived mappings", () => {
		const missing = planNamespaceMigration(
			inventory,
			{ byNamespace: {} },
			{
				taskCoverage: "all-tasks",
				commonTasks: { kind: "assign", scopeId: "old" },
				targetInboxPath: "",
			},
			catalog,
		);
		expect(missing).toEqual({
			ok: false,
			errors: [
				"A unified inbox path is required.",
				"Legacy namespace 'Работа' has no scope mapping.",
				"Scope 'old' for Common tasks is not active.",
			],
		});
	});
});

describe("namespace migration journal", () => {
	it("requires all pre-migration snapshots and resumes deterministically", () => {
		const planned = planNamespaceMigration(
			inventory,
			{ byNamespace: { Работа: "work" } },
			{
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			catalog,
		);
		if (!planned.ok) throw new Error("fixture failed");
		const before = planned.preview.affectedFiles.map((path) => ({
			path,
			content: path === "GTD/Inbox.md" ? null : `before:${path}`,
		}));
		let journal = createNamespaceMigrationJournal({
			id: "migration-1",
			now: "2026-07-28T00:00:00.000Z",
			preview: planned.preview,
			before,
		});
		expect(pendingMigrationPaths(journal)).toEqual(planned.preview.affectedFiles);
		for (const path of planned.preview.affectedFiles) {
			journal = markMigrationPathCompleted(journal, path, "2026-07-28T00:01:00.000Z");
		}
		expect(pendingMigrationPaths(journal)).toEqual([]);
		journal = finishNamespaceMigration(journal, "2026-07-28T00:02:00.000Z");
		expect(journal.state).toBe("applied");
		expect(journal.settingsUpdated).toBe(true);
	});

	it("fails before mutation when a rollback snapshot is missing", () => {
		const planned = planNamespaceMigration(
			inventory,
			{ byNamespace: { Работа: "work" } },
			{
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			catalog,
		);
		if (!planned.ok) throw new Error("fixture failed");
		expect(() =>
			createNamespaceMigrationJournal({
				id: "migration-1",
				now: "2026-07-28T00:00:00.000Z",
				preview: planned.preview,
				before: [],
			}),
		).toThrow("migration-snapshot-missing");
	});
});

// Общий для плагина и виджет-бандла порядок кандидатов на единый файл входящих.
// Плагин выбирает первый СУЩЕСТВУЮЩИЙ, виджет — первый из списка; разъехавшийся
// порядок означает, что захват с телефона попадёт мимо входящих плагина.
describe("legacyInboxCandidates", () => {
	it("конвенционный файл захвата приоритетнее цели копий регулярных", () => {
		expect(
			legacyInboxCandidates({
				commonRoot: "GTD",
				namespaces: [{ name: "Работа", root: "Work" }],
				recurring: { spawnTarget: "GTD/Inbox.md" },
			}),
		).toEqual(["GTD/Входящие.md", "GTD/Inbox.md"]);
	});

	it("без commonRoot остаётся только явно настроенный spawnTarget", () => {
		expect(legacyInboxCandidates({ recurring: { spawnTarget: "My/Inbox.md" } })).toEqual([
			"My/Inbox.md",
		]);
	});

	it("хвостовые слэши схлопываются, дубли не повторяются", () => {
		expect(
			legacyInboxCandidates({
				commonRoot: "GTD//",
				recurring: { spawnTarget: "GTD/Входящие.md" },
			}),
		).toEqual(["GTD/Входящие.md", "GTD/Inbox.md"]);
	});

	it("корневой commonRoot — голые имена файлов; мусор даёт пустой список", () => {
		expect(legacyInboxCandidates({ commonRoot: "/" })).toEqual(["Входящие.md", "Inbox.md"]);
		expect(legacyInboxCandidates({ commonRoot: "  ", recurring: 5 })).toEqual([]);
		expect(legacyInboxCandidates(null)).toEqual([]);
	});
});
