import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { VaultAdapter } from "../adapters/VaultAdapter";
import type { Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { setScopeId } from "../core/parser/serializeTaskLine";
import {
	planNamespaceMigration,
	type CommonTaskPolicy,
	type NamespaceMigrationPolicy,
	type NamespaceMigrationSettingsSnapshot,
	type NamespaceTaskCoverage,
} from "../core/scope/namespaceMigration";
import { createScopeCatalog } from "../core/scope/scope";
import { createMemoryDataAdapter } from "../testing/memoryDataAdapter";
import { discoverLegacyNamespaceInventory } from "./LegacyNamespaceDiscovery";
import {
	cloneSettingsSnapshot,
	locateNamespaceMarkdownTasks,
	NamespaceMigrationService,
	NAMESPACE_MIGRATIONS_FOLDER,
	namespaceMigrationSettingsEqual,
	type NamespaceMigrationSettingsPort,
} from "./NamespaceMigrationService";

const TARGET_INBOX = "GTD/Unified Inbox.md";
const LEGACY_INBOXES = ["Areas/Work/Inbox.md", "GTD/Legacy Inbox.md"] as const;
const LEGACY_NAMESPACES = [{ name: "Work", root: "Areas/Work" }] as const;
const PRESERVED_MARKERS = [
	"# Captured work",
	"supporting context: keep **formatting**",
	"# Work project",
	"# Household project",
	"# Unrelated notes",
] as const;

const INITIAL_FILES: Readonly<Record<string, string>> = {
	"Areas/Work/Inbox.md": [
		"---",
		"gtd-inbox: true",
		"---",
		"# Captured work",
		"- [ ] Prepare launch brief 📅 2026-08-05 🆔 work-inbox",
		"  supporting context: keep **formatting**",
		"- [x] Archived inbox item ✅ 2026-07-20 🆔 work-done",
		"",
	].join("\n"),
	"Areas/Work/Projects/Launch.md": [
		"---",
		"gtd-project: true",
		"---",
		"# Work project",
		"- [ ] Draft rollout plan #launch 🆔 work-project",
		"- [ ] Keep explicit scope 🆔 scoped-project 🧭 life",
		"",
	].join("\n"),
	"GTD/Legacy Inbox.md": [
		"---",
		"gtd-inbox: true",
		"---",
		"- [ ] Buy groceries #errands 🆔 common-inbox",
		"  household context stays attached",
		"",
	].join("\n"),
	"GTD/Household.md": ["# Household project", "- [ ] Renew lease 🆔 common-project", ""].join(
		"\n",
	),
	"Archive/Notes.md": "# Unrelated notes\nThis file must remain byte-identical.\n",
};

const INITIAL_SETTINGS: NamespaceMigrationSettingsSnapshot = {
	inboxFile: "GTD/Legacy Inbox.md",
	legacy: {
		commonRoot: "GTD",
		namespaces: [{ name: "Work", root: "Areas/Work", color: "#d97706" }],
		activeNamespace: "Work",
	},
};

const CATALOG = createScopeCatalog([
	{ id: "work", name: "Work", order: 0, archived: false },
	{ id: "life", name: "Life", order: 1, archived: false },
]);

interface MatrixCase {
	name: string;
	taskCoverage: NamespaceTaskCoverage;
	commonTasks: CommonTaskPolicy;
}

/**
 * D1 and D2 remain required inputs. The release evidence deliberately exercises
 * their full cross-product instead of blessing either branch as a default.
 */
const MIGRATION_MATRIX: readonly MatrixCase[] = [
	{
		name: "inbox-only + leave Common unscoped",
		taskCoverage: "inbox-only",
		commonTasks: { kind: "leave-unscoped" },
	},
	{
		name: "inbox-only + assign Common",
		taskCoverage: "inbox-only",
		commonTasks: { kind: "assign", scopeId: "life" },
	},
	{
		name: "all tasks + leave Common unscoped",
		taskCoverage: "all-tasks",
		commonTasks: { kind: "leave-unscoped" },
	},
	{
		name: "all tasks + assign Common",
		taskCoverage: "all-tasks",
		commonTasks: { kind: "assign", scopeId: "life" },
	},
];

describe("namespace migration release matrix", () => {
	it.each(MIGRATION_MATRIX)(
		"$name: dry-run, apply/resume, and rollback preserve the vault contract",
		async ({ name, taskCoverage, commonTasks }) => {
			const fixture = createFixture(name);
			const beforeFiles = fixture.vault.userFiles();
			const beforeSettings = fixture.settings.snapshot();
			const beforeTasks = taskEvidence(beforeFiles);
			const discovered = discoverLegacyNamespaceInventory({
				namespaces: LEGACY_NAMESPACES,
				tasks: parseVaultTasks(beforeFiles),
				today: "2026-07-28",
				inboxPaths: LEGACY_INBOXES,
			});
			expect(discovered.missingTaskIds).toEqual([]);

			const policy: NamespaceMigrationPolicy = {
				taskCoverage,
				commonTasks,
				targetInboxPath: TARGET_INBOX,
			};
			const planned = planNamespaceMigration(
				discovered.inventory,
				{ byNamespace: { Work: "work" } },
				policy,
				CATALOG,
			);
			expect(planned.ok).toBe(true);
			if (!planned.ok)
				throw new Error(`invalid matrix fixture: ${planned.errors.join(", ")}`);

			// Inventory discovery and the planner are the user-visible dry-run.
			expect(planned.preview.policy).toEqual(policy);
			expect(fixture.vault.userFiles()).toEqual(beforeFiles);
			expect(fixture.vault.mutations).toEqual([]);

			const prepared = await fixture.service.prepare(
				await fixture.service.bindPreview(planned.preview),
			);
			expect(fixture.vault.userFiles()).toEqual(beforeFiles);
			expect(fixture.vault.userMutations()).toEqual([]);

			// Simulate Obsidian durably replacing the new inbox but losing the
			// acknowledgement before the journal can mark that path completed.
			fixture.vault.throwAfterProcessOnceFor = TARGET_INBOX;
			const interrupted = await fixture.service.apply(prepared.id);
			expect(interrupted).toMatchObject({
				ok: false,
				error: `vault-process-ack-lost:${TARGET_INBOX}`,
			});
			expect(fixture.settings.snapshot()).toEqual(beforeSettings);

			const restarted = fixture.restart();
			const resumed = await restarted.apply(prepared.id);
			expect(resumed).toMatchObject({ ok: true, journal: { state: "applied" } });
			expect(fixture.settings.snapshot()).toEqual({
				inboxFile: TARGET_INBOX,
				legacy: {},
			});

			const appliedFiles = fixture.vault.userFiles();
			expect(taskEvidence(appliedFiles)).toEqual(beforeTasks);
			expect(new Set(taskEvidence(appliedFiles).map((item) => item.id)).size).toBe(
				beforeTasks.length,
			);
			expect(taskLocations(appliedFiles)).toMatchObject({
				"common-inbox": TARGET_INBOX,
				"work-inbox": TARGET_INBOX,
				"work-done": "Areas/Work/Inbox.md",
				"work-project": "Areas/Work/Projects/Launch.md",
				"common-project": "GTD/Household.md",
			});
			expect(taskScopes(appliedFiles)).toMatchObject({
				"work-inbox": "work",
				"work-done": "work",
				"work-project": taskCoverage === "all-tasks" ? "work" : null,
				"common-inbox": commonTasks.kind === "assign" ? commonTasks.scopeId : null,
				"common-project":
					taskCoverage === "all-tasks" && commonTasks.kind === "assign"
						? commonTasks.scopeId
						: null,
				"scoped-project": "life",
			});
			expect(appliedFiles["Archive/Notes.md"]).toBe(INITIAL_FILES["Archive/Notes.md"]);
			for (const marker of PRESERVED_MARKERS) {
				expect(markerCount(appliedFiles, marker)).toBe(markerCount(beforeFiles, marker));
			}

			// A second resume of an already-applied journal is a strict no-op for
			// user files, even though the first attempt died after a durable write.
			const mutationsAfterResume = fixture.vault.userMutations();
			expect(await fixture.restart().apply(prepared.id)).toMatchObject({ ok: true });
			expect(fixture.vault.userMutations()).toEqual(mutationsAfterResume);
			expect(fixture.vault.userFiles()).toEqual(appliedFiles);

			expect(await fixture.restart().rollback(prepared.id)).toMatchObject({
				ok: true,
				journal: { state: "rolled-back" },
			});
			expect(fixture.vault.userFiles()).toEqual(beforeFiles);
			expect(fixture.settings.snapshot()).toEqual(beforeSettings);

			const mutationsAfterRollback = fixture.vault.userMutations();
			expect(await fixture.restart().rollback(prepared.id)).toMatchObject({ ok: true });
			expect(fixture.vault.userMutations()).toEqual(mutationsAfterRollback);
		},
	);

	it("keeps an edit interleaved after the conditional-remove tombstone", async () => {
		const fixture = createFixture("conditional remove interleave");
		const prepared = await prepareInboxOnlyFixture(fixture);
		expect((await fixture.service.apply(prepared.id)).ok).toBe(true);
		fixture.vault.interleaveAfterProcessOnceFor = {
			path: TARGET_INBOX,
			content: "external edit after tombstone\n",
		};

		const result = await fixture.service.rollback(prepared.id);

		expect(result).toMatchObject({
			ok: false,
			error: `migration-file-changed:${TARGET_INBOX}`,
		});
		expect(fixture.vault.data.get(TARGET_INBOX)).toBe("external edit after tombstone\n");
	});

	it.each([0, 1])(
		"recovers a conditional removal interrupted before authoritative read %i",
		async (readsBeforeThrow) => {
			const fixture = createFixture(`conditional remove crash ${readsBeforeThrow}`);
			const beforeFiles = fixture.vault.userFiles();
			const prepared = await prepareInboxOnlyFixture(fixture);
			expect((await fixture.service.apply(prepared.id)).ok).toBe(true);
			fixture.vault.throwOnReadAfterProcessOnceFor = {
				path: TARGET_INBOX,
				readsBeforeThrow,
			};

			const interrupted = await fixture.service.rollback(prepared.id);

			expect(interrupted).toMatchObject({
				ok: false,
				error: `vault-read-interrupted:${TARGET_INBOX}`,
			});
			const physicalTombstone = fixture.vault.data.get(TARGET_INBOX);
			expect(physicalTombstone).toContain("Prepare launch brief");
			expect(physicalTombstone).toContain("gtd-flow conditional delete");

			expect(await fixture.restart().rollback(prepared.id)).toMatchObject({ ok: true });
			expect(fixture.vault.userFiles()).toEqual(beforeFiles);
		},
	);

	it("normalizes a rollback tombstone when the user switches back to apply", async () => {
		const fixture = createFixture("rollback tombstone then apply");
		const prepared = await prepareInboxOnlyFixture(fixture);
		expect((await fixture.service.apply(prepared.id)).ok).toBe(true);
		const exactAppliedInbox = fixture.vault.data.get(TARGET_INBOX);
		fixture.vault.throwOnReadAfterProcessOnceFor = {
			path: TARGET_INBOX,
			readsBeforeThrow: 0,
		};
		expect(await fixture.service.rollback(prepared.id)).toMatchObject({ ok: false });
		expect(fixture.vault.data.get(TARGET_INBOX)).toContain("gtd-flow conditional delete");

		expect(await fixture.restart().apply(prepared.id)).toMatchObject({ ok: true });
		expect(fixture.vault.data.get(TARGET_INBOX)).toBe(exactAppliedInbox);
		expect(fixture.vault.data.get(TARGET_INBOX)).not.toContain("gtd-flow conditional delete");
	});

	it.each(["body with newline\n", "body without newline"])(
		"decodes and resumes a crash tombstone for %j",
		async (expected) => {
			const vault = new ObsidianMemoryVault({ "Note.md": expected });
			const adapter = new VaultAdapter({ vault } as unknown as App);
			vault.throwOnReadAfterProcessOnceFor = {
				path: "Note.md",
				readsBeforeThrow: 0,
			};

			await expect(adapter.compareAndSet("Note.md", expected, null)).rejects.toThrow(
				"vault-read-interrupted:Note.md",
			);
			expect(vault.data.get("Note.md")).toContain("gtd-flow conditional delete");
			expect(await adapter.read("Note.md")).toBe(expected);

			expect(await adapter.compareAndSet("Note.md", expected, null)).toBe(true);
			expect(vault.data.has("Note.md")).toBe(false);
		},
	);
});

interface MemoryFile {
	path: string;
	extension: string;
}

interface VaultMutation {
	kind: "create" | "create-folder" | "delete" | "process";
	path: string;
}

class ObsidianMemoryVault {
	readonly data = new Map<string, string>();
	readonly mutations: VaultMutation[] = [];
	throwAfterProcessOnceFor: string | null = null;
	interleaveAfterProcessOnceFor: { path: string; content: string } | null = null;
	throwOnReadAfterProcessOnceFor: { path: string; readsBeforeThrow: number } | null = null;
	private pendingReadFailure: { path: string; readsBeforeThrow: number } | null = null;
	private readonly folders = new Set<string>();
	/** Скрытые пути живут ТОЛЬКО здесь — как в настоящем Obsidian. */
	readonly adapter = createMemoryDataAdapter(this.data, this.folders);

	constructor(files: Readonly<Record<string, string>>) {
		for (const [path, content] of Object.entries(files)) {
			this.data.set(path, content);
			this.addParentFolders(path);
		}
	}

	getFileByPath(path: string): MemoryFile | null {
		return !isHiddenPath(path) && this.data.has(path) ? file(path) : null;
	}

	getAbstractFileByPath(path: string): MemoryFile | { path: string } | null {
		if (isHiddenPath(path)) return null;
		return this.getFileByPath(path) ?? (this.folders.has(path) ? { path } : null);
	}

	getFiles(): MemoryFile[] {
		return [...this.data.keys()]
			.filter((path) => !isHiddenPath(path))
			.sort()
			.map(file);
	}

	async cachedRead(target: MemoryFile): Promise<string> {
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		return content;
	}

	async read(target: MemoryFile): Promise<string> {
		if (this.pendingReadFailure?.path === target.path) {
			if (this.pendingReadFailure.readsBeforeThrow === 0) {
				this.pendingReadFailure = null;
				throw new Error(`vault-read-interrupted:${target.path}`);
			}
			this.pendingReadFailure.readsBeforeThrow -= 1;
		}
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		return content;
	}

	async process(target: MemoryFile, transform: (content: string) => string): Promise<void> {
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		const next = transform(content);
		this.data.set(target.path, next);
		if (next !== content) this.mutations.push({ kind: "process", path: target.path });
		if (this.throwOnReadAfterProcessOnceFor?.path === target.path) {
			this.pendingReadFailure = { ...this.throwOnReadAfterProcessOnceFor };
			this.throwOnReadAfterProcessOnceFor = null;
		}
		if (this.interleaveAfterProcessOnceFor?.path === target.path) {
			this.data.set(target.path, this.interleaveAfterProcessOnceFor.content);
			this.interleaveAfterProcessOnceFor = null;
		}
		if (this.throwAfterProcessOnceFor === target.path) {
			this.throwAfterProcessOnceFor = null;
			throw new Error(`vault-process-ack-lost:${target.path}`);
		}
	}

	async createFolder(path: string): Promise<void> {
		this.addFolder(path);
		this.mutations.push({ kind: "create-folder", path });
	}

	async create(path: string, content: string): Promise<MemoryFile> {
		if (this.data.has(path)) throw new Error(`vault-file-exists:${path}`);
		this.addParentFolders(path);
		this.data.set(path, content);
		this.mutations.push({ kind: "create", path });
		if (this.throwAfterProcessOnceFor === path) {
			this.throwAfterProcessOnceFor = null;
			throw new Error(`vault-process-ack-lost:${path}`);
		}
		return file(path);
	}

	async delete(target: MemoryFile, _permanent: boolean): Promise<void> {
		this.data.delete(target.path);
		this.mutations.push({ kind: "delete", path: target.path });
	}

	userFiles(): Record<string, string> {
		return Object.fromEntries(
			[...this.data]
				.filter(([path]) => !path.startsWith(".gtd-flow/"))
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}

	userMutations(): VaultMutation[] {
		return this.mutations.filter(
			(mutation) =>
				mutation.path !== NAMESPACE_MIGRATIONS_FOLDER &&
				!mutation.path.startsWith(`${NAMESPACE_MIGRATIONS_FOLDER}/`),
		);
	}

	private addParentFolders(path: string): void {
		const parts = path.split("/");
		parts.pop();
		for (let length = 1; length <= parts.length; length++) {
			this.folders.add(parts.slice(0, length).join("/"));
		}
	}

	private addFolder(path: string): void {
		const parts = path.split("/");
		for (let length = 1; length <= parts.length; length++) {
			this.folders.add(parts.slice(0, length).join("/"));
		}
	}
}

function isHiddenPath(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("."));
}

class MemoryMigrationSettings implements NamespaceMigrationSettingsPort {
	private value: NamespaceMigrationSettingsSnapshot;

	constructor(initial: NamespaceMigrationSettingsSnapshot) {
		this.value = cloneSettingsSnapshot(initial);
	}

	snapshot(): NamespaceMigrationSettingsSnapshot {
		return cloneSettingsSnapshot(this.value);
	}

	async compareAndSet(
		expected: NamespaceMigrationSettingsSnapshot,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<boolean> {
		if (!namespaceMigrationSettingsEqual(this.value, expected)) return false;
		this.value = cloneSettingsSnapshot(next);
		return true;
	}
}

function createFixture(caseName: string): {
	vault: ObsidianMemoryVault;
	settings: MemoryMigrationSettings;
	service: NamespaceMigrationService;
	restart(): NamespaceMigrationService;
} {
	const vault = new ObsidianMemoryVault(INITIAL_FILES);
	const adapter = new VaultAdapter({ vault } as unknown as App);
	const settings = new MemoryMigrationSettings(INITIAL_SETTINGS);
	const safeCaseName = caseName.replace(/[^a-z]+/giu, "-").replace(/^-|-$/gu, "");
	const restart = () =>
		new NamespaceMigrationService(
			adapter,
			settings,
			{ now: () => "2026-07-28T10:00:00.000Z" },
			{ next: () => `migration-${safeCaseName}` },
			{
				isActive: (scopeId) =>
					CATALOG.scopes.some((scope) => scope.id === scopeId && !scope.archived),
			},
		);
	return { vault, settings, service: restart(), restart };
}

async function prepareInboxOnlyFixture(
	fixture: ReturnType<typeof createFixture>,
): Promise<{ id: string }> {
	const discovered = discoverLegacyNamespaceInventory({
		namespaces: LEGACY_NAMESPACES,
		tasks: parseVaultTasks(fixture.vault.userFiles()),
		today: "2026-07-28",
		inboxPaths: LEGACY_INBOXES,
	});
	const planned = planNamespaceMigration(
		discovered.inventory,
		{ byNamespace: { Work: "work" } },
		{
			taskCoverage: "inbox-only",
			commonTasks: { kind: "leave-unscoped" },
			targetInboxPath: TARGET_INBOX,
		},
		CATALOG,
	);
	if (!planned.ok) throw new Error(planned.errors.join(", "));
	return fixture.service.prepare(await fixture.service.bindPreview(planned.preview));
}

function file(path: string): MemoryFile {
	return { path, extension: path.split(".").pop() ?? "" };
}

function parseVaultTasks(files: Readonly<Record<string, string>>): Task[] {
	const tasks: Task[] = [];
	for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (!path.endsWith(".md")) continue;
		const container = LEGACY_INBOXES.includes(path as (typeof LEGACY_INBOXES)[number])
			? "inbox"
			: path.includes("/Projects/")
				? "project"
				: "plain";
		for (const location of locateNamespaceMarkdownTasks(path, content)) {
			const lineStart = location.line;
			const rawLine = location.rawLine;
			const task = parseTaskLine(rawLine, {
				filePath: path,
				lineStart,
				parentLine: null,
				heading: null,
				container,
				projectActive: true,
			});
			if (task !== null) tasks.push({ ...task, lineEnd: location.lineEnd });
		}
	}
	return tasks;
}

function taskEvidence(files: Readonly<Record<string, string>>): Array<{
	id: string;
	contentWithoutScope: string;
}> {
	return parseVaultTasks(files)
		.map((task) => {
			if (task.taskId === null) throw new Error(`matrix-task-id-missing:${task.key}`);
			return {
				id: task.taskId,
				contentWithoutScope: setScopeId(task.rawLine, null),
			};
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

function taskLocations(files: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(
		parseVaultTasks(files).map((task) => {
			if (task.taskId === null) throw new Error(`matrix-task-id-missing:${task.key}`);
			return [task.taskId, task.filePath];
		}),
	);
}

function taskScopes(files: Readonly<Record<string, string>>): Record<string, string | null> {
	return Object.fromEntries(
		parseVaultTasks(files).map((task) => {
			if (task.taskId === null) throw new Error(`matrix-task-id-missing:${task.key}`);
			return [task.taskId, task.scopeId];
		}),
	);
}

function markerCount(files: Readonly<Record<string, string>>, marker: string): number {
	return Object.values(files).reduce(
		(total, content) => total + content.split(marker).length - 1,
		0,
	);
}
