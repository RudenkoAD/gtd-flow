import type { App } from "obsidian";
import type { Intent, PatchTaskMetadata } from "../../core/intents/Intent";
import {
	isDurationMinutes,
	isIntensityLevel,
	type DurationMinutes,
	type IntensityLevel,
	type IsoDate,
	type Priority,
	type ProjectStatus,
	type Task,
} from "../../core/model/Task";
import { parseDatePayload, parseTaskLine } from "../../core/parser/parseTaskLine";
import { isScopeId } from "../../core/scope/scope";
import type { VaultAdapter } from "../../adapters/VaultAdapter";
import {
	insertIntoColumnOrder,
	type BoardService,
	type DiscoveredBoard,
} from "../../services/BoardService";
import type { ProjectService, ProjectSummary } from "../../services/ProjectService";
import type { WritebackService } from "../../services/WritebackService";
import { isVaultRelativePath, type GtdToolPorts, type UndoableValue } from "../tools/gtdTools";
import type { ToolExecutionContext } from "../tools/ToolRegistry";

const MAX_BOARD_COLUMNS = 100;
const MAX_BOARD_TASKS_PER_COLUMN = 1_000;
const MAX_BOARD_ORDER_IDS = 1_000;

type EstimateOwnershipPatch = Partial<
	Record<"duration" | "cognitive" | "emotional" | "physical" | "scope", number | string | null>
>;

export interface PreparedAiMetadataMutation {
	commit(): Promise<void>;
	cancel(): Promise<void>;
}

type TaskDateField = "due" | "scheduled" | "start";
type TaskStatus = "open" | "done" | "cancelled";
type SetStatusIntent = Extract<Intent, { type: "set-status" }>;
type SetDateIntent = Extract<Intent, { type: "set-date" }>;

interface ParsedTaskDateTime {
	date: IsoDate;
	time: string | null;
	timeEnd: string | null;
}

export interface GtdToolPortsAdapterOptions {
	app: App;
	vault: VaultAdapter;
	dispatcher: WritebackService;
	allTasks(): readonly Task[];
	inboxFile(): string;
	ensureInbox(path: string): Promise<void>;
	isActiveScope(scopeId: string): boolean;
	assertAiPatchAllowed?(taskId: string, patch: EstimateOwnershipPatch): Promise<void>;
	expectAiPatch?(taskId: string, patch: EstimateOwnershipPatch): void | (() => void);
	prepareAiMetadataMutation?(
		task: Task,
		patch: EstimateOwnershipPatch,
		context: ToolExecutionContext | undefined,
	): Promise<PreparedAiMetadataMutation>;
	scopeCatalog?(): unknown;
	projects?: Pick<
		ProjectService,
		| "discoverProjects"
		| "model"
		| "connect"
		| "disconnect"
		| "setProjectStatus"
		| "deleteNode"
		| "createProject"
	>;
	boards?: Pick<
		BoardService,
		| "discoverBoards"
		| "boardModel"
		| "moveCard"
		| "reorderCard"
		| "renameBoard"
		| "renameColumn"
		| "moveColumn"
		| "deleteColumn"
		| "createBoard"
	>;
	currentRun?(): Promise<unknown>;
	createTaskId?: () => string;
	todayIso?: () => IsoDate;
}

/** Application-service adapter used by chat tools; no raw filesystem access. */
export class GtdToolPortsAdapter implements GtdToolPorts {
	private readonly createTaskId: () => string;
	private readonly todayIso: () => IsoDate;

	constructor(private readonly options: GtdToolPortsAdapterOptions) {
		this.createTaskId = options.createTaskId ?? (() => crypto.randomUUID().replace(/-/gu, ""));
		this.todayIso = options.todayIso ?? localTodayIso;
	}

	async searchVault(query: string, limit: number): Promise<unknown> {
		const needle = query.toLocaleLowerCase();
		const matches: Array<{ path: string; line: number; excerpt: string }> = [];
		for (const file of this.options.app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(".gtd-flow/") || file.path.startsWith(".obsidian/")) continue;
			const content = await this.options.app.vault.cachedRead(file);
			for (const [index, line] of content.split(/\r?\n/u).entries()) {
				const position = line.toLocaleLowerCase().indexOf(needle);
				if (position < 0) continue;
				matches.push({
					path: file.path,
					line: index,
					excerpt: boundedExcerpt(line, position, query.length),
				});
				if (matches.length >= limit) return matches;
			}
		}
		return matches;
	}

	async readNote(path: string, startLine: number, maxLines: number): Promise<unknown> {
		const file = this.options.app.vault.getFileByPath(path);
		if (file === null) return { found: false };
		const lines = (await this.options.app.vault.cachedRead(file)).split(/\r?\n/u);
		return {
			found: true,
			path: file.path,
			startLine,
			lines: lines.slice(startLine, startLine + maxLines),
		};
	}

	async listTasks(query: string | null, limit: number): Promise<unknown> {
		const needle = query?.toLocaleLowerCase() ?? null;
		return this.options
			.allTasks()
			.filter(
				(task) => needle === null || task.description.toLocaleLowerCase().includes(needle),
			)
			.slice(0, limit)
			.map(publicTask);
	}

	async getTask(taskId: string): Promise<unknown> {
		const task = this.findTask(taskId);
		return task === null ? { found: false } : { found: true, task: publicTask(task) };
	}

	async getTaskRelationships(taskId: string): Promise<unknown> {
		const task = this.requiredTask(taskId);
		const dependents = this.options
			.allTasks()
			.filter((candidate) => candidate.dependsOn.includes(taskId))
			.slice(0, 100)
			.map((candidate) => ({
				taskId: candidate.taskId,
				description: candidate.description.slice(0, 200),
				filePath: candidate.filePath,
			}));
		return {
			taskId,
			dependsOn: task.dependsOn.slice(0, 100),
			dependents,
			spawnedFrom: task.spawnedFrom,
			parentLine: task.parentLine,
		};
	}

	async listProjects(limit: number): Promise<unknown> {
		return (this.options.projects?.discoverProjects() ?? []).slice(0, limit);
	}

	async getProject(path: string): Promise<unknown> {
		const model = this.options.projects?.model(path) ?? null;
		if (model === null) return { found: false };
		return {
			found: true,
			path,
			nodes: model.nodes.slice(0, 200).map((node) => ({
				id: node.id,
				title: node.task?.description.slice(0, 200) ?? null,
				state: node.state,
				ghost: node.ghost,
			})),
			edges: model.edges.slice(0, 400),
			issues: model.issues.slice(0, 100),
		};
	}

	async listBoards(limit: number): Promise<unknown> {
		return (this.options.boards?.discoverBoards().boards ?? [])
			.slice(0, limit)
			.map(({ path, def }) => ({
				path,
				id: def.id,
				name: def.name,
				scope: def.scope ?? null,
				columns: def.columns.map(({ id, name, match }) => ({ id, name, match })),
			}));
	}

	async getBoard(path: string): Promise<unknown> {
		const board = this.options.boards
			?.discoverBoards()
			.boards.find((candidate) => candidate.path === path);
		if (!board || !this.options.boards) return { found: false };
		const model = this.options.boards.boardModel(path, board.def);
		return {
			found: true,
			path,
			id: board.def.id,
			name: board.def.name,
			columns: model.columns.map((column) => ({
				id: column.id,
				name: column.name,
				taskIds: column.tasks
					.map((task) => task.taskId)
					.filter((id): id is string => id !== null)
					.slice(0, 200),
			})),
		};
	}

	async listScopes(): Promise<unknown> {
		return this.options.scopeCatalog?.() ?? { schemaVersion: 1, scopes: [] };
	}

	async getCurrentAiRun(): Promise<unknown> {
		return (await this.options.currentRun?.()) ?? { found: false };
	}

	async connectDependency(
		input: {
			projectPath: string;
			prerequisiteTaskId: string;
			dependentTaskId: string;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const projects = this.requiredProjects();
		const existed =
			projects
				.model(input.projectPath)
				?.edges.some(
					(edge) =>
						edge.from === input.prerequisiteTaskId && edge.to === input.dependentTaskId,
				) ?? false;
		throwIfToolAborted(context);
		const result = await projects.connect(
			input.projectPath,
			input.prerequisiteTaskId,
			input.dependentTaskId,
		);
		if (!result.ok) throw new Error(`dependency-connect-failed:${result.reason ?? "unknown"}`);
		return {
			value: { connected: true, alreadyExisted: existed },
			undo: async () => {
				if (existed) return;
				const undone = await projects.disconnect(
					input.projectPath,
					input.prerequisiteTaskId,
					input.dependentTaskId,
				);
				if (!undone.ok) throw new Error("dependency-connect-undo-failed");
			},
		};
	}

	async disconnectDependency(
		input: {
			projectPath: string;
			prerequisiteTaskId: string;
			dependentTaskId: string;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const projects = this.requiredProjects();
		const existed =
			projects
				.model(input.projectPath)
				?.edges.some(
					(edge) =>
						edge.from === input.prerequisiteTaskId && edge.to === input.dependentTaskId,
				) ?? false;
		throwIfToolAborted(context);
		const result = await projects.disconnect(
			input.projectPath,
			input.prerequisiteTaskId,
			input.dependentTaskId,
		);
		if (!result.ok)
			throw new Error(`dependency-disconnect-failed:${result.reason ?? "unknown"}`);
		return {
			value: { disconnected: true, previouslyExisted: existed },
			undo: async () => {
				if (!existed) return;
				const undone = await projects.connect(
					input.projectPath,
					input.prerequisiteTaskId,
					input.dependentTaskId,
				);
				if (!undone.ok) throw new Error("dependency-disconnect-undo-failed");
			},
		};
	}

	async setProjectStatus(
		input: {
			projectPath: string;
			status: ProjectStatus;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const projects = this.requiredProjects();
		const previous = this.requiredProject(input.projectPath);
		const changed = previous.status !== input.status;
		if (changed) {
			throwIfToolAborted(context);
			await projects.setProjectStatus(input.projectPath, input.status);
		}
		return {
			value: {
				projectPath: input.projectPath,
				previousStatus: previous.status,
				status: input.status,
				changed,
			},
			undo: async () => {
				if (!changed) return;
				const current = this.requiredProject(input.projectPath);
				if (current.status !== input.status)
					throw new Error("project-status-undo-conflict");
				await projects.setProjectStatus(input.projectPath, previous.status);
			},
		};
	}

	async moveBoardTask(
		input: {
			boardPath: string;
			taskId: string;
			toColumnId: string;
			toIndex: number;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const boards = this.requiredBoards();
		const board = this.requiredBoard(input.boardPath);
		this.assertBoardIsBounded(board);
		const task = this.requiredUniqueTask(input.taskId);
		const model = boards.boardModel(input.boardPath, board.def);
		const target = model.columns.find((column) => column.id === input.toColumnId);
		if (!target) throw new Error("board-column-not-found");
		if (input.toIndex > target.tasks.length) throw new Error("board-position-out-of-range");

		const occurrences = model.columns.flatMap((column) =>
			column.tasks
				.map((candidate, index) => ({ column, task: candidate, index }))
				.filter((entry) => entry.task.taskId === input.taskId),
		);
		if (occurrences.length !== 1 || occurrences[0]!.task.key !== task.key) {
			throw new Error("board-task-safe-inverse-unavailable");
		}
		const original = occurrences[0]!;
		const affectedColumnIds = [...new Set([original.column.id, input.toColumnId])];
		const originalOrders = new Map<string, string[]>();
		const expectedOrders = new Map<string, string[]>();
		const originalMatches = new Map<string, string>();
		for (const columnId of affectedColumnIds) {
			const column = board.def.columns.find((candidate) => candidate.id === columnId);
			if (!column) throw new Error("board-task-safe-inverse-unavailable");
			const order = board.def.order[columnId] ?? [];
			if (order.length > MAX_BOARD_ORDER_IDS)
				throw new Error("board-task-safe-inverse-unavailable");
			originalOrders.set(columnId, [...order]);
			expectedOrders.set(columnId, [...order]);
			originalMatches.set(columnId, column.match);
		}
		expectedOrders.set(
			input.toColumnId,
			insertIntoColumnOrder(target.tasks, input.taskId, input.toIndex),
		);

		throwIfToolAborted(context);
		const result = await boards.moveCard(
			input.boardPath,
			board.def,
			task.key,
			input.toColumnId,
			input.toIndex,
		);
		if (!result.ok) throw new Error(`board-task-move-failed:${result.reason ?? "unknown"}`);

		return {
			value: {
				boardPath: input.boardPath,
				taskId: input.taskId,
				fromColumnId: original.column.id,
				fromIndex: original.index,
				toColumnId: input.toColumnId,
				toIndex: input.toIndex,
			},
			undo: async () => {
				const currentBoard = this.requiredBoard(input.boardPath);
				this.assertBoardIsBounded(currentBoard);
				for (const [columnId, originalMatch] of originalMatches) {
					const currentColumn = currentBoard.def.columns.find(
						(candidate) => candidate.id === columnId,
					);
					if (!currentColumn || currentColumn.match !== originalMatch)
						throw new Error("board-task-undo-conflict");
					if (
						!sameStrings(
							currentBoard.def.order[columnId] ?? [],
							expectedOrders.get(columnId)!,
						)
					) {
						throw new Error("board-task-undo-conflict");
					}
				}
				const currentTask = this.requiredUniqueTask(input.taskId);
				const currentModel = boards.boardModel(input.boardPath, currentBoard.def);
				const currentOccurrences = currentModel.columns.flatMap((column) =>
					column.tasks
						.map((candidate) => ({ columnId: column.id, task: candidate }))
						.filter((entry) => entry.task.taskId === input.taskId),
				);
				if (
					currentOccurrences.length !== 1 ||
					currentOccurrences[0]!.task.key !== currentTask.key ||
					currentOccurrences[0]!.columnId !== input.toColumnId
				) {
					throw new Error("board-task-undo-conflict");
				}
				if (original.column.id === input.toColumnId) {
					await boards.reorderCard(
						input.boardPath,
						original.column.id,
						originalOrders.get(original.column.id)!,
					);
					return;
				}
				const undone = await boards.moveCard(
					input.boardPath,
					currentBoard.def,
					currentTask.key,
					original.column.id,
					original.index,
				);
				if (!undone.ok)
					throw new Error(`board-task-undo-failed:${undone.reason ?? "unknown"}`);
				for (const [columnId, order] of originalOrders) {
					await boards.reorderCard(input.boardPath, columnId, order);
				}
			},
		};
	}

	async renameBoard(
		input: { boardPath: string; name: string },
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const boards = this.requiredBoards();
		const board = this.requiredBoard(input.boardPath);
		const name = input.name.trim();
		const previousName = board.def.name;
		const changed = previousName !== name;
		if (changed) {
			throwIfToolAborted(context);
			const result = await boards.renameBoard(input.boardPath, name);
			if (!result.ok) throw new Error(`board-rename-failed:${result.reason ?? "unknown"}`);
		}
		return {
			value: { boardPath: input.boardPath, previousName, name, changed },
			undo: async () => {
				if (!changed) return;
				const current = this.requiredBoard(input.boardPath);
				if (current.def.name !== name) throw new Error("board-rename-undo-conflict");
				const result = await boards.renameBoard(input.boardPath, previousName);
				if (!result.ok) throw new Error("board-rename-undo-failed");
			},
		};
	}

	async renameBoardColumn(
		input: {
			boardPath: string;
			columnId: string;
			name: string;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const boards = this.requiredBoards();
		const board = this.requiredBoard(input.boardPath);
		const column = board.def.columns.find((candidate) => candidate.id === input.columnId);
		if (!column) throw new Error("board-column-not-found");
		const name = input.name.trim();
		const previousName = column.name;
		const originalMatch = column.match;
		const changed = previousName !== name;
		if (changed) {
			throwIfToolAborted(context);
			const result = await boards.renameColumn(input.boardPath, input.columnId, name);
			if (!result.ok)
				throw new Error(`board-column-rename-failed:${result.reason ?? "unknown"}`);
		}
		return {
			value: {
				boardPath: input.boardPath,
				columnId: input.columnId,
				previousName,
				name,
				changed,
			},
			undo: async () => {
				if (!changed) return;
				const current = this.requiredBoard(input.boardPath).def.columns.find(
					(candidate) => candidate.id === input.columnId,
				);
				if (!current || current.name !== name || current.match !== originalMatch)
					throw new Error("board-column-rename-undo-conflict");
				const result = await boards.renameColumn(
					input.boardPath,
					input.columnId,
					previousName,
				);
				if (!result.ok) throw new Error("board-column-rename-undo-failed");
			},
		};
	}

	async moveBoardColumn(
		input: {
			boardPath: string;
			columnId: string;
			direction: "left" | "right";
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const boards = this.requiredBoards();
		const board = this.requiredBoard(input.boardPath);
		this.assertBoardIsBounded(board);
		const originalOrder = board.def.columns.map((column) => column.id);
		const fromIndex = originalOrder.indexOf(input.columnId);
		if (fromIndex < 0) throw new Error("board-column-not-found");
		const direction = input.direction === "left" ? -1 : 1;
		const toIndex = fromIndex + direction;
		const changed = toIndex >= 0 && toIndex < originalOrder.length;
		const expectedOrder = [...originalOrder];
		if (changed) {
			throwIfToolAborted(context);
			[expectedOrder[fromIndex], expectedOrder[toIndex]] = [
				expectedOrder[toIndex]!,
				expectedOrder[fromIndex]!,
			];
			const result = await boards.moveColumn(input.boardPath, input.columnId, direction);
			if (!result.ok)
				throw new Error(`board-column-move-failed:${result.reason ?? "unknown"}`);
		}
		return {
			value: {
				boardPath: input.boardPath,
				columnId: input.columnId,
				fromIndex,
				toIndex: changed ? toIndex : fromIndex,
				changed,
			},
			undo: async () => {
				if (!changed) return;
				const currentOrder = this.requiredBoard(input.boardPath).def.columns.map(
					(column) => column.id,
				);
				if (!sameStrings(currentOrder, expectedOrder))
					throw new Error("board-column-move-undo-conflict");
				const result = await boards.moveColumn(
					input.boardPath,
					input.columnId,
					direction === -1 ? 1 : -1,
				);
				if (!result.ok) throw new Error("board-column-move-undo-failed");
			},
		};
	}

	async deleteProjectNode(input: {
		projectPath: string;
		nodeId: string;
	}): Promise<{ value: unknown }> {
		const projects = this.requiredProjects();
		const model = projects.model(input.projectPath);
		if (model === null) throw new Error("project-not-found");
		const matches = model.nodes.filter((node) => !node.ghost && node.id === input.nodeId);
		if (matches.length !== 1) throw new Error("project-node-not-found-or-ambiguous");
		const result = await projects.deleteNode(input.projectPath, input.nodeId);
		if (!result.ok) throw new Error(`project-node-delete-failed:${result.reason ?? "unknown"}`);
		return {
			value: {
				projectPath: input.projectPath,
				nodeId: input.nodeId,
				deleted: true,
				unblocked: result.unblocked ?? 0,
			},
		};
	}

	async deleteBoardColumn(input: {
		boardPath: string;
		columnId: string;
	}): Promise<{ value: unknown }> {
		const boards = this.requiredBoards();
		const board = this.requiredBoard(input.boardPath);
		if (!board.def.columns.some((column) => column.id === input.columnId))
			throw new Error("board-column-not-found");
		if (board.def.columns.length <= 1) throw new Error("cannot-delete-last-board-column");
		const result = await boards.deleteColumn(input.boardPath, input.columnId);
		if (!result.ok) throw new Error(`board-column-delete-failed:${result.reason ?? "unknown"}`);
		return {
			value: {
				boardPath: input.boardPath,
				columnId: input.columnId,
				deleted: true,
			},
		};
	}

	async createProject(input: { projectPath: string; name: string }): Promise<{ value: unknown }> {
		const projects = this.requiredProjects();
		const alreadyExisted = projects
			.discoverProjects()
			.some((project) => project.path === input.projectPath);
		const result = await projects.createProject(input.projectPath, input.name.trim());
		if (!result.ok) throw new Error(`project-create-failed:${result.reason ?? "unknown"}`);
		return {
			value: {
				projectPath: result.path ?? input.projectPath,
				created: !alreadyExisted,
				alreadyExisted,
			},
		};
	}

	async createBoard(input: { boardPath: string; name: string }): Promise<{ value: unknown }> {
		const boards = this.requiredBoards();
		const discovery = boards.discoverBoards();
		const alreadyExisted =
			discovery.boards.some((board) => board.path === input.boardPath) ||
			discovery.errors.some((error) => error.path === input.boardPath);
		const result = await boards.createBoard(input.boardPath, input.name.trim());
		if (!result.ok) throw new Error(`board-create-failed:${result.reason ?? "unknown"}`);
		return {
			value: {
				boardPath: result.path ?? input.boardPath,
				created: !alreadyExisted,
				alreadyExisted,
			},
		};
	}

	async createTask(
		input: { text: string; inbox: boolean },
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		if (!input.inbox) throw new Error("only-unified-inbox-creation-supported");
		const path = this.options.inboxFile();
		if (path.trim() === "") throw new Error("inbox-file-required");
		await this.options.ensureInbox(path);
		throwIfToolAborted(context);
		const taskId = safeTaskId(this.createTaskId());
		const text = input.text.replace(/\r?\n/gu, " ").trim();
		const line = `- [ ] ${text} 🆔 ${taskId}`;
		const changed = await this.options.vault.processFile(path, (content) =>
			appendLine(content, line),
		);
		if (!changed) throw new Error("task-create-failed");
		return {
			value: { taskId, path },
			undo: async () => {
				const undone = await this.options.vault.processFile(path, (content) =>
					removeUnchangedTaskById(content, path, taskId, line),
				);
				if (!undone) throw new Error("task-create-undo-conflict");
			},
		};
	}

	async updateTask(
		input: {
			taskId: string;
			text?: string;
			status?: TaskStatus;
			due?: string | null;
			scheduled?: string | null;
			start?: string | null;
			priority?: Priority;
			location?: string | null;
			durationMinutes?: number | null;
			cognitiveIntensity?: number | null;
			emotionalIntensity?: number | null;
			physicalIntensity?: number | null;
			scopeId?: string | null;
		},
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const task = this.requiredTask(input.taskId);
		if (
			input.scopeId !== undefined &&
			input.scopeId !== null &&
			!this.options.isActiveScope(input.scopeId)
		) {
			throw new Error("scope-not-active");
		}
		const key = task.key;
		const intents: Array<Intent & { key: string }> = [];
		if (input.text !== undefined) intents.push({ type: "set-text", key, text: input.text });
		const dateUpdates: Partial<Record<TaskDateField, ParsedTaskDateTime | null>> = {};
		for (const field of TASK_DATE_FIELDS) {
			const value = input[field];
			if (value === undefined) continue;
			const parsed = value === null ? null : parseTaskDateTime(value);
			dateUpdates[field] = parsed;
			intents.push({
				type: "set-date",
				key,
				field,
				date: parsed?.date ?? null,
				...(parsed === null ? {} : { time: parsed.time, timeEnd: parsed.timeEnd }),
			});
		}
		if (input.priority !== undefined) {
			intents.push({
				type: "set-priority",
				key,
				priority: validatePriority(input.priority),
			});
		}
		const normalizedLocation =
			input.location === undefined ? undefined : input.location?.trim() || null;
		if (normalizedLocation !== undefined) {
			intents.push({ type: "set-location", key, location: normalizedLocation });
		}
		const metadata = metadataIntent(input, key);
		const ownershipPatch = metadata === null ? null : ownershipPatchFromMetadata(metadata);
		if (ownershipPatch !== null) {
			await this.options.assertAiPatchAllowed?.(input.taskId, ownershipPatch);
			throwIfToolAborted(context);
		}
		const prepared =
			ownershipPatch === null
				? undefined
				: await this.options.prepareAiMetadataMutation?.(task, ownershipPatch, context);
		if (metadata !== null) intents.push(metadata);
		const statusUpdate =
			input.status === undefined
				? null
				: statusIntent(input.status, key, validateIsoDate(this.todayIso()));
		if (statusUpdate !== null) intents.push(statusUpdate);
		if (intents.length === 0) throw new Error("task-update-empty");
		let cancelExpected: void | (() => void) | undefined;
		try {
			throwIfToolAborted(context);
			cancelExpected =
				ownershipPatch === null
					? undefined
					: this.options.expectAiPatch?.(input.taskId, ownershipPatch);
		} catch (error: unknown) {
			await cancelPreparedMutation(prepared);
			throw error;
		}
		let result;
		try {
			throwIfToolAborted(context);
			result =
				intents.length === 1
					? await this.options.dispatcher.dispatch(intents[0]!)
					: await this.options.dispatcher.dispatchMany(intents);
		} catch (error: unknown) {
			if (typeof cancelExpected === "function") cancelExpected();
			await cancelPreparedMutation(prepared);
			throw error;
		}
		if (!result.ok) {
			if (typeof cancelExpected === "function") cancelExpected();
			await cancelPreparedMutation(prepared);
			throw new Error("task-update-failed");
		}
		await commitPreparedMutation(prepared);

		const inverse: Array<Intent & { key: string }> = [];
		const stableKey = `id:${input.taskId}`;
		if (input.text !== undefined)
			inverse.push({ type: "set-text", key: stableKey, text: task.description });
		for (const field of TASK_DATE_FIELDS) {
			if (dateUpdates[field] === undefined) continue;
			inverse.push(originalDateIntent(task, field, stableKey));
		}
		if (input.priority !== undefined) {
			inverse.push({ type: "set-priority", key: stableKey, priority: task.priority });
		}
		if (normalizedLocation !== undefined) {
			inverse.push({ type: "set-location", key: stableKey, location: task.location });
		}
		if (metadata !== null) {
			inverse.push({
				type: "patch-task-metadata",
				key: stableKey,
				...(input.durationMinutes !== undefined
					? { durationMinutes: task.durationMinutes }
					: {}),
				...(input.cognitiveIntensity !== undefined
					? { cognitiveIntensity: task.cognitiveIntensity }
					: {}),
				...(input.emotionalIntensity !== undefined
					? { emotionalIntensity: task.emotionalIntensity }
					: {}),
				...(input.physicalIntensity !== undefined
					? { physicalIntensity: task.physicalIntensity }
					: {}),
				...(input.scopeId !== undefined ? { scopeId: task.scopeId } : {}),
			});
		}
		if (statusUpdate !== null) inverse.push(originalStatusIntent(task, stableKey));
		return {
			value: { taskId: input.taskId, updated: true },
			undo: async () => {
				const current = await this.readTaskFromFile(task.filePath, input.taskId);
				if (
					current === null ||
					(input.text !== undefined && current.description !== input.text.trim()) ||
					!taskMatchesDateUpdates(current, dateUpdates) ||
					(input.priority !== undefined && current.priority !== input.priority) ||
					(normalizedLocation !== undefined && current.location !== normalizedLocation) ||
					(metadata !== null && !taskMatchesMetadata(current, metadata)) ||
					(statusUpdate !== null &&
						!taskMatchesStatus(current, input.status!, statusUpdate.date))
				) {
					throw new Error("task-undo-conflict");
				}
				const undone =
					inverse.length === 1
						? await this.options.dispatcher.dispatch(inverse[0]!)
						: await this.options.dispatcher.dispatchMany(inverse);
				if (!undone.ok) throw new Error("task-undo-failed");
			},
		};
	}

	async moveTask(
		input: { taskId: string; toFile: string },
		context?: ToolExecutionContext,
	): Promise<UndoableValue> {
		throwIfToolAborted(context);
		const task = this.requiredTask(input.taskId);
		await this.options.vault.ensureFile(input.toFile);
		throwIfToolAborted(context);
		const result = await this.options.dispatcher.dispatch({
			type: "move-line",
			key: task.key,
			toFile: input.toFile,
		});
		if (!result.ok) throw new Error("task-move-failed");
		return {
			value: { taskId: input.taskId, fromFile: task.filePath, toFile: input.toFile },
			undo: async () => {
				if ((await this.readTaskFromFile(input.toFile, input.taskId)) === null) {
					throw new Error("task-move-undo-conflict");
				}
				const undo = await this.options.dispatcher.dispatch({
					type: "move-line",
					key: `id:${input.taskId}`,
					toFile: task.filePath,
				});
				if (!undo.ok) throw new Error("task-move-undo-failed");
			},
		};
	}

	async deleteTask(input: { taskId: string }): Promise<{ value: unknown }> {
		const task = this.requiredTask(input.taskId);
		const result = await this.options.dispatcher.dispatch({
			type: "delete-line",
			key: task.key,
			withChildren: true,
		});
		if (!result.ok) throw new Error("task-delete-failed");
		return { value: { taskId: input.taskId, deleted: true } };
	}

	async deleteFile(input: { path: string }): Promise<{ value: unknown }> {
		if (!isVaultRelativePath(input.path)) throw new Error("vault-file-path-rejected");
		const file = this.options.app.vault.getFileByPath(input.path);
		if (file === null) throw new Error("vault-file-not-found");
		await this.options.app.vault.delete(file, true);
		return { value: { path: input.path, deleted: true } };
	}

	async bulkUpdateTasks(
		input: {
			taskIds: string[];
			scopeId: string;
		},
		context?: ToolExecutionContext,
	): Promise<{ value: unknown }> {
		throwIfToolAborted(context);
		if (!this.options.isActiveScope(input.scopeId)) throw new Error("scope-not-active");
		if (new Set(input.taskIds).size !== input.taskIds.length) {
			throw new Error("bulk-task-ids-duplicate");
		}
		const patch: EstimateOwnershipPatch = { scope: input.scopeId };
		// Resolve and authorize the complete target set before registering any
		// expectations or mutating Markdown. This prevents a later locked or
		// ambiguous target from turning an approved bulk operation into a partial
		// overwrite of earlier tasks.
		const targets = input.taskIds.map((taskId) => ({
			taskId,
			task: this.requiredUniqueTask(taskId),
		}));
		for (const target of targets) {
			await this.options.assertAiPatchAllowed?.(target.taskId, patch);
			throwIfToolAborted(context);
		}

		const prepared: Array<PreparedAiMetadataMutation | undefined> = [];
		try {
			for (const target of targets) {
				prepared.push(
					await this.options.prepareAiMetadataMutation?.(target.task, patch, context),
				);
				throwIfToolAborted(context);
			}
		} catch (error: unknown) {
			await cancelPreparedMutations(prepared, 0);
			throw error;
		}

		const expectations: Array<void | (() => void) | undefined> = [];
		try {
			throwIfToolAborted(context);
			for (const target of targets) {
				expectations.push(this.options.expectAiPatch?.(target.taskId, patch));
			}
		} catch (error: unknown) {
			cancelExpectations(expectations, 0);
			await cancelPreparedMutations(prepared, 0);
			throw error;
		}

		const results: Array<{ taskId: string; ok: boolean }> = [];
		for (const [index, target] of targets.entries()) {
			try {
				throwIfToolAborted(context);
				const result = await this.options.dispatcher.dispatch({
					type: "patch-task-metadata",
					key: target.task.key,
					scopeId: input.scopeId,
				});
				results.push({ taskId: target.taskId, ok: result.ok });
				if (!result.ok) {
					// Keep expectations for acknowledged earlier writes so the index
					// recognizes them as AI mutations. Remove the failed and untouched
					// registrations: they cannot legitimately match a later edit.
					cancelExpectations(expectations, index);
					await cancelPreparedMutations(prepared, index);
					break;
				}
				await commitPreparedMutation(prepared[index]);
			} catch (error: unknown) {
				cancelExpectations(expectations, index);
				await cancelPreparedMutations(prepared, index);
				throw error;
			}
		}
		return { value: { results } };
	}

	private findTask(taskId: string): Task | null {
		return this.options.allTasks().find((task) => task.taskId === taskId) ?? null;
	}

	private requiredTask(taskId: string): Task {
		return this.requiredUniqueTask(taskId);
	}

	private async readTaskFromFile(path: string, taskId: string): Promise<Task | null> {
		const content = await this.options.vault.readFile(path);
		if (content === null) return null;
		let found: Task | null = null;
		for (const [lineStart, line] of content.split(/\r?\n/u).entries()) {
			const parsed = parseTaskLine(line, {
				filePath: path,
				lineStart,
				parentLine: null,
				heading: null,
				container: "inbox",
				projectActive: false,
			});
			if (parsed?.taskId !== taskId) continue;
			if (found !== null) return null;
			found = parsed;
		}
		return found;
	}

	private requiredUniqueTask(taskId: string): Task {
		const matches = this.options.allTasks().filter((task) => task.taskId === taskId);
		if (matches.length === 0) throw new Error("task-not-found");
		if (matches.length > 1) throw new Error("task-id-ambiguous");
		return matches[0]!;
	}

	private requiredProjects(): NonNullable<GtdToolPortsAdapterOptions["projects"]> {
		if (!this.options.projects) throw new Error("project-service-unavailable");
		return this.options.projects;
	}

	private requiredProject(path: string): ProjectSummary {
		const project = this.requiredProjects()
			.discoverProjects()
			.find((candidate) => candidate.path === path);
		if (!project) throw new Error("project-not-found");
		return project;
	}

	private requiredBoards(): NonNullable<GtdToolPortsAdapterOptions["boards"]> {
		if (!this.options.boards) throw new Error("board-service-unavailable");
		return this.options.boards;
	}

	private requiredBoard(path: string): DiscoveredBoard {
		const board = this.requiredBoards()
			.discoverBoards()
			.boards.find((candidate) => candidate.path === path);
		if (!board) throw new Error("board-not-found");
		return board;
	}

	private assertBoardIsBounded(board: DiscoveredBoard): void {
		if (board.def.columns.length > MAX_BOARD_COLUMNS)
			throw new Error("board-safe-inverse-limit-exceeded");
		for (const column of board.def.columns) {
			if ((board.def.order[column.id]?.length ?? 0) > MAX_BOARD_ORDER_IDS)
				throw new Error("board-safe-inverse-limit-exceeded");
		}
		const model = this.requiredBoards().boardModel(board.path, board.def);
		if (model.columns.some((column) => column.tasks.length > MAX_BOARD_TASKS_PER_COLUMN))
			throw new Error("board-safe-inverse-limit-exceeded");
	}
}

function metadataIntent(
	input: {
		durationMinutes?: number | null;
		cognitiveIntensity?: number | null;
		emotionalIntensity?: number | null;
		physicalIntensity?: number | null;
		scopeId?: string | null;
	},
	key: string,
): PatchTaskMetadata | null {
	if (
		input.durationMinutes === undefined &&
		input.cognitiveIntensity === undefined &&
		input.emotionalIntensity === undefined &&
		input.physicalIntensity === undefined &&
		input.scopeId === undefined
	) {
		return null;
	}
	const durationMinutes = validateDuration(input.durationMinutes);
	const cognitiveIntensity = validateIntensity(input.cognitiveIntensity);
	const emotionalIntensity = validateIntensity(input.emotionalIntensity);
	const physicalIntensity = validateIntensity(input.physicalIntensity);
	if (input.scopeId !== undefined && input.scopeId !== null && !isScopeId(input.scopeId)) {
		throw new Error("invalid-scope-id");
	}
	return {
		type: "patch-task-metadata",
		key,
		...(input.durationMinutes !== undefined ? { durationMinutes } : {}),
		...(input.cognitiveIntensity !== undefined ? { cognitiveIntensity } : {}),
		...(input.emotionalIntensity !== undefined ? { emotionalIntensity } : {}),
		...(input.physicalIntensity !== undefined ? { physicalIntensity } : {}),
		...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
	};
}

/** Best-effort cleanup of monitor registrations that have no acknowledged write. */
function cancelExpectations(
	expectations: readonly (void | (() => void) | undefined)[],
	start: number,
): void {
	for (const cancel of expectations.slice(start)) {
		try {
			if (typeof cancel === "function") cancel();
		} catch {
			// A monitor cleanup failure must not conceal the original rejected or
			// failed write. Production monitor cancellations are synchronous/no-throw.
		}
	}
}

function throwIfToolAborted(context: ToolExecutionContext | undefined): void {
	if (!context?.signal?.aborted) return;
	const error = new Error("tool-writeback-aborted");
	error.name = "AbortError";
	throw error;
}

async function commitPreparedMutation(
	prepared: PreparedAiMetadataMutation | undefined,
): Promise<void> {
	if (prepared === undefined) return;
	try {
		await prepared.commit();
	} catch (error: unknown) {
		// Markdown already changed. Keep the durable prepared record so startup
		// recovery can publish it; never report a false tool-write failure.
		console.warn("GTD Flow: AI tool feedback commit deferred", errorName(error));
	}
}

async function cancelPreparedMutation(
	prepared: PreparedAiMetadataMutation | undefined,
): Promise<void> {
	if (prepared === undefined) return;
	try {
		await prepared.cancel();
	} catch {
		// Unchanged Markdown lets startup recovery cancel this record safely.
	}
}

async function cancelPreparedMutations(
	prepared: readonly (PreparedAiMetadataMutation | undefined)[],
	start: number,
): Promise<void> {
	for (const mutation of prepared.slice(start)) {
		await cancelPreparedMutation(mutation);
	}
}

function ownershipPatchFromMetadata(metadata: PatchTaskMetadata): EstimateOwnershipPatch {
	return {
		...(metadata.durationMinutes !== undefined ? { duration: metadata.durationMinutes } : {}),
		...(metadata.cognitiveIntensity !== undefined
			? { cognitive: metadata.cognitiveIntensity }
			: {}),
		...(metadata.emotionalIntensity !== undefined
			? { emotional: metadata.emotionalIntensity }
			: {}),
		...(metadata.physicalIntensity !== undefined
			? { physical: metadata.physicalIntensity }
			: {}),
		...(metadata.scopeId !== undefined ? { scope: metadata.scopeId } : {}),
	};
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "UnknownError";
}

function taskMatchesMetadata(task: Task, metadata: PatchTaskMetadata): boolean {
	return (
		(metadata.durationMinutes === undefined ||
			task.durationMinutes === metadata.durationMinutes) &&
		(metadata.cognitiveIntensity === undefined ||
			task.cognitiveIntensity === metadata.cognitiveIntensity) &&
		(metadata.emotionalIntensity === undefined ||
			task.emotionalIntensity === metadata.emotionalIntensity) &&
		(metadata.physicalIntensity === undefined ||
			task.physicalIntensity === metadata.physicalIntensity) &&
		(metadata.scopeId === undefined || task.scopeId === metadata.scopeId)
	);
}

const TASK_DATE_FIELDS: readonly TaskDateField[] = ["due", "scheduled", "start"];
const PRIORITIES: ReadonlySet<Priority> = new Set([
	"highest",
	"high",
	"medium",
	"low",
	"lowest",
	"none",
]);

function parseTaskDateTime(value: string): ParsedTaskDateTime {
	const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](.*))?$/u.exec(value.trim());
	if (match === null) throw new Error("invalid-task-date-time");
	const date = validateIsoDate(match[1]!);
	if (match[2] === undefined) return { date, time: null, timeEnd: null };
	const parts = match[2].split("-");
	if (parts.length < 1 || parts.length > 2) throw new Error("invalid-task-date-time");
	const [time, timeEnd] = parts;
	if (time === undefined || !isClockTime(time)) throw new Error("invalid-task-date-time");
	if (timeEnd !== undefined && (!isClockTime(timeEnd) || timeEnd <= time)) {
		throw new Error("invalid-task-date-time");
	}
	return { date, time, timeEnd: timeEnd ?? null };
}

function validateIsoDate(value: string): IsoDate {
	const normalized = value.trim();
	if (parseDatePayload(normalized).kind !== "date") throw new Error("invalid-task-date");
	return normalized;
}

function isClockTime(value: string): boolean {
	return /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function validatePriority(value: Priority): Priority {
	if (!PRIORITIES.has(value)) throw new Error("invalid-task-priority");
	return value;
}

function statusIntent(status: TaskStatus, key: string, today: IsoDate): SetStatusIntent {
	switch (status) {
		case "open":
			return { type: "set-status", key, statusChar: " " };
		case "done":
			return { type: "set-status", key, statusChar: "x", date: today };
		case "cancelled":
			return { type: "set-status", key, statusChar: "-", date: today };
	}
}

function originalStatusIntent(task: Task, key: string): SetStatusIntent {
	const date =
		task.statusChar === "x" || task.statusChar === "X"
			? task.done
			: task.statusChar === "-"
				? task.cancelled
				: null;
	return {
		type: "set-status",
		key,
		statusChar: task.statusChar,
		...(date === null ? {} : { date }),
	};
}

function originalDateIntent(task: Task, field: TaskDateField, key: string): SetDateIntent {
	switch (field) {
		case "due":
			return {
				type: "set-date",
				key,
				field,
				date: task.due,
				time: task.dueTime,
				timeEnd: task.dueTimeEnd,
			};
		case "scheduled":
			return {
				type: "set-date",
				key,
				field,
				date: task.scheduled,
				time: task.scheduledTime,
				timeEnd: task.scheduledTimeEnd,
			};
		case "start":
			return {
				type: "set-date",
				key,
				field,
				date: task.start,
				time: task.startTime,
				timeEnd: task.startTimeEnd,
			};
	}
}

function taskMatchesDateUpdates(
	task: Task,
	updates: Partial<Record<TaskDateField, ParsedTaskDateTime | null>>,
): boolean {
	for (const field of TASK_DATE_FIELDS) {
		const expected = updates[field];
		if (expected === undefined) continue;
		switch (field) {
			case "due":
				if (
					task.due !== (expected?.date ?? null) ||
					task.dueTime !== (expected?.time ?? null) ||
					task.dueTimeEnd !== (expected?.timeEnd ?? null)
				)
					return false;
				break;
			case "scheduled":
				if (
					task.scheduled !== (expected?.date ?? null) ||
					task.scheduledTime !== (expected?.time ?? null) ||
					task.scheduledTimeEnd !== (expected?.timeEnd ?? null)
				)
					return false;
				break;
			case "start":
				if (
					task.start !== (expected?.date ?? null) ||
					task.startTime !== (expected?.time ?? null) ||
					task.startTimeEnd !== (expected?.timeEnd ?? null)
				)
					return false;
				break;
		}
	}
	return true;
}

function taskMatchesStatus(task: Task, status: TaskStatus, today: IsoDate | undefined): boolean {
	switch (status) {
		case "open":
			return task.statusChar === " " && task.done === null && task.cancelled === null;
		case "done":
			return task.statusChar === "x" && task.done === today && task.cancelled === null;
		case "cancelled":
			return task.statusChar === "-" && task.cancelled === today && task.done === null;
	}
}

function localTodayIso(): IsoDate {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function validateDuration(value: number | null | undefined): DurationMinutes | null | undefined {
	if (value === undefined || value === null || isDurationMinutes(value)) return value;
	throw new Error("invalid-duration");
}

function validateIntensity(value: number | null | undefined): IntensityLevel | null | undefined {
	if (value === undefined || value === null || isIntensityLevel(value)) return value;
	throw new Error("invalid-intensity");
}

function publicTask(task: Task): Record<string, unknown> {
	return {
		taskId: task.taskId,
		description: task.description,
		filePath: task.filePath,
		status: task.statusChar,
		durationMinutes: task.durationMinutes,
		cognitiveIntensity: task.cognitiveIntensity,
		emotionalIntensity: task.emotionalIntensity,
		physicalIntensity: task.physicalIntensity,
		scopeId: task.scopeId,
		due: task.due,
		scheduled: task.scheduled,
		start: task.start,
		tags: task.tags,
	};
}

function boundedExcerpt(line: string, position: number, needleLength: number): string {
	const start = Math.max(0, position - 120);
	return line.slice(start, Math.min(line.length, position + needleLength + 240));
}

function appendLine(content: string, line: string): string {
	if (content === "") return `${line}\n`;
	return `${content}${content.endsWith("\n") ? "" : "\n"}${line}\n`;
}

function removeUnchangedTaskById(
	content: string,
	path: string,
	taskId: string,
	expectedLine: string,
): string | null {
	const lines = content.split("\n");
	const index = lines.findIndex((line, lineNumber) => {
		const parsed = parseTaskLine(line, {
			filePath: path,
			lineStart: lineNumber,
			parentLine: null,
			heading: null,
			container: "inbox",
			projectActive: false,
		});
		return parsed?.taskId === taskId;
	});
	if (index < 0 || lines[index] !== expectedLine) return null;
	lines.splice(index, 1);
	return lines.join("\n");
}

function safeTaskId(value: string): string {
	const id = value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64);
	if (id === "") throw new Error("task-id-generation-failed");
	return id;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
