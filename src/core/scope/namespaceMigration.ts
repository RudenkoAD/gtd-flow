import { isActiveScopeId, type ScopeCatalog } from "./scope";

/** Namespace-shaped data is read only while planning a one-time legacy migration. */
export interface LegacyNamespaceDef {
	name: string;
	root: string;
}

export interface LegacyNamespaceSettings {
	commonRoot: string | null;
	activeNamespace: string | null;
	namespaces: LegacyNamespaceDef[];
}

export const LEGACY_DEFAULT_NAMESPACE = "Общее";

/**
 * Compatibility reader for pre-v2 data.json. Target runtime settings deliberately
 * have no namespace fields; callers may use this only to prepare a migration plan.
 */
export function readLegacyNamespaceSettings(value: unknown): LegacyNamespaceSettings {
	const raw = isRecord(value) ? value : {};
	const namespaces = Array.isArray(raw["namespaces"])
		? raw["namespaces"].flatMap((entry) => {
				if (!isRecord(entry)) return [];
				const name = nonEmptyString(entry["name"]);
				const root = nonEmptyString(entry["root"]);
				return name === null || root === null ? [] : [{ name, root }];
			})
		: [];
	return {
		commonRoot: nonEmptyString(raw["commonRoot"]),
		activeNamespace: nonEmptyString(raw["activeNamespace"]),
		namespaces,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const clean = value.trim();
	return clean === "" ? null : clean;
}

/**
 * Namespace migration deliberately keeps the two unresolved product choices as
 * required inputs. Callers cannot accidentally migrate every task, or assign
 * Common tasks, without an explicit user choice.
 */
export type NamespaceTaskCoverage = "all-tasks" | "inbox-only";

export type CommonTaskPolicy = { kind: "leave-unscoped" } | { kind: "assign"; scopeId: string };

export interface NamespaceMigrationPolicy {
	taskCoverage: NamespaceTaskCoverage;
	commonTasks: CommonTaskPolicy;
	/** The single inbox file which replaces all namespace inboxes. */
	targetInboxPath: string;
}

export interface LegacyNamespaceInventory {
	namespaces: readonly LegacyNamespaceDef[];
	/** Existing per-namespace inbox files, including Common when present. */
	inboxes: readonly LegacyInboxInventory[];
	tasks: readonly LegacyTaskInventory[];
}

export interface LegacyInboxInventory {
	namespace: string;
	path: string;
	/** Stable task IDs whose complete blocks must be moved to the unified inbox. */
	activeTaskIds: readonly string[];
}

export interface LegacyTaskInventory {
	taskId: string;
	filePath: string;
	line: number;
	/**
	 * Inclusive Markdown list-item boundary reported by Obsidian. Optional keeps
	 * hand-authored/legacy planner inputs readable; new discovery always supplies it.
	 */
	lineEnd?: number;
	namespace: string;
	/** True only when the task is in that namespace's legacy inbox. */
	inLegacyInbox: boolean;
	/** Existing explicit scope. It is preserved and never overwritten by migration. */
	scopeId: string | null;
	/** True when taskId is a deterministic migration proposal, not yet present in Markdown. */
	requiresAnchor?: boolean;
	/** Stable fingerprint used to fail closed if the id-less source line changes before apply. */
	descriptionHash?: string;
	/** Exact raw-line fingerprint binding a new dry-run to the source the user reviewed. */
	sourceLineHash?: string;
}

export interface NamespaceScopeMapping {
	/** Named legacy namespace name -> active scope ID. */
	byNamespace: Readonly<Record<string, string>>;
}

export interface NamespaceMigrationPreview {
	schemaVersion: 1;
	policy: NamespaceMigrationPolicy;
	namespaceMappings: Array<{ namespace: string; scopeId: string }>;
	/**
	 * New previews bind every affected task to the exact Markdown line observed
	 * during discovery. Optional keeps already-created v1 journals readable.
	 */
	sources?: NamespaceTaskSource[];
	/**
	 * Exact full-file hashes captured when the dry-run is displayed. New apply
	 * requests require these; legacy saved journals may omit them.
	 */
	fileBindings?: NamespaceMigrationFileBinding[];
	/** Exact migration-owned settings observed with the displayed dry-run. */
	settingsBinding?: NamespaceMigrationSettingsSnapshot;
	/**
	 * Complete parsed-task inventory for every affected file. The executor
	 * verifies it directly from Markdown before showing a bound dry-run.
	 */
	taskInventory?: NamespaceFileTaskInventory[];
	/**
	 * ID insertions selected by this dry run. They are applied from the journal's
	 * immutable pre-images, before annotations and moves, so rollback removes them.
	 */
	anchors?: NamespaceTaskAnchor[];
	annotations: NamespaceTaskAnnotation[];
	inboxMoves: NamespaceInboxMove[];
	skipped: NamespaceMigrationSkip[];
	affectedFiles: string[];
}

export interface NamespaceTaskSource {
	taskId: string;
	filePath: string;
	line: number;
	sourceLineHash: string;
}

export interface NamespaceMigrationFileBinding {
	path: string;
	/** null means the target file did not exist when the dry-run was displayed. */
	contentHash: string | null;
}

export interface NamespaceFileTaskInventory {
	path: string;
	tasks: NamespaceTaskLineBinding[];
}

export interface NamespaceTaskLineBinding {
	line: number;
	/** Inclusive complete list-item boundary bound to the displayed dry-run. */
	lineEnd?: number;
	sourceLineHash: string;
	requiresAnchor: boolean;
}

export interface NamespaceTaskAnchor {
	taskId: string;
	filePath: string;
	line: number;
	descriptionHash: string;
}

export interface NamespaceTaskAnnotation {
	taskId: string;
	filePath: string;
	line: number;
	fromNamespace: string;
	scopeId: string;
}

export interface NamespaceInboxMove {
	taskId: string;
	fromPath: string;
	toPath: string;
	fromNamespace: string;
}

export interface NamespaceMigrationSkip {
	taskId: string;
	filePath: string;
	reason: "already-scoped" | "outside-coverage" | "common-left-unscoped";
}

export type NamespaceMigrationPlanResult =
	{ ok: true; preview: NamespaceMigrationPreview } | { ok: false; errors: string[] };

/**
 * Build a complete, deterministic dry-run. It performs no I/O and is therefore
 * safe to show before the user confirms any mutation.
 */
export function planNamespaceMigration(
	inventory: LegacyNamespaceInventory,
	mapping: NamespaceScopeMapping,
	policy: NamespaceMigrationPolicy,
	catalog: ScopeCatalog,
): NamespaceMigrationPlanResult {
	const errors = validateMigrationInputs(inventory, mapping, policy, catalog);
	if (errors.length > 0) return { ok: false, errors };

	const namespaceMappings = inventory.namespaces
		.map((namespace) => ({
			namespace: namespace.name,
			scopeId: mapping.byNamespace[namespace.name]!,
		}))
		.sort((a, b) => compareText(a.namespace, b.namespace));

	const annotations: NamespaceTaskAnnotation[] = [];
	const skipped: NamespaceMigrationSkip[] = [];
	const orderedTasks = [...inventory.tasks].sort(
		(a, b) =>
			compareText(a.filePath, b.filePath) ||
			a.line - b.line ||
			compareText(a.taskId, b.taskId),
	);

	for (const task of orderedTasks) {
		if (task.scopeId !== null) {
			skipped.push({
				taskId: task.taskId,
				filePath: task.filePath,
				reason: "already-scoped",
			});
			continue;
		}
		if (policy.taskCoverage === "inbox-only" && !task.inLegacyInbox) {
			skipped.push({
				taskId: task.taskId,
				filePath: task.filePath,
				reason: "outside-coverage",
			});
			continue;
		}

		const scopeId =
			task.namespace === LEGACY_DEFAULT_NAMESPACE
				? policy.commonTasks.kind === "assign"
					? policy.commonTasks.scopeId
					: null
				: (mapping.byNamespace[task.namespace] ?? null);
		if (scopeId === null) {
			skipped.push({
				taskId: task.taskId,
				filePath: task.filePath,
				reason: "common-left-unscoped",
			});
			continue;
		}
		annotations.push({
			taskId: task.taskId,
			filePath: task.filePath,
			line: task.line,
			fromNamespace: task.namespace,
			scopeId,
		});
	}

	const inboxMoves: NamespaceInboxMove[] = [];
	for (const inbox of [...inventory.inboxes].sort((a, b) => compareText(a.path, b.path))) {
		if (normalizeVaultPath(inbox.path) === normalizeVaultPath(policy.targetInboxPath)) continue;
		for (const taskId of inbox.activeTaskIds) {
			inboxMoves.push({
				taskId,
				fromPath: normalizeVaultPath(inbox.path),
				toPath: normalizeVaultPath(policy.targetInboxPath),
				fromNamespace: inbox.namespace,
			});
		}
	}

	const affectedTaskIds = new Set([
		...annotations.map((item) => item.taskId),
		...inboxMoves.map((item) => item.taskId),
	]);
	const affectedTasks = orderedTasks.filter((task) => affectedTaskIds.has(task.taskId));
	const missingSource = affectedTasks.find(
		(task) =>
			typeof task.sourceLineHash !== "string" || !/^[0-9a-f]{8}$/u.test(task.sourceLineHash),
	);
	if (missingSource !== undefined) {
		return {
			ok: false,
			errors: [`Task '${missingSource.taskId}' is missing its dry-run source fingerprint.`],
		};
	}
	const sources: NamespaceTaskSource[] = affectedTasks.map((task) => ({
		taskId: task.taskId,
		filePath: normalizeVaultPath(task.filePath),
		line: task.line,
		sourceLineHash: task.sourceLineHash!,
	}));
	const anchors: NamespaceTaskAnchor[] = orderedTasks
		.filter((task) => task.requiresAnchor === true && affectedTaskIds.has(task.taskId))
		.map((task) => ({
			taskId: task.taskId,
			filePath: normalizeVaultPath(task.filePath),
			line: task.line,
			descriptionHash: task.descriptionHash ?? "",
		}));
	const affectedFiles = [
		...new Set([
			...anchors.map((item) => item.filePath),
			...annotations.map((item) => normalizeVaultPath(item.filePath)),
			...inboxMoves.flatMap((item) => [item.fromPath, item.toPath]),
		]),
	].sort(compareText);
	const affectedFileSet = new Set(affectedFiles);
	const inventoryTasks = orderedTasks.filter((task) =>
		affectedFileSet.has(normalizeVaultPath(task.filePath)),
	);
	const missingInventorySource = inventoryTasks.find(
		(task) =>
			typeof task.sourceLineHash !== "string" || !/^[0-9a-f]{8}$/u.test(task.sourceLineHash),
	);
	if (missingInventorySource !== undefined) {
		return {
			ok: false,
			errors: [
				`Task '${missingInventorySource.taskId}' is missing its file inventory fingerprint.`,
			],
		};
	}
	const taskInventory: NamespaceFileTaskInventory[] = affectedFiles.map((path) => ({
		path,
		tasks: inventoryTasks
			.filter((task) => normalizeVaultPath(task.filePath) === path)
			.map((task) => ({
				line: task.line,
				lineEnd: task.lineEnd ?? task.line,
				sourceLineHash: task.sourceLineHash!,
				requiresAnchor: task.requiresAnchor === true,
			})),
	}));

	return {
		ok: true,
		preview: {
			schemaVersion: 1,
			policy: {
				...policy,
				targetInboxPath: normalizeVaultPath(policy.targetInboxPath),
				commonTasks: { ...policy.commonTasks },
			},
			namespaceMappings,
			sources,
			taskInventory,
			anchors,
			annotations,
			inboxMoves,
			skipped,
			affectedFiles,
		},
	};
}

function validateMigrationInputs(
	inventory: LegacyNamespaceInventory,
	mapping: NamespaceScopeMapping,
	policy: NamespaceMigrationPolicy,
	catalog: ScopeCatalog,
): string[] {
	const errors: string[] = [];
	if (normalizeVaultPath(policy.targetInboxPath) === "") {
		errors.push("A unified inbox path is required.");
	}

	const namespaceNames = new Set<string>();
	for (const namespace of inventory.namespaces) {
		if (namespaceNames.has(namespace.name)) {
			errors.push(`Legacy namespace '${namespace.name}' is duplicated.`);
			continue;
		}
		namespaceNames.add(namespace.name);
		const scopeId = mapping.byNamespace[namespace.name];
		if (scopeId === undefined) {
			errors.push(`Legacy namespace '${namespace.name}' has no scope mapping.`);
		} else if (!isActiveScopeId(catalog, scopeId)) {
			errors.push(`Scope '${scopeId}' for namespace '${namespace.name}' is not active.`);
		}
	}

	for (const namespaceName of Object.keys(mapping.byNamespace)) {
		if (!namespaceNames.has(namespaceName)) {
			errors.push(`Mapping references unknown namespace '${namespaceName}'.`);
		}
	}
	if (
		policy.commonTasks.kind === "assign" &&
		!isActiveScopeId(catalog, policy.commonTasks.scopeId)
	) {
		errors.push(`Scope '${policy.commonTasks.scopeId}' for Common tasks is not active.`);
	}

	const taskIds = new Set<string>();
	for (const task of inventory.tasks) {
		if (task.taskId.trim() === "") errors.push("A legacy task is missing a stable task ID.");
		if (taskIds.has(task.taskId)) errors.push(`Task ID '${task.taskId}' is duplicated.`);
		taskIds.add(task.taskId);
		if (
			task.requiresAnchor === true &&
			(typeof task.descriptionHash !== "string" ||
				!/^[0-9a-f]{8}$/u.test(task.descriptionHash))
		) {
			errors.push(`Task '${task.taskId}' has an invalid source fingerprint.`);
		}
		if (
			task.namespace !== LEGACY_DEFAULT_NAMESPACE &&
			!namespaceNames.has(task.namespace) &&
			task.scopeId === null
		) {
			errors.push(`Task '${task.taskId}' belongs to unknown namespace '${task.namespace}'.`);
		}
		if (!Number.isSafeInteger(task.line) || task.line < 0) {
			errors.push(`Task '${task.taskId}' has an invalid line number.`);
		}
		if (
			task.lineEnd !== undefined &&
			(!Number.isSafeInteger(task.lineEnd) || task.lineEnd < task.line)
		) {
			errors.push(`Task '${task.taskId}' has an invalid ending line number.`);
		}
	}

	for (const inbox of inventory.inboxes) {
		for (const taskId of inbox.activeTaskIds) {
			if (!taskIds.has(taskId)) {
				errors.push(`Inbox '${inbox.path}' references unknown task '${taskId}'.`);
			}
		}
	}
	return [...new Set(errors)];
}

function normalizeVaultPath(path: string): string {
	return path
		.trim()
		.replace(/\\/gu, "/")
		.replace(/^\/+/gu, "")
		.replace(/\/+/gu, "/")
		.replace(/\/+$/gu, "");
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export type NamespaceMigrationState =
	"prepared" | "applying" | "applied" | "rolling-back" | "rolled-back" | "failed";

export interface NamespaceMigrationFileSnapshot {
	path: string;
	/** Complete pre-migration contents, required for byte-equivalent rollback. */
	content: string | null;
}

/**
 * Exact retired fields as they appeared in data.json. Property presence and
 * raw JSON values are significant: rollback must not reconstruct them from the
 * normalized runtime compatibility reader.
 */
export interface LegacyNamespaceCompatibilityFields {
	commonRoot?: unknown;
	namespaces?: unknown;
	activeNamespace?: unknown;
}

export interface NamespaceMigrationSettingsSnapshot {
	inboxFile: string;
	legacy: LegacyNamespaceCompatibilityFields;
}

export interface NamespaceMigrationJournal {
	schemaVersion: 1;
	id: string;
	createdAt: string;
	updatedAt: string;
	state: NamespaceMigrationState;
	preview: NamespaceMigrationPreview;
	before: NamespaceMigrationFileSnapshot[];
	/** Inbox value before the migration; null means a caller did not persist settings. */
	beforeInboxFile: string | null;
	/**
	 * Added to v1 journals after their initial release. Optional keeps existing
	 * journals readable; the I/O service upgrades an old pre-apply journal before
	 * its next mutation.
	 */
	beforeSettings?: NamespaceMigrationSettingsSnapshot;
	completedPaths: string[];
	settingsUpdated: boolean;
	error: string | null;
}

/**
 * A journal is created before the first mutation and captures every affected
 * file in full. The I/O service may then advance completedPaths one atomic
 * write at a time and safely resume or restore the exact original bytes.
 */
export function createNamespaceMigrationJournal(input: {
	id: string;
	now: string;
	preview: NamespaceMigrationPreview;
	before: readonly NamespaceMigrationFileSnapshot[];
	beforeInboxFile?: string | null;
	beforeSettings?: NamespaceMigrationSettingsSnapshot;
}): NamespaceMigrationJournal {
	if (input.id.trim() === "") throw new Error("migration-id-required");
	const expected = input.preview.affectedFiles;
	const snapshots = new Map(
		input.before.map((snapshot) => [normalizeVaultPath(snapshot.path), snapshot.content]),
	);
	for (const path of expected) {
		if (!snapshots.has(path)) throw new Error(`migration-snapshot-missing:${path}`);
	}
	return {
		schemaVersion: 1,
		id: input.id,
		createdAt: input.now,
		updatedAt: input.now,
		state: "prepared",
		preview: input.preview,
		before: expected.map((path) => ({ path, content: snapshots.get(path) ?? null })),
		beforeInboxFile: input.beforeSettings?.inboxFile ?? input.beforeInboxFile ?? null,
		...(input.beforeSettings === undefined
			? {}
			: { beforeSettings: structuredClone(input.beforeSettings) }),
		completedPaths: [],
		settingsUpdated: false,
		error: null,
	};
}

export function pendingMigrationPaths(journal: NamespaceMigrationJournal): string[] {
	const completed = new Set(journal.completedPaths.map(normalizeVaultPath));
	return journal.preview.affectedFiles.filter((path) => !completed.has(normalizeVaultPath(path)));
}

export function markMigrationPathCompleted(
	journal: NamespaceMigrationJournal,
	path: string,
	now: string,
): NamespaceMigrationJournal {
	const normalized = normalizeVaultPath(path);
	if (!journal.preview.affectedFiles.includes(normalized)) {
		throw new Error(`migration-path-not-planned:${normalized}`);
	}
	return {
		...journal,
		state: "applying",
		updatedAt: now,
		completedPaths: [...new Set([...journal.completedPaths, normalized])],
		error: null,
	};
}

export function finishNamespaceMigration(
	journal: NamespaceMigrationJournal,
	now: string,
): NamespaceMigrationJournal {
	if (pendingMigrationPaths(journal).length > 0) throw new Error("migration-files-pending");
	return {
		...journal,
		state: "applied",
		updatedAt: now,
		settingsUpdated: true,
		error: null,
	};
}
