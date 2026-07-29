import { describe, expect, it } from "vitest";
import type {
	NamespaceMigrationJournal,
	NamespaceMigrationPreview,
	NamespaceMigrationSettingsSnapshot,
} from "../core/scope/namespaceMigration";
import { fnv1a } from "../core/parser/taskKey";
import {
	cloneSettingsSnapshot,
	journalPath,
	namespaceMigrationSettingsEqual,
	NamespaceMigrationService,
	NAMESPACE_MIGRATIONS_FOLDER,
	type NamespaceMigrationSettingsPort,
	type NamespaceMigrationStorage,
} from "./NamespaceMigrationService";

class MemoryFiles implements NamespaceMigrationStorage {
	readonly data = new Map<string, string>();
	readonly reads: string[] = [];
	readonly mutations: Array<{ kind: "write" | "remove"; path: string }> = [];
	throwOnceFor: string | null = null;
	interleaveOnceFor: { path: string; content: string | null } | null = null;

	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return this.data.get(path) ?? null;
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		if (this.throwOnceFor === path) {
			this.throwOnceFor = null;
			throw new Error(`write-failed:${path}`);
		}
		this.data.set(path, content);
		this.mutations.push({ kind: "write", path });
	}

	async compareAndSet(
		path: string,
		expected: string | null,
		next: string | null,
	): Promise<boolean> {
		if (this.interleaveOnceFor?.path === path) {
			const content = this.interleaveOnceFor.content;
			this.interleaveOnceFor = null;
			if (content === null) this.data.delete(path);
			else this.data.set(path, content);
		}
		if ((this.data.get(path) ?? null) !== expected) return false;
		if (next === expected) return true;
		if (this.throwOnceFor === path) {
			this.throwOnceFor = null;
			throw new Error(`write-failed:${path}`);
		}
		if (next === null) {
			this.data.delete(path);
			this.mutations.push({ kind: "remove", path });
		} else {
			this.data.set(path, next);
			this.mutations.push({ kind: "write", path });
		}
		return true;
	}

	async remove(path: string): Promise<void> {
		this.data.delete(path);
		this.mutations.push({ kind: "remove", path });
	}
}

class MemorySettings implements NamespaceMigrationSettingsPort {
	value: NamespaceMigrationSettingsSnapshot = {
		inboxFile: "GTD/Old Inbox.md",
		legacy: {
			commonRoot: "GTD",
			namespaces: [{ name: "Work", root: "Work", color: "#d97706" }],
			activeNamespace: "Work",
		},
	};
	readonly writes: NamespaceMigrationSettingsSnapshot[] = [];
	throwAfterCommitOnce = false;

	snapshot(): NamespaceMigrationSettingsSnapshot {
		return cloneSettingsSnapshot(this.value);
	}

	async compareAndSet(
		expected: NamespaceMigrationSettingsSnapshot,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<boolean> {
		if (!namespaceMigrationSettingsEqual(this.value, expected)) return false;
		// This in-memory fixture's value is its durable value, so an equality CAS
		// is already a completed persistence barrier.
		if (namespaceMigrationSettingsEqual(expected, next)) return true;
		this.value = cloneSettingsSnapshot(next);
		this.writes.push(cloneSettingsSnapshot(next));
		if (this.throwAfterCommitOnce) {
			this.throwAfterCommitOnce = false;
			throw new Error("settings-commit-ack-lost");
		}
		return true;
	}
}

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class BlockingMemorySettings extends MemorySettings {
	durable = this.snapshot();
	readonly started = deferred();
	readonly release = deferred();

	override async compareAndSet(
		expected: NamespaceMigrationSettingsSnapshot,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<boolean> {
		if (!namespaceMigrationSettingsEqual(this.value, expected)) return false;
		this.value = cloneSettingsSnapshot(next);
		this.writes.push(cloneSettingsSnapshot(next));
		this.started.resolve();
		await this.release.promise;
		this.durable = cloneSettingsSnapshot(next);
		return true;
	}
}

class SpeculativeMemorySettings extends MemorySettings {
	durable = this.snapshot();
	private attempts = 0;

	override async compareAndSet(
		expected: NamespaceMigrationSettingsSnapshot,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<boolean> {
		if (!namespaceMigrationSettingsEqual(this.value, expected)) return false;
		this.attempts++;
		this.value = cloneSettingsSnapshot(next);
		this.writes.push(cloneSettingsSnapshot(next));
		if (this.attempts === 1) throw new Error("settings-write-failed-before-durable");
		this.durable = cloneSettingsSnapshot(next);
		return true;
	}
}

function taskLineBinding(line: number, rawLine: string, requiresAnchor = false, lineEnd?: number) {
	return {
		line,
		...(lineEnd === undefined ? {} : { lineEnd }),
		sourceLineHash: fnv1a(rawLine).toString(16).padStart(8, "0"),
		requiresAnchor,
	};
}

const preview: NamespaceMigrationPreview = {
	schemaVersion: 1,
	policy: {
		taskCoverage: "inbox-only",
		commonTasks: { kind: "leave-unscoped" },
		targetInboxPath: "GTD/Inbox.md",
	},
	namespaceMappings: [{ namespace: "Work", scopeId: "work" }],
	taskInventory: [
		{ path: "GTD/Inbox.md", tasks: [] },
		{
			path: "GTD/Old Inbox.md",
			tasks: [taskLineBinding(0, "- [ ] Common task 🆔 common")],
		},
		{
			path: "Work/Inbox.md",
			tasks: [
				taskLineBinding(0, "- [ ] Work task 🆔 work-inbox"),
				taskLineBinding(1, "  - [ ] Child task 🆔 child"),
				taskLineBinding(3, "- [ ] Keep me 🆔 keep"),
			],
		},
	],
	sources: [
		{
			taskId: "work-inbox",
			filePath: "Work/Inbox.md",
			line: 0,
			sourceLineHash: fnv1a("- [ ] Work task 🆔 work-inbox").toString(16).padStart(8, "0"),
		},
		{
			taskId: "common",
			filePath: "GTD/Old Inbox.md",
			line: 0,
			sourceLineHash: fnv1a("- [ ] Common task 🆔 common").toString(16).padStart(8, "0"),
		},
	],
	annotations: [
		{
			taskId: "work-inbox",
			filePath: "Work/Inbox.md",
			line: 0,
			fromNamespace: "Work",
			scopeId: "work",
		},
	],
	inboxMoves: [
		{
			taskId: "work-inbox",
			fromPath: "Work/Inbox.md",
			toPath: "GTD/Inbox.md",
			fromNamespace: "Work",
		},
		{
			taskId: "common",
			fromPath: "GTD/Old Inbox.md",
			toPath: "GTD/Inbox.md",
			fromNamespace: "Общее",
		},
	],
	skipped: [],
	affectedFiles: ["GTD/Inbox.md", "GTD/Old Inbox.md", "Work/Inbox.md"],
};

const clock = { now: () => "2026-07-28T10:00:00.000Z" };
const ids = { next: () => "migration-1" };

function createService(
	files: MemoryFiles,
	settings: NamespaceMigrationSettingsPort,
): NamespaceMigrationService {
	return new NamespaceMigrationService(files, settings, clock, ids, {
		isActive: (scopeId) => scopeId === "work" || scopeId === "life",
	});
}

async function prepareMigration(
	service: NamespaceMigrationService,
	value: NamespaceMigrationPreview = preview,
): Promise<NamespaceMigrationJournal> {
	return service.prepare(await service.bindPreview(value));
}

function setup() {
	const files = new MemoryFiles();
	files.data.set(
		"Work/Inbox.md",
		[
			"- [ ] Work task 🆔 work-inbox",
			"  - [ ] Child task 🆔 child",
			"  context line",
			"- [ ] Keep me 🆔 keep",
			"",
		].join("\n"),
	);
	files.data.set("GTD/Old Inbox.md", "- [ ] Common task 🆔 common\n");
	const settings = new MemorySettings();
	return { files, settings, service: createService(files, settings) };
}

function readJournal(files: MemoryFiles, id = "migration-1"): NamespaceMigrationJournal {
	return JSON.parse(files.data.get(journalPath(id))!) as NamespaceMigrationJournal;
}

function replaceJournal(
	files: MemoryFiles,
	change: (journal: NamespaceMigrationJournal) => void,
	id = "migration-1",
): void {
	const journal = readJournal(files, id);
	change(journal);
	files.data.set(journalPath(id), `${JSON.stringify(journal, null, 2)}\n`);
}

function taskMutations(files: MemoryFiles): Array<{ kind: "write" | "remove"; path: string }> {
	return files.mutations.filter(
		(mutation) => !mutation.path.startsWith(`${NAMESPACE_MIGRATIONS_FOLDER}/`),
	);
}

describe("NamespaceMigrationService", () => {
	it("journals all legacy settings, resumes, and restores files/settings exactly after restart", async () => {
		const { files, settings, service } = setup();
		const beforeWork = files.data.get("Work/Inbox.md");
		const beforeCommon = files.data.get("GTD/Old Inbox.md");
		const beforeSettings = settings.snapshot();
		const prepared = await prepareMigration(service);
		expect(readJournal(files, prepared.id)).toMatchObject({
			state: "prepared",
			beforeInboxFile: "GTD/Old Inbox.md",
			beforeSettings,
		});

		// The final source write fails after earlier source/target files are durable.
		files.throwOnceFor = "Work/Inbox.md";
		const interrupted = await service.apply(prepared.id);
		expect(interrupted).toMatchObject({ ok: false, error: "write-failed:Work/Inbox.md" });
		expect(settings.writes).toEqual([]); // settings wait for every task-file write

		const resumed = await service.apply(prepared.id);
		expect(resumed.ok).toBe(true);
		expect(settings.writes).toEqual([
			{
				inboxFile: "GTD/Inbox.md",
				legacy: {},
			},
		]);
		expect(files.data.get("Work/Inbox.md")).toBe("- [ ] Keep me 🆔 keep\n");
		expect(files.data.get("GTD/Old Inbox.md")).toBe("");
		expect(files.data.get("GTD/Inbox.md")).toBe(
			[
				"- [ ] Work task 🆔 work-inbox 🧭 work",
				"  - [ ] Child task 🆔 child",
				"  context line",
				"- [ ] Common task 🆔 common",
				"",
			].join("\n"),
		);

		const restarted = createService(files, settings);
		const rolledBack = await restarted.rollback(prepared.id);
		expect(rolledBack.ok).toBe(true);
		expect(settings.value).toEqual(beforeSettings);
		expect(files.data.get("Work/Inbox.md")).toBe(beforeWork);
		expect(files.data.get("GTD/Old Inbox.md")).toBe(beforeCommon);
		expect(files.data.has("GTD/Inbox.md")).toBe(false); // target was absent before
	});

	it("inserts selected IDs only after journaling and rollback removes them exactly", async () => {
		const files = new MemoryFiles();
		const settings = new MemorySettings();
		const sourceBefore = "- [ ] Needs anchor\n";
		files.data.set("Work/Inbox.md", sourceBefore);
		const taskId = "migration_anchor";
		const anchoredPreview: NamespaceMigrationPreview = {
			schemaVersion: 1,
			policy: {
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			namespaceMappings: [{ namespace: "Work", scopeId: "work" }],
			taskInventory: [
				{ path: "GTD/Inbox.md", tasks: [] },
				{
					path: "Work/Inbox.md",
					tasks: [taskLineBinding(0, "- [ ] Needs anchor", true)],
				},
			],
			sources: [
				{
					taskId,
					filePath: "Work/Inbox.md",
					line: 0,
					sourceLineHash: fnv1a("- [ ] Needs anchor").toString(16).padStart(8, "0"),
				},
			],
			anchors: [
				{
					taskId,
					filePath: "Work/Inbox.md",
					line: 0,
					descriptionHash: fnv1a("Needs anchor").toString(16).padStart(8, "0"),
				},
			],
			annotations: [
				{
					taskId,
					filePath: "Work/Inbox.md",
					line: 0,
					fromNamespace: "Work",
					scopeId: "work",
				},
			],
			inboxMoves: [
				{
					taskId,
					fromPath: "Work/Inbox.md",
					toPath: "GTD/Inbox.md",
					fromNamespace: "Work",
				},
			],
			skipped: [],
			affectedFiles: ["GTD/Inbox.md", "Work/Inbox.md"],
		};
		const service = createService(files, settings);

		const prepared = await prepareMigration(service, anchoredPreview);
		expect(files.data.get("Work/Inbox.md")).toBe(sourceBefore);
		expect(files.data.has("GTD/Inbox.md")).toBe(false);

		expect((await service.apply(prepared.id)).ok).toBe(true);
		expect(files.data.get("Work/Inbox.md")).toBe("");
		expect(files.data.get("GTD/Inbox.md")).toBe(
			"- [ ] Needs anchor 🆔 migration_anchor 🧭 work\n",
		);

		expect((await service.rollback(prepared.id)).ok).toBe(true);
		expect(files.data.get("Work/Inbox.md")).toBe(sourceBefore);
		expect(files.data.has("GTD/Inbox.md")).toBe(false);
	});

	it("moves a nested loose-list block once and promotes its indentation safely", async () => {
		const files = new MemoryFiles();
		const settings = new MemorySettings();
		const sourceBefore = [
			"- [x] Completed parent 🆔 parent",
			"  - [ ] Nested active 🆔 nested",
			"",
			"    supporting context",
			"  - [ ] Keep sibling 🆔 sibling",
			"",
		].join("\n");
		files.data.set("GTD/Old Inbox.md", sourceBefore);
		const nestedPreview: NamespaceMigrationPreview = {
			schemaVersion: 1,
			policy: {
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			namespaceMappings: [],
			taskInventory: [
				{ path: "GTD/Inbox.md", tasks: [] },
				{
					path: "GTD/Old Inbox.md",
					tasks: [
						taskLineBinding(0, "- [x] Completed parent 🆔 parent"),
						taskLineBinding(1, "  - [ ] Nested active 🆔 nested"),
						taskLineBinding(4, "  - [ ] Keep sibling 🆔 sibling"),
					],
				},
			],
			sources: [
				{
					taskId: "nested",
					filePath: "GTD/Old Inbox.md",
					line: 1,
					sourceLineHash: fnv1a("  - [ ] Nested active 🆔 nested")
						.toString(16)
						.padStart(8, "0"),
				},
			],
			anchors: [],
			annotations: [],
			inboxMoves: [
				{
					taskId: "nested",
					fromPath: "GTD/Old Inbox.md",
					toPath: "GTD/Inbox.md",
					fromNamespace: "Общее",
				},
			],
			skipped: [],
			affectedFiles: ["GTD/Inbox.md", "GTD/Old Inbox.md"],
		};
		const service = createService(files, settings);

		const prepared = await prepareMigration(service, nestedPreview);
		expect((await service.apply(prepared.id)).ok).toBe(true);
		expect(files.data.get("GTD/Old Inbox.md")).toBe(
			["- [x] Completed parent 🆔 parent", "  - [ ] Keep sibling 🆔 sibling", ""].join("\n"),
		);
		expect(files.data.get("GTD/Inbox.md")).toBe(
			["- [ ] Nested active 🆔 nested", "", "  supporting context", ""].join("\n"),
		);

		expect((await service.rollback(prepared.id)).ok).toBe(true);
		expect(files.data.get("GTD/Old Inbox.md")).toBe(sourceBefore);
		expect(files.data.has("GTD/Inbox.md")).toBe(false);
	});

	it("uses one Markdown-aware task view for inventory, IDs, and complete block ranges", async () => {
		const files = new MemoryFiles();
		const settings = new MemorySettings();
		const sourceBefore = [
			"---",
			"example: |",
			"  ---",
			"  - [ ] YAML example 🆔 active",
			"---",
			"<!--",
			"- [ ] Comment example 🆔 active",
			"-->",
			"- examples",
			"    ```md",
			"    - [ ] Fenced example 🆔 active",
			"    ```",
			"- ```md",
			"  - [ ] Same-line fenced example 🆔 active",
			"  ```",
			"- <!--",
			"  - [ ] Same-line comment example 🆔 active",
			"  -->",
			"# Code sample",
			"    - [ ] Indented example 🆔 active",
			"- [ ] Active 🆔 active",
			"continuation text",
			" - [x] Keep sibling 🆔 keep",
			"",
		].join("\n");
		files.data.set("GTD/Old Inbox.md", sourceBefore);
		const markdownPreview: NamespaceMigrationPreview = {
			schemaVersion: 1,
			policy: {
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			namespaceMappings: [],
			taskInventory: [
				{ path: "GTD/Inbox.md", tasks: [] },
				{
					path: "GTD/Old Inbox.md",
					tasks: [
						taskLineBinding(20, "- [ ] Active 🆔 active", false, 21),
						taskLineBinding(22, " - [x] Keep sibling 🆔 keep", false, 22),
					],
				},
			],
			sources: [
				{
					taskId: "active",
					filePath: "GTD/Old Inbox.md",
					line: 20,
					sourceLineHash: fnv1a("- [ ] Active 🆔 active").toString(16).padStart(8, "0"),
				},
			],
			anchors: [],
			annotations: [],
			inboxMoves: [
				{
					taskId: "active",
					fromPath: "GTD/Old Inbox.md",
					toPath: "GTD/Inbox.md",
					fromNamespace: "Общее",
				},
			],
			skipped: [],
			affectedFiles: ["GTD/Inbox.md", "GTD/Old Inbox.md"],
		};
		const service = createService(files, settings);

		const prepared = await prepareMigration(service, markdownPreview);
		expect((await service.apply(prepared.id)).ok).toBe(true);
		expect(files.data.get("GTD/Inbox.md")).toBe(
			["- [ ] Active 🆔 active", "continuation text", ""].join("\n"),
		);
		expect(files.data.get("GTD/Old Inbox.md")).toContain(" - [x] Keep sibling 🆔 keep");
		expect(files.data.get("GTD/Old Inbox.md")).not.toContain(
			"\n- [ ] Active 🆔 active\ncontinuation text",
		);
		expect((await service.rollback(prepared.id)).ok).toBe(true);
		expect(files.data.get("GTD/Old Inbox.md")).toBe(sourceBefore);
	});

	it("rejects a task edit made after dry-run before saving a migration journal", async () => {
		const files = new MemoryFiles();
		const settings = new MemorySettings();
		files.data.set("Work/Inbox.md", "- [ ] Needs scope 🆔 work-inbox\n");
		const stalePreview: NamespaceMigrationPreview = {
			...preview,
			taskInventory: [
				{
					path: "Work/Inbox.md",
					tasks: [taskLineBinding(0, "- [ ] Needs scope 🆔 work-inbox")],
				},
			],
			sources: [
				{
					taskId: "work-inbox",
					filePath: "Work/Inbox.md",
					line: 0,
					sourceLineHash: fnv1a("- [ ] Needs scope 🆔 work-inbox")
						.toString(16)
						.padStart(8, "0"),
				},
			],
			annotations: [
				{
					taskId: "work-inbox",
					filePath: "Work/Inbox.md",
					line: 0,
					fromNamespace: "Work",
					scopeId: "work",
				},
			],
			inboxMoves: [],
			affectedFiles: ["Work/Inbox.md"],
		};
		const service = createService(files, settings);
		const bound = await service.bindPreview(stalePreview);
		files.data.set("Work/Inbox.md", "- [ ] Needs scope 🆔 work-inbox 🧭 life\n");

		await expect(service.prepare(bound)).rejects.toThrow(
			"migration-file-source-changed:Work/Inbox.md",
		);
		expect(files.data.has(journalPath("migration-1"))).toBe(false);
		expect(files.data.get("Work/Inbox.md")).toBe("- [ ] Needs scope 🆔 work-inbox 🧭 life\n");
	});

	it("rejects a task missing from a stale index before displaying the bound dry-run", async () => {
		const { files, service } = setup();
		files.data.set(
			"Work/Inbox.md",
			[
				"- [ ] Work task 🆔 work-inbox",
				"  - [ ] Child task 🆔 child",
				"  - [ ] Newly synced child 🆔 new-child",
				"  context line",
				"- [ ] Keep me 🆔 keep",
				"",
			].join("\n"),
		);

		await expect(service.bindPreview(preview)).rejects.toThrow(
			"migration-task-inventory-changed:Work/Inbox.md",
		);
		expect(files.data.has(journalPath("migration-1"))).toBe(false);
	});

	it("rejects inbox-setting drift between displayed dry-run and prepare", async () => {
		const { files, settings, service } = setup();
		const bound = await service.bindPreview(preview);
		settings.value.inboxFile = "GTD/Changed.md";

		await expect(service.prepare(bound)).rejects.toThrow("migration-settings-changed");
		expect(files.data.has(journalPath("migration-1"))).toBe(false);
	});

	it("rejects a selected scope archived during the confirmation window", async () => {
		const { files, settings } = setup();
		let scopesActive = true;
		const service = new NamespaceMigrationService(files, settings, clock, ids, {
			isActive: () => scopesActive,
		});
		const bound = await service.bindPreview(preview);
		scopesActive = false;

		await expect(service.prepare(bound)).rejects.toThrow("migration-scope-changed:work");
		expect(files.data.has(journalPath("migration-1"))).toBe(false);
	});

	it("rejects a journal that could exceed the durable loader cap before any write", async () => {
		const { files, service } = setup();
		files.data.set(
			"Work/Inbox.md",
			`${files.data.get("Work/Inbox.md")!}${"x".repeat(17 * 1024 * 1024)}`,
		);
		const bound = await service.bindPreview(preview);

		await expect(service.prepare(bound)).rejects.toThrow("migration-journal-too-large");
		expect(files.data.has(journalPath("migration-1"))).toBe(false);
	}, 15_000);

	it("rejects a proposed anchor that would duplicate an ID in the target inbox", async () => {
		const files = new MemoryFiles();
		const settings = new MemorySettings();
		files.data.set("Work/Inbox.md", "- [ ] Needs anchor\n");
		files.data.set("GTD/Inbox.md", "- [ ] Existing 🆔 migration_anchor\n");
		const collisionPreview: NamespaceMigrationPreview = {
			schemaVersion: 1,
			policy: {
				taskCoverage: "inbox-only",
				commonTasks: { kind: "leave-unscoped" },
				targetInboxPath: "GTD/Inbox.md",
			},
			namespaceMappings: [{ namespace: "Work", scopeId: "work" }],
			taskInventory: [
				{
					path: "GTD/Inbox.md",
					tasks: [taskLineBinding(0, "- [ ] Existing 🆔 migration_anchor")],
				},
				{
					path: "Work/Inbox.md",
					tasks: [taskLineBinding(0, "- [ ] Needs anchor", true)],
				},
			],
			sources: [
				{
					taskId: "migration_anchor",
					filePath: "Work/Inbox.md",
					line: 0,
					sourceLineHash: fnv1a("- [ ] Needs anchor").toString(16).padStart(8, "0"),
				},
			],
			anchors: [
				{
					taskId: "migration_anchor",
					filePath: "Work/Inbox.md",
					line: 0,
					descriptionHash: fnv1a("Needs anchor").toString(16).padStart(8, "0"),
				},
			],
			annotations: [
				{
					taskId: "migration_anchor",
					filePath: "Work/Inbox.md",
					line: 0,
					fromNamespace: "Work",
					scopeId: "work",
				},
			],
			inboxMoves: [
				{
					taskId: "migration_anchor",
					fromPath: "Work/Inbox.md",
					toPath: "GTD/Inbox.md",
					fromNamespace: "Work",
				},
			],
			skipped: [],
			affectedFiles: ["GTD/Inbox.md", "Work/Inbox.md"],
		};
		const service = createService(files, settings);
		const bound = await service.bindPreview(collisionPreview);

		await expect(service.prepare(bound)).rejects.toThrow(
			"migration-task-id-duplicate:migration_anchor",
		);
		expect(files.data.has(journalPath("migration-1"))).toBe(false);
	});

	it("fails closed rather than overwrite an external file edit after prepare", async () => {
		const { files, settings, service } = setup();
		const prepared = await prepareMigration(service);
		files.data.set("Work/Inbox.md", "user edited this after preview\n");
		const result = await service.apply(prepared.id);
		expect(result).toMatchObject({ ok: false, error: "migration-file-changed:Work/Inbox.md" });
		expect(files.data.get("Work/Inbox.md")).toBe("user edited this after preview\n");
		expect(settings.writes).toEqual([]);
	});

	it("preserves a target created after the apply read but before its compare-and-set", async () => {
		const { files, settings, service } = setup();
		const prepared = await prepareMigration(service);
		files.interleaveOnceFor = {
			path: "GTD/Inbox.md",
			content: "externally created during migration\n",
		};

		const result = await service.apply(prepared.id);

		expect(result).toMatchObject({
			ok: false,
			error: "migration-file-changed:GTD/Inbox.md",
		});
		expect(files.data.get("GTD/Inbox.md")).toBe("externally created during migration\n");
		expect(settings.writes).toEqual([]);
	});

	it("preserves an edit made after the rollback read but before conditional removal", async () => {
		const { files, service } = setup();
		const prepared = await prepareMigration(service);
		expect((await service.apply(prepared.id)).ok).toBe(true);
		files.interleaveOnceFor = {
			path: "GTD/Inbox.md",
			content: "external edit before rollback removal\n",
		};

		const result = await service.rollback(prepared.id);

		expect(result).toMatchObject({
			ok: false,
			error: "migration-file-changed:GTD/Inbox.md",
		});
		expect(files.data.get("GTD/Inbox.md")).toBe("external edit before rollback removal\n");
	});

	it("rejects overlapping parent and child moves in a legacy sources-less journal", async () => {
		const { files, settings, service } = setup();
		const prepared = await prepareMigration(service);
		replaceJournal(files, (journal) => {
			delete journal.preview.sources;
			delete journal.preview.fileBindings;
			journal.preview.inboxMoves.push({
				taskId: "child",
				fromPath: "Work/Inbox.md",
				toPath: "GTD/Inbox.md",
				fromNamespace: "Work",
			});
		});
		files.mutations.length = 0;

		await expect(service.apply(prepared.id)).rejects.toThrow("migration-journal-invalid");
		expect(taskMutations(files)).toEqual([]);
		expect(settings.writes).toEqual([]);
	});

	it("detects a settings conflict before mutating any task file", async () => {
		const { files, settings, service } = setup();
		const prepared = await prepareMigration(service);
		settings.value = {
			...settings.snapshot(),
			legacy: { ...settings.value.legacy, activeNamespace: "Life" },
		};
		files.mutations.length = 0;

		const result = await service.apply(prepared.id);

		expect(result).toMatchObject({ ok: false, error: "migration-settings-changed" });
		expect(taskMutations(files)).toEqual([]);
		expect(settings.writes).toEqual([]);
	});

	it("serializes concurrent apply/resume calls for the same journal", async () => {
		const { files } = setup();
		const settings = new BlockingMemorySettings();
		const service = createService(files, settings);
		const prepared = await prepareMigration(service);
		const first = service.apply(prepared.id);
		await settings.started.promise;

		const readsBeforeResume = files.reads.length;
		const resumed = service.apply(prepared.id);
		const resumeWaitedForFirst = files.reads.length === readsBeforeResume;
		settings.release.resolve();

		expect(resumeWaitedForFirst).toBe(true);
		await expect(first).resolves.toMatchObject({ ok: true });
		await expect(resumed).resolves.toMatchObject({ ok: true });
		expect(settings.writes).toHaveLength(1);
		expect(settings.durable).toEqual({ inboxFile: "GTD/Inbox.md", legacy: {} });
	});

	it("serializes rollback behind an in-flight apply for the same journal", async () => {
		const { files } = setup();
		const beforeWork = files.data.get("Work/Inbox.md");
		const beforeCommon = files.data.get("GTD/Old Inbox.md");
		const settings = new BlockingMemorySettings();
		const beforeSettings = settings.snapshot();
		const service = createService(files, settings);
		const prepared = await prepareMigration(service);
		const applying = service.apply(prepared.id);
		await settings.started.promise;

		const readsBeforeRollback = files.reads.length;
		const rollback = service.rollback(prepared.id);
		const rollbackWaitedForApply = files.reads.length === readsBeforeRollback;
		settings.release.resolve();

		expect(rollbackWaitedForApply).toBe(true);
		await expect(applying).resolves.toMatchObject({ ok: true });
		await expect(rollback).resolves.toMatchObject({ ok: true });
		expect(settings.value).toEqual(beforeSettings);
		expect(settings.durable).toEqual(beforeSettings);
		expect(files.data.get("Work/Inbox.md")).toBe(beforeWork);
		expect(files.data.get("GTD/Old Inbox.md")).toBe(beforeCommon);
		expect(files.data.has("GTD/Inbox.md")).toBe(false);
	});

	it("requires a durable CAS even when the live settings already equal the target", async () => {
		const { files } = setup();
		const settings = new SpeculativeMemorySettings();
		const beforeDurable = settings.durable;
		const service = createService(files, settings);
		const prepared = await prepareMigration(service);

		const interrupted = await service.apply(prepared.id);
		expect(interrupted).toMatchObject({
			ok: false,
			error: "settings-write-failed-before-durable",
		});
		expect(settings.value).toEqual({ inboxFile: "GTD/Inbox.md", legacy: {} });
		expect(settings.durable).toEqual(beforeDurable);

		const resumed = await service.apply(prepared.id);
		expect(resumed).toMatchObject({ ok: true, journal: { state: "applied" } });
		expect(settings.writes).toHaveLength(2);
		expect(settings.durable).toEqual({ inboxFile: "GTD/Inbox.md", legacy: {} });
	});

	it("resumes idempotently when the settings commit succeeds but its acknowledgement is lost", async () => {
		const { files, settings, service } = setup();
		const prepared = await prepareMigration(service);
		settings.throwAfterCommitOnce = true;

		const interrupted = await service.apply(prepared.id);
		expect(interrupted).toMatchObject({ ok: false, error: "settings-commit-ack-lost" });
		expect(settings.value).toEqual({ inboxFile: "GTD/Inbox.md", legacy: {} });
		expect(settings.writes).toHaveLength(1);
		const taskWriteCount = taskMutations(files).length;

		const resumed = await createService(files, settings).apply(prepared.id);
		expect(resumed.ok).toBe(true);
		expect(settings.writes).toHaveLength(1);
		expect(taskMutations(files)).toHaveLength(taskWriteCount);
	});

	it("resumes rollback idempotently after a lost settings acknowledgement", async () => {
		const { files, settings, service } = setup();
		const beforeSettings = settings.snapshot();
		const prepared = await prepareMigration(service);
		expect((await service.apply(prepared.id)).ok).toBe(true);
		settings.throwAfterCommitOnce = true;

		const interrupted = await service.rollback(prepared.id);
		expect(interrupted).toMatchObject({ ok: false, error: "settings-commit-ack-lost" });
		expect(settings.value).toEqual(beforeSettings);
		expect(settings.writes).toHaveLength(2);

		const resumed = await createService(files, settings).rollback(prepared.id);
		expect(resumed.ok).toBe(true);
		expect(settings.value).toEqual(beforeSettings);
		expect(settings.writes).toHaveLength(2);
	});

	it("upgrades an old prepared journal while legacy fields are still available", async () => {
		const { files, settings, service } = setup();
		const beforeSettings = settings.snapshot();
		const prepared = await prepareMigration(service);
		replaceJournal(files, (journal) => {
			delete journal.beforeSettings;
		});

		expect((await service.apply(prepared.id)).ok).toBe(true);
		expect(readJournal(files).beforeSettings).toEqual(beforeSettings);
		expect(settings.value).toEqual({ inboxFile: "GTD/Inbox.md", legacy: {} });

		expect((await createService(files, settings).rollback(prepared.id)).ok).toBe(true);
		expect(settings.value).toEqual(beforeSettings);
	});

	it("fails closed when an old applied journal can no longer reconstruct cleared legacy fields", async () => {
		const { files, settings, service } = setup();
		const prepared = await prepareMigration(service);
		expect((await service.apply(prepared.id)).ok).toBe(true);
		replaceJournal(files, (journal) => {
			delete journal.beforeSettings;
		});
		files.mutations.length = 0;

		const result = await createService(files, settings).rollback(prepared.id);

		expect(result).toMatchObject({
			ok: false,
			error: "migration-legacy-settings-snapshot-missing",
		});
		expect(taskMutations(files)).toEqual([]);
		expect(settings.value).toEqual({ inboxFile: "GTD/Inbox.md", legacy: {} });
	});

	it("rejects a traversal migration ID before reading storage", async () => {
		const { files, service } = setup();
		await expect(service.load("../migration-1")).rejects.toThrow("invalid-migration-id");
		expect(files.reads).toEqual([]);
	});

	const tamperCases: Array<{
		name: string;
		change: (journal: NamespaceMigrationJournal) => void;
	}> = [
		{
			name: "reserved internal path",
			change: (journal) => {
				journal.preview.annotations[0]!.filePath = ".gtd-flow/forged.md";
			},
		},
		{
			name: "path traversal",
			change: (journal) => {
				journal.preview.inboxMoves[0]!.fromPath = "../outside.md";
			},
		},
		{
			name: "snapshot not matching affectedPaths",
			change: (journal) => {
				journal.before[0]!.path = "GTD/Other.md";
			},
		},
		{
			name: "annotation outside affectedPaths",
			change: (journal) => {
				journal.preview.annotations[0]!.filePath = "Work/Other.md";
			},
		},
		{
			name: "move whose target differs from the policy",
			change: (journal) => {
				journal.preview.inboxMoves[0]!.toPath = "GTD/Other.md";
			},
		},
		{
			name: "non-prefix completed paths",
			change: (journal) => {
				journal.state = "applying";
				journal.completedPaths = [journal.preview.affectedFiles[1]!];
			},
		},
		{
			name: "settings snapshot inconsistent with beforeInboxFile",
			change: (journal) => {
				journal.beforeSettings!.inboxFile = "GTD/Other.md";
			},
		},
		{
			name: "unknown legacy settings key",
			change: (journal) => {
				(journal.beforeSettings!.legacy as Record<string, unknown>)["forged"] = true;
			},
		},
		{
			name: "terminal state with incomplete settings",
			change: (journal) => {
				journal.state = "applied";
			},
		},
		{
			name: "annotation line inconsistent with immutable snapshot",
			change: (journal) => {
				journal.preview.annotations[0]!.line = 99;
			},
		},
	];

	for (const tamper of tamperCases) {
		it(`rejects a tampered journal with ${tamper.name} before any write`, async () => {
			const { files, settings, service } = setup();
			const beforeWork = files.data.get("Work/Inbox.md");
			const beforeCommon = files.data.get("GTD/Old Inbox.md");
			const prepared = await prepareMigration(service);
			replaceJournal(files, tamper.change);
			files.mutations.length = 0;

			await expect(service.apply(prepared.id)).rejects.toThrow("migration-journal-invalid");

			expect(files.mutations).toEqual([]);
			expect(settings.writes).toEqual([]);
			expect(files.data.get("Work/Inbox.md")).toBe(beforeWork);
			expect(files.data.get("GTD/Old Inbox.md")).toBe(beforeCommon);
			expect(files.data.has("GTD/Inbox.md")).toBe(false);
		});
	}
});
