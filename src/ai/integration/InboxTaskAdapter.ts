import type { Task } from "../../core/model/Task";
import type { WritebackService } from "../../services/WritebackService";
import type { InboxTaskPort } from "../processing/InboxProcessor";

export interface InboxTaskAdapterOptions {
	allTasks(): readonly Task[];
	inboxFile(): string;
	dispatcher: WritebackService;
	expectAiPatch?(
		taskId: string,
		patch: Partial<
			Record<
				"duration" | "cognitive" | "emotional" | "physical" | "scope",
				number | string | null
			>
		>,
	): void | (() => void);
}

export class InboxTaskAdapter implements InboxTaskPort {
	constructor(private readonly options: InboxTaskAdapterOptions) {}

	listInboxTasks(): readonly Task[] {
		const inbox = normalizePath(this.options.inboxFile());
		return this.options
			.allTasks()
			.filter(
				(task) =>
					normalizePath(task.filePath) === inbox &&
					task.statusChar !== "x" &&
					task.statusChar !== "X" &&
					task.statusChar !== "-",
			);
	}

	listTasksByKeys(keys: readonly string[]): readonly Task[] {
		const byKey = new Map(this.options.allTasks().map((task) => [task.key, task]));
		const seen = new Set<string>();
		const tasks: Task[] = [];
		for (const key of keys) {
			if (seen.has(key)) continue;
			seen.add(key);
			const task = byKey.get(key);
			if (task !== undefined) tasks.push(task);
		}
		return tasks;
	}

	ensureTaskId(key: string) {
		return this.options.dispatcher.ensureTaskId(key);
	}

	async applyMetadata(
		key: string,
		patch: Parameters<InboxTaskPort["applyMetadata"]>[1],
		anchoredTaskId?: string,
	) {
		const taskId =
			anchoredTaskId ??
			this.options.allTasks().find((task) => task.key === key)?.taskId ??
			(key.startsWith("id:") ? key.slice(3) : null);
		const expectedPatch = {
			...(patch.durationMinutes !== undefined ? { duration: patch.durationMinutes } : {}),
			...(patch.cognitiveIntensity !== undefined
				? { cognitive: patch.cognitiveIntensity }
				: {}),
			...(patch.emotionalIntensity !== undefined
				? { emotional: patch.emotionalIntensity }
				: {}),
			...(patch.physicalIntensity !== undefined ? { physical: patch.physicalIntensity } : {}),
			...(patch.scopeId !== undefined ? { scope: patch.scopeId } : {}),
		};
		const cancelExpected =
			taskId === null ? undefined : this.options.expectAiPatch?.(taskId, expectedPatch);
		// A rejected storage call is ambiguous: the expectation intentionally
		// remains until consumed or expired so a delayed index update is not
		// mislabeled as a user edit.
		const result = await this.options.dispatcher.dispatch({
			type: "patch-task-metadata",
			key,
			...patch,
		});
		if (!result.ok && typeof cancelExpected === "function") cancelExpected();
		return result;
	}
}

function normalizePath(path: string): string {
	return path
		.trim()
		.replace(/\\/gu, "/")
		.replace(/^\/+|\/+$/gu, "");
}
