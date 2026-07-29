/** Compatibility-only discovery of a pre-v2 namespace layout. */
import { isActive } from "../core/model/gtdState";
import type { IsoDate, Task } from "../core/model/Task";
import { fnv1a } from "../core/parser/taskKey";
import {
	LEGACY_DEFAULT_NAMESPACE,
	type LegacyInboxInventory,
	type LegacyNamespaceDef,
	type LegacyNamespaceInventory,
	type LegacyTaskInventory,
} from "../core/scope/namespaceMigration";

export interface LegacyNamespaceDiscovery {
	inventory: LegacyNamespaceInventory;
	/** ID-less tasks receive deterministic proposed IDs; no Markdown is changed here. */
	missingTaskIds: Array<{
		key: string;
		filePath: string;
		line: number;
		proposedTaskId: string;
	}>;
}

export interface LegacyNamespaceDiscoveryInput {
	namespaces: readonly LegacyNamespaceDef[];
	tasks: readonly Task[];
	today: IsoDate;
	/** Empty inboxes do not appear in TaskIndex, so metadata discovery supplies them. */
	inboxPaths?: readonly string[];
	/** Reads `gtd-namespace` only for this compatibility migration. */
	overrideForPath?: (path: string) => string | null;
}

/**
 * Builds a deterministic planner inventory without adding namespace semantics
 * back to runtime queries. `gtd-namespace` is consulted only through the
 * optional compatibility callback passed by the migration UI.
 */
export function discoverLegacyNamespaceInventory(
	input: LegacyNamespaceDiscoveryInput,
): LegacyNamespaceDiscovery {
	const namespaceFor = (path: string) =>
		legacyNamespaceForPath(path, input.namespaces, input.overrideForPath?.(path) ?? null);
	const inboxPaths = new Set(input.inboxPaths ?? []);
	for (const task of input.tasks) {
		if (task.container === "inbox") inboxPaths.add(task.filePath);
	}

	const missingTaskIds: LegacyNamespaceDiscovery["missingTaskIds"] = [];
	const tasks: LegacyTaskInventory[] = [];
	const activeByInbox = new Map<string, string[]>();
	const reservedTaskIds = new Set(
		input.tasks.flatMap((task) => (task.taskId === null ? [] : [task.taskId])),
	);
	const orderedTasks = [...input.tasks].sort(compareTasks);
	const activeBlockEndByInbox = new Map<string, number>();
	for (const path of [...inboxPaths].sort(compareText)) activeByInbox.set(path, []);

	for (const task of orderedTasks) {
		const proposedTaskId = task.taskId ?? deterministicMigrationTaskId(task, reservedTaskIds);
		const requiresAnchor = task.taskId === null;
		if (requiresAnchor)
			missingTaskIds.push({
				key: task.key,
				filePath: task.filePath,
				line: task.lineStart,
				proposedTaskId,
			});
		const inLegacyInbox = task.container === "inbox";
		tasks.push({
			taskId: proposedTaskId,
			filePath: task.filePath,
			line: task.lineStart,
			lineEnd: task.lineEnd,
			namespace: namespaceFor(task.filePath),
			inLegacyInbox,
			scopeId: task.scopeId,
			requiresAnchor,
			...(requiresAnchor ? { descriptionHash: descriptionHash(task.description) } : {}),
			sourceLineHash: lineHash(task.rawLine),
		});
		// A move operates on the complete Markdown list-item range. Schedule the
		// highest active task block only; inactive parents do not strand an active
		// child, and non-task list parents do not hide it.
		const activeBlockEnd = activeBlockEndByInbox.get(task.filePath) ?? -1;
		if (inLegacyInbox && isActive(task, input.today) && task.lineStart > activeBlockEnd) {
			const entries = activeByInbox.get(task.filePath) ?? [];
			entries.push(proposedTaskId);
			activeByInbox.set(task.filePath, entries);
			activeBlockEndByInbox.set(task.filePath, Math.max(activeBlockEnd, task.lineEnd));
		}
	}

	const inboxes: LegacyInboxInventory[] = [...activeByInbox]
		.map(([path, activeTaskIds]) => ({
			namespace: namespaceFor(path),
			path,
			// orderedTasks already gives deterministic source-line order. Do not
			// sort by opaque ID or migration would reorder sibling blocks.
			activeTaskIds: [...new Set(activeTaskIds)],
		}))
		.sort((left, right) => compareText(left.path, right.path));
	return {
		inventory: {
			namespaces: input.namespaces.map((namespace) => ({ ...namespace })),
			inboxes,
			tasks,
		},
		missingTaskIds,
	};
}

function deterministicMigrationTaskId(task: Task, reserved: Set<string>): string {
	const identity = `${task.filePath}\n${task.lineStart}\n${task.description}\n${task.key}`;
	const first = fnv1a(identity).toString(16).padStart(8, "0");
	const second = fnv1a(`gtd-flow-migration-v2\0${identity}`).toString(16).padStart(8, "0");
	const base = `migration_${first}${second}`;
	let candidate = base;
	let suffix = 2;
	while (reserved.has(candidate)) candidate = `${base}_${suffix++}`;
	reserved.add(candidate);
	return candidate;
}

function descriptionHash(description: string): string {
	return fnv1a(description).toString(16).padStart(8, "0");
}

function lineHash(rawLine: string): string {
	return fnv1a(rawLine).toString(16).padStart(8, "0");
}

export function legacyNamespaceForPath(
	path: string,
	namespaces: readonly LegacyNamespaceDef[],
	override: string | null,
): string {
	const cleanOverride = override?.trim() ?? "";
	if (cleanOverride !== "") return cleanOverride;
	const normalizedPath = normalize(path);
	let winner: LegacyNamespaceDef | null = null;
	for (const namespace of namespaces) {
		const root = normalize(namespace.root);
		if (root === "" || (normalizedPath !== root && !normalizedPath.startsWith(`${root}/`))) {
			continue;
		}
		if (winner === null || root.length > normalize(winner.root).length) winner = namespace;
	}
	return winner?.name ?? LEGACY_DEFAULT_NAMESPACE;
}

function compareTasks(left: Task, right: Task): number {
	return (
		compareText(left.filePath, right.filePath) ||
		left.lineStart - right.lineStart ||
		compareText(left.key, right.key)
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(path: string): string {
	return path
		.trim()
		.replace(/\\/gu, "/")
		.replace(/^\/+|\/+$/gu, "");
}
