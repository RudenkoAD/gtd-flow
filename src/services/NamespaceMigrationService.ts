/**
 * Durable executor for the one-time legacy namespace migration.
 *
 * The pure planner deliberately lives in core/scope. This service is the I/O
 * boundary: it snapshots every affected file before any mutation, writes a
 * journal after each completed file, and derives every retry from that frozen
 * snapshot. Therefore a process crash may repeat a complete-file write, but
 * cannot duplicate a moved task block or apply a scope annotation twice.
 */
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { setScopeId, setValueField } from "../core/parser/serializeTaskLine";
import { fnv1a } from "../core/parser/taskKey";
import { isScopeId } from "../core/scope/scope";
import {
	createNamespaceMigrationJournal,
	finishNamespaceMigration,
	LEGACY_DEFAULT_NAMESPACE,
	markMigrationPathCompleted,
	type LegacyNamespaceCompatibilityFields,
	type NamespaceMigrationFileSnapshot,
	type NamespaceMigrationJournal,
	type NamespaceMigrationPreview,
	type NamespaceMigrationSettingsSnapshot,
} from "../core/scope/namespaceMigration";

export const NAMESPACE_MIGRATIONS_FOLDER = ".gtd-flow/ai/migrations";

export interface NamespaceMigrationStorage {
	read(path: string): Promise<string | null>;
	writeAtomic(path: string, content: string): Promise<void>;
	/**
	 * Atomically replace `expected` with `next`. `null` denotes an absent file,
	 * so the same primitive covers create-if-absent and remove-if-unchanged.
	 */
	compareAndSet(path: string, expected: string | null, next: string | null): Promise<boolean>;
}

export interface NamespaceMigrationSettingsPort {
	/** Exact migration-owned settings currently held by the plugin. */
	snapshot(): NamespaceMigrationSettingsSnapshot;
	/**
	 * Atomically compare the migration-owned settings and durably persist `next`.
	 * Returns false without mutation when `expected` no longer matches.
	 */
	compareAndSet(
		expected: NamespaceMigrationSettingsSnapshot,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<boolean>;
}

export interface NamespaceMigrationClock {
	now(): string;
}

export interface NamespaceMigrationIdGenerator {
	next(): string;
}

export interface NamespaceMigrationScopePort {
	isActive(scopeId: string): boolean;
}

export type NamespaceMigrationApplyResult =
	| { ok: true; journal: NamespaceMigrationJournal }
	| { ok: false; journal: NamespaceMigrationJournal; error: string };

/**
 * Applies, resumes, and rolls back a preview approved by the user. The service
 * never silently overwrites an edit made after the snapshot: each affected
 * file must still equal either its pre-image or the exact deterministic
 * post-image before a retry/rollback is allowed.
 */
export class NamespaceMigrationService {
	private readonly journalOperationTails = new Map<string, Promise<void>>();

	constructor(
		private readonly files: NamespaceMigrationStorage,
		private readonly settings: NamespaceMigrationSettingsPort,
		private readonly clock: NamespaceMigrationClock,
		private readonly ids: NamespaceMigrationIdGenerator,
		private readonly scopes: NamespaceMigrationScopePort,
	) {}

	/**
	 * Freeze the exact files shown by a dry-run. This is read-only and must run
	 * before the confirmation UI is rendered.
	 */
	async bindPreview(preview: NamespaceMigrationPreview): Promise<NamespaceMigrationPreview> {
		assertMigrationPreview(preview, "migration-preview-invalid", true, false, false, true);
		this.assertScopesActive(preview);
		const fileBindings = [];
		for (const path of preview.affectedFiles) {
			const content = await this.files.read(path);
			assertTaskInventoryMatches(preview, path, content);
			fileBindings.push({
				path,
				contentHash: content === null ? null : await contentHash(content),
			});
		}
		return {
			...structuredClone(preview),
			fileBindings,
			settingsBinding: cloneSettingsSnapshot(this.settings.snapshot()),
		};
	}

	async prepare(preview: NamespaceMigrationPreview): Promise<NamespaceMigrationJournal> {
		const id = this.ids.next().trim();
		assertMigrationId(id);
		assertMigrationPreview(preview, "migration-preview-invalid", true, true, true, true);
		this.assertScopesActive(preview);
		const path = journalPath(id);
		if ((await this.files.read(path)) !== null)
			throw new Error("migration-journal-already-exists");
		const before: NamespaceMigrationFileSnapshot[] = [];
		for (const affectedPath of preview.affectedFiles) {
			before.push({ path: affectedPath, content: await this.files.read(affectedPath) });
		}
		for (const [index, snapshot] of before.entries()) {
			const expected = preview.fileBindings![index]!;
			const actual = snapshot.content === null ? null : await contentHash(snapshot.content);
			if (expected.path !== snapshot.path || expected.contentHash !== actual) {
				throw new Error(`migration-file-source-changed:${snapshot.path}`);
			}
		}
		const beforeSettings = cloneSettingsSnapshot(this.settings.snapshot());
		if (!namespaceMigrationSettingsEqual(beforeSettings, preview.settingsBinding!)) {
			throw new Error("migration-settings-changed");
		}
		this.assertScopesActive(preview);
		const journal = createNamespaceMigrationJournal({
			id,
			now: this.clock.now(),
			preview,
			before,
			beforeInboxFile: beforeSettings.inboxFile,
			beforeSettings,
		});
		assertJournalCapacity(journal);
		// Bind the approved dry-run to the exact source lines before publishing a
		// journal. A task edited after preview must be reviewed again, not silently
		// adopted as a new before-image.
		materializeAfter(journal);
		await this.save(journal);
		return journal;
	}

	async load(id: string): Promise<NamespaceMigrationJournal> {
		assertMigrationId(id);
		const raw = await this.files.read(journalPath(id));
		if (raw === null) throw new Error("migration-journal-not-found");
		if (raw.length > MAX_JOURNAL_JSON_LENGTH) throw new Error("migration-journal-invalid");
		let decoded: unknown;
		try {
			decoded = JSON.parse(raw);
		} catch {
			throw new Error("migration-journal-invalid");
		}
		const journal = validateLoadedJournal(decoded, id);
		await assertBoundSnapshots(journal);
		assertJournalCapacity(journal);
		return journal;
	}

	async apply(id: string): Promise<NamespaceMigrationApplyResult> {
		assertMigrationId(id);
		return this.runJournalOperation(id, () => this.applyUnlocked(id));
	}

	private async applyUnlocked(id: string): Promise<NamespaceMigrationApplyResult> {
		let journal: NamespaceMigrationJournal;
		try {
			journal = await this.load(id);
		} catch (error) {
			throw error;
		}
		if (journal.state === "rolled-back" || journal.state === "rolling-back") {
			return { ok: false, journal, error: "migration-is-rolled-back" };
		}
		if (journal.state === "applied") return { ok: true, journal };

		try {
			// Materializing the complete post-image validates task IDs, recorded
			// line numbers, and snapshot/content relationships before an upgrade
			// of an old journal or any task/settings write can occur.
			const desired = materializeAfter(journal);
			journal = await this.ensureSettingsSnapshot(journal);
			const settingsPlan = migrationSettingsPlan(journal);
			this.assertSettingsCompatible(settingsPlan);
			this.assertScopesActive(journal.preview);
			for (const path of journal.preview.affectedFiles) {
				const current = await this.files.read(path);
				const before = snapshotFor(journal, path).content;
				const next = desired.get(path)!;
				if (current !== before && current !== next) {
					throw new Error(`migration-file-changed:${path}`);
				}
				this.assertSettingsCompatible(settingsPlan);
				this.assertScopesActive(journal.preview);
				// Equality still crosses the storage CAS barrier: a recoverable
				// physical delete tombstone may expose the same logical content.
				await this.writeSnapshot(path, current, next);
				if (!journal.completedPaths.includes(path)) {
					journal = markMigrationPathCompleted(journal, path, this.clock.now());
					await this.save(journal);
				}
			}
			// The unified inbox and retirement of all three compatibility fields
			// are one compare-and-set transition after every task file is durable.
			this.assertScopesActive(journal.preview);
			await this.transitionSettings(settingsPlan, settingsPlan.after);
			if (!journal.settingsUpdated) {
				journal = {
					...journal,
					settingsUpdated: true,
					updatedAt: this.clock.now(),
					error: null,
				};
				await this.save(journal);
			}
			journal = finishNamespaceMigration(journal, this.clock.now());
			await this.save(journal);
			return { ok: true, journal };
		} catch (error) {
			const message = errorMessage(error);
			journal = { ...journal, state: "failed", updatedAt: this.clock.now(), error: message };
			await this.save(journal);
			return { ok: false, journal, error: message };
		}
	}

	async rollback(id: string): Promise<NamespaceMigrationApplyResult> {
		assertMigrationId(id);
		return this.runJournalOperation(id, () => this.rollbackUnlocked(id));
	}

	private async rollbackUnlocked(id: string): Promise<NamespaceMigrationApplyResult> {
		let journal = await this.load(id);
		if (journal.state === "rolled-back") return { ok: true, journal };
		try {
			const desired = materializeAfter(journal);
			journal = await this.ensureSettingsSnapshot(journal);
			const settingsPlan = migrationSettingsPlan(journal);
			// Detect all known conflicts before the first rollback write. Each
			// individual path is checked again immediately before mutation.
			for (const snapshot of journal.before) {
				const current = await this.files.read(snapshot.path);
				const after = desired.get(snapshot.path)!;
				if (current !== snapshot.content && current !== after) {
					throw new Error(`migration-file-changed:${snapshot.path}`);
				}
			}
			this.assertSettingsCompatible(settingsPlan);
			if (journal.state !== "rolling-back") {
				journal = {
					...journal,
					state: "rolling-back",
					updatedAt: this.clock.now(),
					error: null,
				};
				await this.save(journal);
			}
			for (const snapshot of journal.before) {
				const current = await this.files.read(snapshot.path);
				const after = desired.get(snapshot.path)!;
				if (current !== snapshot.content && current !== after) {
					throw new Error(`migration-file-changed:${snapshot.path}`);
				}
				await this.writeSnapshot(snapshot.path, current, snapshot.content);
			}
			await this.transitionSettings(settingsPlan, settingsPlan.before);
			journal = {
				...journal,
				state: "rolled-back",
				updatedAt: this.clock.now(),
				settingsUpdated: false,
				error: null,
			};
			await this.save(journal);
			return { ok: true, journal };
		} catch (error) {
			const message = errorMessage(error);
			journal = { ...journal, state: "failed", updatedAt: this.clock.now(), error: message };
			await this.save(journal);
			return { ok: false, journal, error: message };
		}
	}

	private runJournalOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.journalOperationTails.get(id) ?? Promise.resolve();
		const run = previous.then(operation);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.journalOperationTails.set(id, tail);
		return run.finally(() => {
			if (this.journalOperationTails.get(id) === tail) {
				this.journalOperationTails.delete(id);
			}
		});
	}

	/**
	 * Journals produced before the full settings snapshot was introduced remain
	 * readable. A non-terminal journal is upgraded before its next mutation while
	 * the legacy fields are still available. An already-cleared old journal cannot
	 * truthfully reconstruct those raw values, so rollback fails closed.
	 */
	private async ensureSettingsSnapshot(
		journal: NamespaceMigrationJournal,
	): Promise<NamespaceMigrationJournal> {
		if (journal.beforeSettings !== undefined) {
			return { ...journal, beforeSettings: cloneSettingsSnapshot(journal.beforeSettings) };
		}
		if (journal.beforeInboxFile === null) {
			throw new Error("migration-settings-snapshot-missing");
		}
		const current = cloneSettingsSnapshot(this.settings.snapshot());
		const targetInbox = journal.preview.policy.targetInboxPath;
		if (current.inboxFile !== journal.beforeInboxFile && current.inboxFile !== targetInbox) {
			throw new Error("migration-settings-changed");
		}
		if (
			Object.keys(current.legacy).length === 0 &&
			(journal.settingsUpdated || current.inboxFile !== journal.beforeInboxFile)
		) {
			throw new Error("migration-legacy-settings-snapshot-missing");
		}
		const upgraded: NamespaceMigrationJournal = {
			...journal,
			beforeSettings: {
				inboxFile: journal.beforeInboxFile,
				legacy: cloneLegacyFields(current.legacy),
			},
			updatedAt: this.clock.now(),
		};
		await this.save(upgraded);
		return upgraded;
	}

	private assertSettingsCompatible(plan: MigrationSettingsPlan): void {
		const current = cloneSettingsSnapshot(this.settings.snapshot());
		if (
			!plan.allowed.some((candidate) => namespaceMigrationSettingsEqual(candidate, current))
		) {
			throw new Error("migration-settings-changed");
		}
	}

	private assertScopesActive(preview: NamespaceMigrationPreview): void {
		const selected = new Set(preview.namespaceMappings.map((item) => item.scopeId));
		if (preview.policy.commonTasks.kind === "assign") {
			selected.add(preview.policy.commonTasks.scopeId);
		}
		for (const scopeId of selected) {
			if (!this.scopes.isActive(scopeId))
				throw new Error(`migration-scope-changed:${scopeId}`);
		}
	}

	private async transitionSettings(
		plan: MigrationSettingsPlan,
		next: NamespaceMigrationSettingsSnapshot,
	): Promise<void> {
		const current = cloneSettingsSnapshot(this.settings.snapshot());
		if (
			!plan.allowed.some((candidate) => namespaceMigrationSettingsEqual(candidate, current))
		) {
			throw new Error("migration-settings-changed");
		}
		// Equality with the live object is not evidence that `next` is durable: a
		// concurrent settings transaction may have published it while saveData is
		// still pending. The port is always asked to establish a persistence barrier.
		if (await this.settings.compareAndSet(current, cloneSettingsSnapshot(next))) return;
		// A lost acknowledgement or another idempotent resumer may already have
		// committed the same target. Any other value is a real conflict.
		if (namespaceMigrationSettingsEqual(this.settings.snapshot(), next)) return;
		throw new Error("migration-settings-changed");
	}

	private async writeSnapshot(
		path: string,
		expected: string | null,
		content: string | null,
	): Promise<void> {
		if (!(await this.files.compareAndSet(path, expected, content))) {
			throw new Error(`migration-file-changed:${path}`);
		}
	}

	private async save(journal: NamespaceMigrationJournal): Promise<void> {
		const serialized = `${JSON.stringify(journal, null, 2)}\n`;
		if (serialized.length > MAX_JOURNAL_JSON_LENGTH) {
			throw new Error("migration-journal-too-large");
		}
		await this.files.writeAtomic(journalPath(journal.id), serialized);
	}
}

export function journalPath(id: string): string {
	assertMigrationId(id);
	return `${NAMESPACE_MIGRATIONS_FOLDER}/${id}.json`;
}

interface MigrationSettingsPlan {
	before: NamespaceMigrationSettingsSnapshot;
	after: NamespaceMigrationSettingsSnapshot;
	allowed: NamespaceMigrationSettingsSnapshot[];
}

function migrationSettingsPlan(journal: NamespaceMigrationJournal): MigrationSettingsPlan {
	if (journal.beforeSettings === undefined)
		throw new Error("migration-settings-snapshot-missing");
	const before = cloneSettingsSnapshot(journal.beforeSettings);
	const after: NamespaceMigrationSettingsSnapshot = {
		inboxFile: journal.preview.policy.targetInboxPath,
		legacy: {},
	};
	// Previous releases updated inboxFile first and retired compatibility fields
	// later, outside the journal. Accept that exact intermediate state when
	// resuming or rolling back an old operation.
	const legacyPreservedAtTarget: NamespaceMigrationSettingsSnapshot = {
		inboxFile: journal.preview.policy.targetInboxPath,
		legacy: cloneLegacyFields(before.legacy),
	};
	return {
		before,
		after,
		allowed: uniqueSettingsSnapshots([
			before,
			...(journal.completedPaths.length === journal.preview.affectedFiles.length
				? [legacyPreservedAtTarget, after]
				: []),
		]),
	};
}

function uniqueSettingsSnapshots(
	values: readonly NamespaceMigrationSettingsSnapshot[],
): NamespaceMigrationSettingsSnapshot[] {
	const unique: NamespaceMigrationSettingsSnapshot[] = [];
	for (const value of values) {
		if (!unique.some((candidate) => namespaceMigrationSettingsEqual(candidate, value))) {
			unique.push(value);
		}
	}
	return unique;
}

export function cloneSettingsSnapshot(
	value: NamespaceMigrationSettingsSnapshot,
): NamespaceMigrationSettingsSnapshot {
	if (typeof value.inboxFile !== "string" || !isLegacyFields(value.legacy)) {
		throw new Error("migration-settings-snapshot-invalid");
	}
	return {
		inboxFile: value.inboxFile,
		legacy: cloneLegacyFields(value.legacy),
	};
}

function cloneLegacyFields(
	value: LegacyNamespaceCompatibilityFields,
): LegacyNamespaceCompatibilityFields {
	const clone: LegacyNamespaceCompatibilityFields = {};
	for (const key of LEGACY_NAMESPACE_KEYS) {
		if (Object.prototype.hasOwnProperty.call(value, key)) {
			clone[key] = structuredClone(value[key]);
		}
	}
	return clone;
}

export function namespaceMigrationSettingsEqual(
	left: NamespaceMigrationSettingsSnapshot,
	right: NamespaceMigrationSettingsSnapshot,
): boolean {
	return left.inboxFile === right.inboxFile && jsonEqual(left.legacy, right.legacy);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	if (
		leftKeys.length !== rightKeys.length ||
		leftKeys.some((key, index) => key !== rightKeys[index])
	) {
		return false;
	}
	return leftKeys.every((key) => jsonEqual(left[key], right[key]));
}

const LEGACY_NAMESPACE_KEYS = ["commonRoot", "namespaces", "activeNamespace"] as const;

function isLegacyFields(value: unknown): value is LegacyNamespaceCompatibilityFields {
	if (!isRecord(value)) return false;
	return Object.keys(value).every((key) =>
		(LEGACY_NAMESPACE_KEYS as readonly string[]).includes(key),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Derive whole-file post-images from the immutable pre-images in the journal. */
export function materializeAfter(journal: NamespaceMigrationJournal): Map<string, string | null> {
	validatePlannedSources(journal);
	const files = new Map(journal.before.map((snapshot) => [snapshot.path, snapshot.content]));
	for (const anchor of journal.preview.anchors ?? []) {
		const content = requiredContent(files, anchor.filePath);
		files.set(
			anchor.filePath,
			patchTaskId(
				content,
				anchor.filePath,
				anchor.line,
				anchor.taskId,
				anchor.descriptionHash,
			),
		);
	}
	for (const annotation of journal.preview.annotations) {
		const content = requiredContent(files, annotation.filePath);
		files.set(
			annotation.filePath,
			patchTaskScope(
				content,
				annotation.filePath,
				annotation.line,
				annotation.taskId,
				annotation.scopeId,
			),
		);
	}
	assertMoveBlocksDisjoint(files, journal.preview.inboxMoves);
	for (const move of journal.preview.inboxMoves) {
		const source = requiredContent(files, move.fromPath);
		const target = files.get(move.toPath) ?? null;
		const { remainder, block } = extractTaskBlock(source, move.fromPath, move.taskId);
		files.set(move.fromPath, remainder);
		files.set(move.toPath, appendBlock(target ?? "", block));
	}
	assertUniqueTaskIds(files);
	return files;
}

function assertMoveBlocksDisjoint(
	files: ReadonlyMap<string, string | null>,
	moves: readonly NamespaceMigrationPreview["inboxMoves"][number][],
): void {
	const rangesByPath = new Map<string, Array<{ start: number; end: number }>>();
	const tasksByPath = new Map<string, LocatedMarkdownTask[]>();
	for (const move of moves) {
		let tasks = tasksByPath.get(move.fromPath);
		if (tasks === undefined) {
			tasks = locateNamespaceMarkdownTasks(
				move.fromPath,
				requiredContent(files, move.fromPath),
			);
			tasksByPath.set(move.fromPath, tasks);
		}
		const task = uniqueTaskLocation(tasks, move.taskId);
		const range = { start: task.line, end: task.lineEnd };
		const ranges = rangesByPath.get(move.fromPath) ?? [];
		if (
			ranges.some((candidate) => range.start <= candidate.end && candidate.start <= range.end)
		) {
			throw new Error(`migration-move-blocks-overlap:${move.fromPath}`);
		}
		ranges.push(range);
		rangesByPath.set(move.fromPath, ranges);
	}
}

function validatePlannedSources(journal: NamespaceMigrationJournal): void {
	if (journal.preview.sources === undefined) return;
	const anchoredTaskIds = new Set((journal.preview.anchors ?? []).map((item) => item.taskId));
	const tasksByPath = new Map<string, LocatedMarkdownTask[]>();
	for (const source of journal.preview.sources) {
		const content = snapshotFor(journal, source.filePath).content;
		if (content === null) throw new Error(`migration-file-not-found:${source.filePath}`);
		let tasks = tasksByPath.get(source.filePath);
		if (tasks === undefined) {
			tasks = locateNamespaceMarkdownTasks(source.filePath, content);
			tasksByPath.set(source.filePath, tasks);
		}
		const task = tasks.find((candidate) => candidate.line === source.line);
		if (task === undefined || task.sourceLineHash !== source.sourceLineHash) {
			throw new Error(`migration-task-source-changed:${source.taskId}`);
		}
		const expectedTaskId = anchoredTaskIds.has(source.taskId) ? null : source.taskId;
		if (task.taskId !== expectedTaskId) {
			throw new Error(`migration-task-source-changed:${source.taskId}`);
		}
	}
}

function assertTaskInventoryMatches(
	preview: NamespaceMigrationPreview,
	path: string,
	content: string | null,
): void {
	const expected = preview.taskInventory?.find((item) => item.path === path);
	if (expected === undefined) throw new Error(`migration-task-inventory-missing:${path}`);
	const actual = scanTaskInventory(path, content);
	if (
		actual.length !== expected.tasks.length ||
		actual.some((task, index) => {
			const planned = expected.tasks[index];
			return (
				planned === undefined ||
				task.line !== planned.line ||
				(planned.lineEnd !== undefined && task.lineEnd !== planned.lineEnd) ||
				task.sourceLineHash !== planned.sourceLineHash ||
				task.requiresAnchor !== planned.requiresAnchor
			);
		})
	) {
		throw new Error(`migration-task-inventory-changed:${path}`);
	}
}

interface LocatedMarkdownTask {
	line: number;
	lineEnd: number;
	rawLine: string;
	sourceLineHash: string;
	requiresAnchor: boolean;
	taskId: string | null;
	description: string;
}

interface MarkdownListFrame {
	contentIndent: number;
	lastIncluded: number;
	paragraphOpen: boolean;
	task: LocatedMarkdownTask | null;
}

interface MarkdownFence {
	marker: "`" | "~";
	length: number;
	baseIndent: number;
	depth: number;
}

/**
 * One structural view of task Markdown for every migration operation. It keeps
 * YAML, fenced/indented code, and HTML comments out of the task namespace and
 * records CommonMark list-item boundaries (including lazy paragraph lines).
 */
export function locateNamespaceMarkdownTasks(
	path: string,
	content: string | null,
): LocatedMarkdownTask[] {
	if (content === null) return [];
	const lines = content.split("\n");
	const tasks: LocatedMarkdownTask[] = [];
	const frames: MarkdownListFrame[] = [];
	const yamlEnd = frontmatterEnd(lines);
	let fence: MarkdownFence | null = null;
	let htmlComment: { depth: number } | null = null;

	const closeTo = (depth: number): void => {
		while (frames.length > depth) {
			const frame = frames.pop()!;
			if (frame.task !== null) frame.task.lineEnd = frame.lastIncluded;
		}
	};
	const includeThrough = (depth: number, line: number): void => {
		for (let index = 0; index < depth; index++) frames[index]!.lastIncluded = line;
	};

	for (let lineStart = 0; lineStart < lines.length; lineStart++) {
		const rawLine = lines[lineStart]!;
		if (lineStart <= yamlEnd) continue;

		if (fence !== null) {
			includeThrough(fence.depth, lineStart);
			const candidate = fenceCandidate(rawLine);
			if (
				candidate !== null &&
				candidate.marker === fence.marker &&
				candidate.length >= fence.length &&
				candidate.tail.trim() === "" &&
				candidate.indent >= fence.baseIndent &&
				candidate.indent <= fence.baseIndent + 3
			) {
				fence = null;
			}
			continue;
		}
		if (htmlComment !== null) {
			includeThrough(htmlComment.depth, lineStart);
			if (rawLine.includes("-->")) htmlComment = null;
			continue;
		}

		if (rawLine.trim() === "") {
			for (const frame of frames) frame.paragraphOpen = false;
			continue;
		}

		const candidateFence = fenceCandidate(rawLine);
		if (
			candidateFence !== null &&
			(candidateFence.marker !== "`" || !candidateFence.tail.includes("`"))
		) {
			const depth = blockContainerDepth(frames, candidateFence.indent);
			if (depth !== null) {
				closeTo(depth);
				includeThrough(depth, lineStart);
				for (const frame of frames) frame.paragraphOpen = false;
				const baseIndent = depth === 0 ? 0 : frames[depth - 1]!.contentIndent;
				fence = {
					marker: candidateFence.marker,
					length: candidateFence.length,
					baseIndent,
					depth,
				};
				continue;
			}
		}

		const indentation = leadingWhitespaceColumns(rawLine);
		if (rawLine.slice(leadingWhitespaceText(rawLine).length).startsWith("<!--")) {
			const depth = blockContainerDepth(frames, indentation);
			if (depth !== null) {
				closeTo(depth);
				includeThrough(depth, lineStart);
				for (const frame of frames) frame.paragraphOpen = false;
				if (!rawLine.includes("-->")) htmlComment = { depth };
				continue;
			}
		}

		const listItem = listItemCandidate(rawLine);
		if (listItem !== null) {
			const parentDepth = listParentDepth(frames, listItem.markerIndent);
			if (parentDepth !== null) {
				closeTo(parentDepth);
				includeThrough(parentDepth, lineStart);
				for (const frame of frames) frame.paragraphOpen = false;

				const parsed = parseTaskLine(rawLine, {
					filePath: path,
					lineStart,
					parentLine: null,
					heading: null,
					container: "plain",
					projectActive: true,
				});
				let located: LocatedMarkdownTask | null = null;
				if (parsed !== null) {
					located = {
						line: lineStart,
						lineEnd: lineStart,
						rawLine,
						sourceLineHash: lineHash(rawLine),
						requiresAnchor: parsed.taskId === null,
						taskId: parsed.taskId,
						description: parsed.description,
					};
					tasks.push(located);
				}
				frames.push({
					contentIndent: listItem.contentIndent,
					lastIncluded: lineStart,
					paragraphOpen: listItem.content.trim() !== "",
					task: located,
				});
				const inlineFence = fenceCandidate(listItem.content);
				if (
					inlineFence !== null &&
					(inlineFence.marker !== "`" || !inlineFence.tail.includes("`"))
				) {
					frames.at(-1)!.paragraphOpen = false;
					fence = {
						marker: inlineFence.marker,
						length: inlineFence.length,
						baseIndent: listItem.contentIndent,
						depth: frames.length,
					};
				} else if (listItem.content.trimStart().startsWith("<!--")) {
					frames.at(-1)!.paragraphOpen = false;
					if (!listItem.content.includes("-->")) {
						htmlComment = { depth: frames.length };
					}
				}
				continue;
			}
		}

		const contentDepth = deepestContentDepth(frames, indentation);
		if (contentDepth > 0) {
			closeTo(contentDepth);
			includeThrough(contentDepth, lineStart);
			const frame = frames[contentDepth - 1]!;
			const relativeIndent = indentation - frame.contentIndent;
			frame.paragraphOpen =
				relativeIndent < 4 &&
				!startsMarkdownBlock(rawLine.slice(leadingWhitespaceText(rawLine).length));
			continue;
		}

		const deepest = frames.at(-1);
		if (deepest !== undefined && deepest.paragraphOpen && !startsMarkdownBlock(rawLine)) {
			includeThrough(frames.length, lineStart);
			continue;
		}
		closeTo(0);
	}
	closeTo(0);
	return tasks;
}

function frontmatterEnd(lines: readonly string[]): number {
	const first = lines[0]?.replace(/^\uFEFF/u, "").replace(/\r$/u, "") ?? "";
	if (!/^---[ \t]*$/u.test(first)) return -1;
	for (let index = 1; index < lines.length; index++) {
		if (/^---[ \t]*\r?$/u.test(lines[index]!)) return index;
	}
	return lines.length - 1;
}

function fenceCandidate(
	rawLine: string,
): { marker: "`" | "~"; length: number; indent: number; tail: string } | null {
	const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/u.exec(rawLine);
	if (match === null) return null;
	const run = match[2]!;
	return {
		marker: run[0] as "`" | "~",
		length: run.length,
		indent: whitespaceColumns(match[1]!),
		tail: match[3]!.replace(/\r$/u, ""),
	};
}

function blockContainerDepth(frames: readonly MarkdownListFrame[], indent: number): number | null {
	for (let index = frames.length - 1; index >= 0; index--) {
		const relative = indent - frames[index]!.contentIndent;
		if (relative >= 0 && relative <= 3) return index + 1;
	}
	return indent <= 3 ? 0 : null;
}

interface MarkdownListItemCandidate {
	markerIndent: number;
	contentIndent: number;
	content: string;
}

function listItemCandidate(rawLine: string): MarkdownListItemCandidate | null {
	const match = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/u.exec(rawLine);
	if (match === null) {
		const empty = /^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]*\r?$/u.exec(rawLine);
		if (empty === null) return null;
		const markerIndent = whitespaceColumns(empty[1]!);
		return {
			markerIndent,
			contentIndent: markerIndent + empty[2]!.length + 1,
			content: "",
		};
	}
	const markerIndent = whitespaceColumns(match[1]!);
	const markerEnd = markerIndent + match[2]!.length;
	const gapEnd = whitespaceColumns(match[3]!, markerEnd);
	const gapWidth = gapEnd - markerEnd;
	return {
		markerIndent,
		contentIndent: markerEnd + (gapWidth >= 1 && gapWidth <= 4 ? gapWidth : 1),
		content: match[4]!.replace(/\r$/u, ""),
	};
}

function listParentDepth(
	frames: readonly MarkdownListFrame[],
	markerIndent: number,
): number | null {
	for (let index = frames.length - 1; index >= 0; index--) {
		const relative = markerIndent - frames[index]!.contentIndent;
		if (relative >= 0 && relative <= 3) return index + 1;
	}
	return markerIndent <= 3 ? 0 : null;
}

function deepestContentDepth(frames: readonly MarkdownListFrame[], indent: number): number {
	for (let index = frames.length - 1; index >= 0; index--) {
		if (indent >= frames[index]!.contentIndent) return index + 1;
	}
	return 0;
}

function leadingWhitespaceText(line: string): string {
	return /^[ \t]*/u.exec(line)?.[0] ?? "";
}

function leadingWhitespaceColumns(line: string): number {
	return whitespaceColumns(leadingWhitespaceText(line));
}

function whitespaceColumns(value: string, start = 0): number {
	let column = start;
	for (const character of value) {
		column = character === "\t" ? column + (4 - (column % 4)) : column + 1;
	}
	return column;
}

function startsMarkdownBlock(rawLine: string): boolean {
	const line = rawLine.trimStart();
	if (/^#{1,6}(?:[ \t]+|$)/u.test(line) || /^>/u.test(line)) return true;
	if (/^(?:`{3,}|~{3,})/u.test(line) || /^<!--/u.test(line)) return true;
	if (/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/u.test(line)) return true;
	return /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/u.test(line);
}

function scanTaskInventory(
	path: string,
	content: string | null,
): Array<{ line: number; lineEnd: number; sourceLineHash: string; requiresAnchor: boolean }> {
	return locateNamespaceMarkdownTasks(path, content).map(
		({ line, lineEnd, sourceLineHash, requiresAnchor }) => ({
			line,
			lineEnd,
			sourceLineHash,
			requiresAnchor,
		}),
	);
}

function assertUniqueTaskIds(files: ReadonlyMap<string, string | null>): void {
	const locations = new Map<string, string>();
	for (const [path, content] of files) {
		for (const task of locateNamespaceMarkdownTasks(path, content)) {
			if (task.taskId === null) continue;
			const previous = locations.get(task.taskId);
			if (previous !== undefined) {
				throw new Error(`migration-task-id-duplicate:${task.taskId}`);
			}
			locations.set(task.taskId, `${path}:${task.line}`);
		}
	}
}

function patchTaskId(
	content: string,
	path: string,
	expectedLine: number,
	taskId: string,
	expectedDescriptionHash: string,
): string {
	const lines = content.split("\n");
	const rawLine = lines[expectedLine];
	if (rawLine === undefined) throw new Error(`migration-task-line-mismatch:${taskId}`);
	const task = locateNamespaceMarkdownTasks(path, content).find(
		(candidate) => candidate.line === expectedLine,
	);
	if (
		task === undefined ||
		task.taskId !== null ||
		descriptionHash(task.description) !== expectedDescriptionHash
	) {
		throw new Error(`migration-task-line-mismatch:${taskId}`);
	}
	try {
		lines[expectedLine] = setValueField(rawLine, "id", taskId);
	} catch {
		throw new Error(`migration-task-unpatchable:${taskId}`);
	}
	return lines.join("\n");
}

function requiredContent(files: ReadonlyMap<string, string | null>, path: string): string {
	const content = files.get(path);
	if (content === undefined || content === null)
		throw new Error(`migration-file-not-found:${path}`);
	return content;
}

function patchTaskScope(
	content: string,
	path: string,
	expectedLine: number,
	taskId: string,
	scopeId: string,
): string {
	const lines = content.split("\n");
	const task = uniqueTaskLocation(locateNamespaceMarkdownTasks(path, content), taskId);
	if (task.line !== expectedLine) throw new Error(`migration-task-line-mismatch:${taskId}`);
	try {
		lines[task.line] = setScopeId(lines[task.line]!, scopeId);
	} catch {
		throw new Error(`migration-task-unpatchable:${taskId}`);
	}
	return lines.join("\n");
}

function extractTaskBlock(
	content: string,
	path: string,
	taskId: string,
): { remainder: string; block: string } {
	const lines = content.split("\n");
	const task = uniqueTaskLocation(locateNamespaceMarkdownTasks(path, content), taskId);
	const count = task.lineEnd - task.line + 1;
	const removed = lines.splice(task.line, count);
	const block = dedentBlock(removed, leadingWhitespaceColumns(removed[0]!)).join("\n");
	return { remainder: lines.join("\n"), block };
}

function uniqueTaskLocation(
	tasks: readonly LocatedMarkdownTask[],
	taskId: string,
): LocatedMarkdownTask {
	const matches = tasks.filter((task) => task.taskId === taskId);
	if (matches.length !== 1) throw new Error(`migration-task-not-unique:${taskId}`);
	return matches[0]!;
}

function dedentBlock(lines: readonly string[], columns: number): string[] {
	if (columns === 0) return [...lines];
	return lines.map((line) => {
		if (line.trim() === "") return line;
		const whitespace = leadingWhitespaceText(line);
		if (whitespaceColumns(whitespace) < columns) {
			// CommonMark lazy continuation lines may legally carry less indentation
			// than their list marker. Promotion leaves those lines lazy at the root.
			return line;
		}
		let consumed = 0;
		let width = 0;
		while (consumed < whitespace.length && width < columns) {
			const character = whitespace[consumed]!;
			const nextWidth = character === "\t" ? width + (4 - (width % 4)) : width + 1;
			consumed += 1;
			if (nextWidth > columns) {
				return `${" ".repeat(nextWidth - columns)}${line.slice(consumed)}`;
			}
			width = nextWidth;
		}
		return line.slice(consumed);
	});
}

function appendBlock(target: string, block: string): string {
	if (target === "") return `${block}\n`;
	return `${target}${target.endsWith("\n") ? "" : "\n"}${block}\n`;
}

function snapshotFor(
	journal: NamespaceMigrationJournal,
	path: string,
): NamespaceMigrationFileSnapshot {
	const snapshot = journal.before.find((candidate) => candidate.path === path);
	if (snapshot === undefined) throw new Error(`migration-snapshot-missing:${path}`);
	return snapshot;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : "migration-unknown-error").slice(
		0,
		MAX_TEXT_FIELD_LENGTH,
	);
}

const MIGRATION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const MIGRATION_STATES = new Set([
	"prepared",
	"applying",
	"applied",
	"rolling-back",
	"rolled-back",
	"failed",
]);
const MIGRATION_SKIP_REASONS = new Set([
	"already-scoped",
	"outside-coverage",
	"common-left-unscoped",
]);
const MAX_JOURNAL_JSON_LENGTH = 16 * 1024 * 1024;
const MAX_MIGRATION_FILES = 10_000;
const MAX_MIGRATION_ITEMS = 100_000;
const MAX_TEXT_FIELD_LENGTH = 1_024;
const DESCRIPTION_HASH_RE = /^[0-9a-f]{8}$/u;

function assertMigrationId(id: string): void {
	if (!MIGRATION_ID_RE.test(id)) throw new Error("invalid-migration-id");
}

function assertJournalCapacity(journal: NamespaceMigrationJournal): void {
	const worstCase: NamespaceMigrationJournal = {
		...journal,
		state: "failed",
		completedPaths: [...journal.preview.affectedFiles],
		settingsUpdated: true,
		error: "x".repeat(MAX_TEXT_FIELD_LENGTH),
	};
	if (`${JSON.stringify(worstCase, null, 2)}\n`.length > MAX_JOURNAL_JSON_LENGTH) {
		throw new Error("migration-journal-too-large");
	}
}

function validateLoadedJournal(value: unknown, expectedId: string): NamespaceMigrationJournal {
	try {
		if (!isRecord(value)) invalidJournal();
		const raw = value;
		if (
			raw["schemaVersion"] !== 1 ||
			raw["id"] !== expectedId ||
			typeof raw["createdAt"] !== "string" ||
			raw["createdAt"].length === 0 ||
			raw["createdAt"].length > 128 ||
			typeof raw["updatedAt"] !== "string" ||
			raw["updatedAt"].length === 0 ||
			raw["updatedAt"].length > 128 ||
			typeof raw["state"] !== "string" ||
			!MIGRATION_STATES.has(raw["state"]) ||
			typeof raw["settingsUpdated"] !== "boolean" ||
			(raw["error"] !== null &&
				(typeof raw["error"] !== "string" ||
					raw["error"].length > MAX_TEXT_FIELD_LENGTH)) ||
			!Array.isArray(raw["before"]) ||
			!Array.isArray(raw["completedPaths"])
		) {
			invalidJournal();
		}
		assertMigrationPreview(raw["preview"], "migration-journal-invalid");

		const journal = value as unknown as NamespaceMigrationJournal;
		const affected = journal.preview.affectedFiles;
		if (journal.before.length !== affected.length) invalidJournal();
		for (let index = 0; index < journal.before.length; index++) {
			const snapshot = journal.before[index];
			if (
				!isRecord(snapshot) ||
				snapshot["path"] !== affected[index] ||
				(snapshot["content"] !== null && typeof snapshot["content"] !== "string")
			) {
				invalidJournal();
			}
		}

		if (
			journal.completedPaths.length > affected.length ||
			journal.completedPaths.some(
				(path, index) => !isSafeVaultMarkdownPath(path) || path !== affected[index],
			)
		) {
			invalidJournal();
		}

		if (journal.beforeInboxFile !== null && !isSafeVaultMarkdownPath(journal.beforeInboxFile)) {
			invalidJournal();
		}
		if (journal.beforeSettings !== undefined) {
			assertSettingsSnapshot(journal.beforeSettings);
			if (journal.beforeSettings.inboxFile !== journal.beforeInboxFile) invalidJournal();
			if (
				journal.preview.settingsBinding !== undefined &&
				!namespaceMigrationSettingsEqual(
					journal.preview.settingsBinding,
					journal.beforeSettings,
				)
			) {
				invalidJournal();
			}
		}

		const allPathsCompleted = journal.completedPaths.length === affected.length;
		if (journal.settingsUpdated && !allPathsCompleted) invalidJournal();
		switch (journal.state) {
			case "prepared":
				if (
					journal.completedPaths.length !== 0 ||
					journal.settingsUpdated ||
					journal.error !== null
				) {
					invalidJournal();
				}
				break;
			case "applying":
				if (journal.error !== null) invalidJournal();
				break;
			case "applied":
				if (!allPathsCompleted || !journal.settingsUpdated || journal.error !== null) {
					invalidJournal();
				}
				break;
			case "rolling-back":
				if (journal.error !== null) invalidJournal();
				break;
			case "rolled-back":
				if (journal.settingsUpdated || journal.error !== null) invalidJournal();
				break;
			case "failed":
				if (typeof journal.error !== "string" || journal.error.length === 0)
					invalidJournal();
				break;
		}
		// The immutable pre-images must actually support the declared task edits.
		// This catches forged task IDs/lines and impossible move sequences while
		// load is still read-only, including for terminal journals.
		materializeAfter(journal);
		return journal;
	} catch (error) {
		if (error instanceof Error && error.message === "invalid-migration-id") throw error;
		throw new Error("migration-journal-invalid");
	}
}

function assertMigrationPreview(
	value: unknown,
	errorCode: string,
	requireSources = false,
	requireFileBindings = false,
	requireSettingsBinding = false,
	requireTaskInventory = false,
): asserts value is NamespaceMigrationPreview {
	try {
		if (!isRecord(value) || value["schemaVersion"] !== 1 || !isRecord(value["policy"])) {
			invalidJournal();
		}
		const preview = value as unknown as NamespaceMigrationPreview;
		const policy = preview.policy;
		if (
			(policy.taskCoverage !== "all-tasks" && policy.taskCoverage !== "inbox-only") ||
			!isSafeVaultMarkdownPath(policy.targetInboxPath) ||
			!isRecord(policy.commonTasks) ||
			(policy.commonTasks.kind !== "leave-unscoped" &&
				policy.commonTasks.kind !== "assign") ||
			(policy.commonTasks.kind === "assign" && !isScopeId(policy.commonTasks.scopeId))
		) {
			invalidJournal();
		}
		if (
			!Array.isArray(preview.namespaceMappings) ||
			(requireSources && !Array.isArray(preview.sources)) ||
			(preview.sources !== undefined && !Array.isArray(preview.sources)) ||
			(requireFileBindings && !Array.isArray(preview.fileBindings)) ||
			(preview.fileBindings !== undefined && !Array.isArray(preview.fileBindings)) ||
			(requireSettingsBinding && preview.settingsBinding === undefined) ||
			(requireTaskInventory && !Array.isArray(preview.taskInventory)) ||
			(preview.taskInventory !== undefined && !Array.isArray(preview.taskInventory)) ||
			(preview.anchors !== undefined && !Array.isArray(preview.anchors)) ||
			!Array.isArray(preview.annotations) ||
			!Array.isArray(preview.inboxMoves) ||
			!Array.isArray(preview.skipped) ||
			!Array.isArray(preview.affectedFiles) ||
			preview.affectedFiles.length > MAX_MIGRATION_FILES ||
			preview.namespaceMappings.length > MAX_MIGRATION_ITEMS ||
			(preview.sources?.length ?? 0) > MAX_MIGRATION_ITEMS ||
			(preview.fileBindings?.length ?? 0) > MAX_MIGRATION_FILES ||
			(preview.taskInventory?.length ?? 0) > MAX_MIGRATION_FILES ||
			(preview.anchors?.length ?? 0) > MAX_MIGRATION_ITEMS ||
			preview.annotations.length > MAX_MIGRATION_ITEMS ||
			preview.inboxMoves.length > MAX_MIGRATION_ITEMS ||
			preview.skipped.length > MAX_MIGRATION_ITEMS
		) {
			invalidJournal();
		}
		if (preview.settingsBinding !== undefined) {
			assertSettingsSnapshot(preview.settingsBinding);
		}
		if (preview.taskInventory !== undefined) {
			if (preview.taskInventory.length !== preview.affectedFiles.length) invalidJournal();
			let taskBindingCount = 0;
			for (let fileIndex = 0; fileIndex < preview.taskInventory.length; fileIndex++) {
				const file = preview.taskInventory[fileIndex];
				if (
					!isRecord(file) ||
					file["path"] !== preview.affectedFiles[fileIndex] ||
					!Array.isArray(file["tasks"])
				) {
					invalidJournal();
				}
				let previousLine = -1;
				for (const task of file["tasks"]) {
					taskBindingCount += 1;
					if (
						taskBindingCount > MAX_MIGRATION_ITEMS ||
						!isRecord(task) ||
						!Number.isSafeInteger(task["line"]) ||
						(task["line"] as number) <= previousLine ||
						(task["lineEnd"] !== undefined &&
							(!Number.isSafeInteger(task["lineEnd"]) ||
								(task["lineEnd"] as number) < (task["line"] as number))) ||
						typeof task["sourceLineHash"] !== "string" ||
						!DESCRIPTION_HASH_RE.test(task["sourceLineHash"]) ||
						typeof task["requiresAnchor"] !== "boolean"
					) {
						invalidJournal();
					}
					previousLine = task["line"] as number;
				}
			}
		}

		if (preview.fileBindings !== undefined) {
			if (preview.fileBindings.length !== preview.affectedFiles.length) invalidJournal();
			for (let index = 0; index < preview.fileBindings.length; index++) {
				const binding = preview.fileBindings[index];
				if (
					!isRecord(binding) ||
					binding["path"] !== preview.affectedFiles[index] ||
					(binding["contentHash"] !== null &&
						(typeof binding["contentHash"] !== "string" ||
							!/^[0-9a-f]{64}$/u.test(binding["contentHash"])))
				) {
					invalidJournal();
				}
			}
		}

		const namespaceScopes = new Map<string, string>();
		for (const mapping of preview.namespaceMappings) {
			if (
				!isRecord(mapping) ||
				!isBoundedNonEmptyText(mapping["namespace"]) ||
				!isScopeId(mapping["scopeId"]) ||
				namespaceScopes.has(mapping["namespace"])
			) {
				invalidJournal();
			}
			namespaceScopes.set(mapping["namespace"], mapping["scopeId"]);
		}

		const sourcesByTask = new Map<string, NonNullable<typeof preview.sources>[number]>();
		for (const source of preview.sources ?? []) {
			if (
				!isRecord(source) ||
				!isBoundedNonEmptyText(source["taskId"]) ||
				!isSafeVaultMarkdownPath(source["filePath"]) ||
				!Number.isSafeInteger(source["line"]) ||
				(source["line"] as number) < 0 ||
				typeof source["sourceLineHash"] !== "string" ||
				!DESCRIPTION_HASH_RE.test(source["sourceLineHash"]) ||
				sourcesByTask.has(source["taskId"])
			) {
				invalidJournal();
			}
			sourcesByTask.set(
				source["taskId"],
				source as NonNullable<typeof preview.sources>[number],
			);
		}

		const anchorsByTask = new Map<string, NonNullable<typeof preview.anchors>[number]>();
		for (const anchor of preview.anchors ?? []) {
			if (
				!isRecord(anchor) ||
				!isBoundedNonEmptyText(anchor["taskId"]) ||
				!isSafeVaultMarkdownPath(anchor["filePath"]) ||
				!Number.isSafeInteger(anchor["line"]) ||
				(anchor["line"] as number) < 0 ||
				typeof anchor["descriptionHash"] !== "string" ||
				!DESCRIPTION_HASH_RE.test(anchor["descriptionHash"]) ||
				anchorsByTask.has(anchor["taskId"])
			) {
				invalidJournal();
			}
			anchorsByTask.set(
				anchor["taskId"],
				anchor as NonNullable<typeof preview.anchors>[number],
			);
		}

		const annotationsByTask = new Map<string, (typeof preview.annotations)[number]>();
		for (const annotation of preview.annotations) {
			if (
				!isRecord(annotation) ||
				!isBoundedNonEmptyText(annotation["taskId"]) ||
				!isSafeVaultMarkdownPath(annotation["filePath"]) ||
				!Number.isSafeInteger(annotation["line"]) ||
				(annotation["line"] as number) < 0 ||
				!isBoundedNonEmptyText(annotation["fromNamespace"]) ||
				!isScopeId(annotation["scopeId"]) ||
				annotationsByTask.has(annotation["taskId"])
			) {
				invalidJournal();
			}
			const expectedScope =
				annotation["fromNamespace"] === LEGACY_DEFAULT_NAMESPACE
					? policy.commonTasks.kind === "assign"
						? policy.commonTasks.scopeId
						: null
					: (namespaceScopes.get(annotation["fromNamespace"]) ?? null);
			if (expectedScope !== annotation["scopeId"]) invalidJournal();
			annotationsByTask.set(
				annotation["taskId"],
				annotation as (typeof preview.annotations)[number],
			);
		}

		const movesByTask = new Set<string>();
		for (const move of preview.inboxMoves) {
			if (
				!isRecord(move) ||
				!isBoundedNonEmptyText(move["taskId"]) ||
				!isSafeVaultMarkdownPath(move["fromPath"]) ||
				!isSafeVaultMarkdownPath(move["toPath"]) ||
				move["fromPath"] === move["toPath"] ||
				move["toPath"] !== policy.targetInboxPath ||
				!isBoundedNonEmptyText(move["fromNamespace"]) ||
				(move["fromNamespace"] !== LEGACY_DEFAULT_NAMESPACE &&
					!namespaceScopes.has(move["fromNamespace"])) ||
				movesByTask.has(move["taskId"])
			) {
				invalidJournal();
			}
			const annotation = annotationsByTask.get(move["taskId"]);
			if (annotation !== undefined && annotation.filePath !== move["fromPath"]) {
				invalidJournal();
			}
			movesByTask.add(move["taskId"]);
		}

		for (const [taskId, anchor] of anchorsByTask) {
			const annotation = annotationsByTask.get(taskId);
			if (annotation === undefined && !movesByTask.has(taskId)) {
				invalidJournal();
			}
			if (
				annotation !== undefined &&
				(annotation.filePath !== anchor.filePath || annotation.line !== anchor.line)
			) {
				invalidJournal();
			}
			const move = preview.inboxMoves.find((candidate) => candidate.taskId === taskId);
			if (move !== undefined && move.fromPath !== anchor.filePath) invalidJournal();
		}

		if (preview.sources !== undefined) {
			const affectedTaskIds = new Set([...annotationsByTask.keys(), ...movesByTask]);
			if (
				sourcesByTask.size !== affectedTaskIds.size ||
				[...affectedTaskIds].some((taskId) => !sourcesByTask.has(taskId))
			) {
				invalidJournal();
			}
			for (const [taskId, source] of sourcesByTask) {
				const annotation = annotationsByTask.get(taskId);
				const move = preview.inboxMoves.find((candidate) => candidate.taskId === taskId);
				if (
					annotation !== undefined &&
					(annotation.filePath !== source.filePath || annotation.line !== source.line)
				) {
					invalidJournal();
				}
				if (move !== undefined && move.fromPath !== source.filePath) invalidJournal();
				const anchor = anchorsByTask.get(taskId);
				if (
					anchor !== undefined &&
					(anchor.filePath !== source.filePath || anchor.line !== source.line)
				) {
					invalidJournal();
				}
			}
		}

		const skippedTasks = new Set<string>();
		for (const skipped of preview.skipped) {
			if (
				!isRecord(skipped) ||
				!isBoundedNonEmptyText(skipped["taskId"]) ||
				!isSafeVaultMarkdownPath(skipped["filePath"]) ||
				typeof skipped["reason"] !== "string" ||
				!MIGRATION_SKIP_REASONS.has(skipped["reason"]) ||
				skippedTasks.has(skipped["taskId"]) ||
				annotationsByTask.has(skipped["taskId"])
			) {
				invalidJournal();
			}
			skippedTasks.add(skipped["taskId"]);
		}

		const derivedAffected = [
			...new Set([
				...(preview.sources ?? []).map((source) => source.filePath),
				...(preview.anchors ?? []).map((anchor) => anchor.filePath),
				...preview.annotations.map((annotation) => annotation.filePath),
				...preview.inboxMoves.flatMap((move) => [move.fromPath, move.toPath]),
			]),
		].sort();
		if (
			preview.affectedFiles.length !== derivedAffected.length ||
			preview.affectedFiles.some(
				(path, index) => !isSafeVaultMarkdownPath(path) || path !== derivedAffected[index],
			)
		) {
			invalidJournal();
		}
	} catch {
		throw new Error(errorCode);
	}
}

function descriptionHash(description: string): string {
	return fnv1a(description).toString(16).padStart(8, "0");
}

function lineHash(rawLine: string): string {
	return fnv1a(rawLine).toString(16).padStart(8, "0");
}

async function contentHash(content: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertBoundSnapshots(journal: NamespaceMigrationJournal): Promise<void> {
	if (journal.preview.fileBindings === undefined) return;
	for (const [index, binding] of journal.preview.fileBindings.entries()) {
		const snapshot = journal.before[index];
		if (snapshot === undefined || snapshot.path !== binding.path) {
			throw new Error("migration-journal-invalid");
		}
		const actual = snapshot.content === null ? null : await contentHash(snapshot.content);
		if (actual !== binding.contentHash) throw new Error("migration-journal-invalid");
	}
}

function assertSettingsSnapshot(
	value: unknown,
): asserts value is NamespaceMigrationSettingsSnapshot {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => key !== "inboxFile" && key !== "legacy") ||
		!isSafeVaultMarkdownPath(value["inboxFile"]) ||
		!isLegacyFields(value["legacy"]) ||
		!isBoundedJsonValue(value["legacy"])
	) {
		invalidJournal();
	}
}

function isSafeVaultMarkdownPath(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_TEXT_FIELD_LENGTH ||
		value !== value.trim() ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		/[\u0000-\u001f\u007f]/u.test(value) ||
		!/\.md$/iu.test(value)
	) {
		return false;
	}
	const segments = value.split("/");
	return (
		segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
		!segments[0]!.startsWith(".")
	);
}

function isBoundedNonEmptyText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_TEXT_FIELD_LENGTH &&
		value === value.trim() &&
		!/\p{Cc}/u.test(value)
	);
}

function isBoundedJsonValue(value: unknown): boolean {
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		nodes++;
		if (nodes > MAX_MIGRATION_ITEMS || current.depth > 64) return false;
		if (
			current.value === null ||
			typeof current.value === "string" ||
			typeof current.value === "boolean"
		) {
			continue;
		}
		if (typeof current.value === "number") {
			if (!Number.isFinite(current.value)) return false;
			continue;
		}
		if (Array.isArray(current.value)) {
			for (const child of current.value) {
				pending.push({ value: child, depth: current.depth + 1 });
			}
			continue;
		}
		if (!isRecord(current.value)) return false;
		for (const child of Object.values(current.value)) {
			pending.push({ value: child, depth: current.depth + 1 });
		}
	}
	return true;
}

function invalidJournal(): never {
	throw new Error("migration-journal-invalid");
}
