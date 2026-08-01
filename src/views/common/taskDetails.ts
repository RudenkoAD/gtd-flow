import type { EstimatePatch } from "../../core/estimates/provenance";
import type {
	SetDate,
	SetLocation,
	SetPriority,
	SetStatus,
	SetText,
} from "../../core/intents/Intent";
import type { IsoDate, Priority, Task } from "../../core/model/Task";
import { isValidIsoDate } from "../../core/recurrence/dateMath";
import { isActiveScopeId, type ScopeCatalog } from "../../core/scope/scope";
import { TIME_RE } from "../../core/parser/tokenizer";
import {
	metadataDraftFromTask,
	metadataPatchFromDraft,
	type TaskMetadataDraft,
} from "./taskMetadata";

export interface TaskDateTimeDraft {
	/** Empty means that the date field is cleared. */
	date: string;
	/** Empty, HH:mm, or HH:mm-HH:mm. */
	timeRange: string;
}

export interface TaskDetailsDraft {
	description: string;
	completed: boolean;
	priority: Priority;
	due: TaskDateTimeDraft;
	scheduled: TaskDateTimeDraft;
	start: TaskDateTimeDraft;
	location: string;
	metadata: TaskMetadataDraft;
}

export type TaskDetailsOrdinaryIntent = SetText | SetStatus | SetPriority | SetDate | SetLocation;

export interface TaskDetailsChanges {
	ordinaryIntents: TaskDetailsOrdinaryIntent[];
	metadataPatch: EstimatePatch;
}

const PRIORITIES: ReadonlySet<Priority> = new Set([
	"highest",
	"high",
	"medium",
	"low",
	"lowest",
	"none",
]);

const DATE_FIELDS = ["due", "scheduled", "start"] as const;
type EditableDateField = (typeof DATE_FIELDS)[number];

interface ParsedDateTime {
	date: IsoDate | null;
	time: string | null;
	timeEnd: string | null;
}

export function taskDetailsDraftFromTask(task: Task): TaskDetailsDraft {
	return {
		description: task.description,
		completed: task.statusChar === "x" || task.statusChar === "X",
		priority: task.priority,
		due: dateTimeDraft(task.due, task.dueTime, task.dueTimeEnd),
		scheduled: dateTimeDraft(task.scheduled, task.scheduledTime, task.scheduledTimeEnd),
		start: dateTimeDraft(task.start, task.startTime, task.startTimeEnd),
		location: task.location ?? "",
		metadata: metadataDraftFromTask(task),
	};
}

/**
 * Validate a complete editor draft and convert it to the smallest set of keyed
 * line intents plus one correlated metadata patch.
 */
export function taskDetailsChangesFromDraft(
	task: Task,
	draft: TaskDetailsDraft,
	today: IsoDate,
	catalog: ScopeCatalog,
): TaskDetailsChanges {
	const description = draft.description.trim();
	if (description === "") throw new Error("title must not be empty");
	if (typeof draft.completed !== "boolean") throw new Error("completed must be a boolean");
	if (!PRIORITIES.has(draft.priority)) throw new Error("invalid priority");

	const parsedDates = {
		due: parseDateTime("due", draft.due),
		scheduled: parseDateTime("scheduled", draft.scheduled),
		start: parseDateTime("start", draft.start),
	};
	if (parsedDates.due.date !== null && parsedDates.start.date !== null) {
		throw new Error("due and start dates cannot coexist");
	}

	validateScopeAssignment(task, draft.metadata.scopeId, catalog);
	const metadataPatch = metadataPatchFromDraft(task, draft.metadata);
	const ordinaryIntents: TaskDetailsOrdinaryIntent[] = [];

	if (description !== task.description) {
		ordinaryIntents.push({ type: "set-text", key: task.key, text: description });
	}

	const wasCompleted = task.statusChar === "x" || task.statusChar === "X";
	if (draft.completed !== wasCompleted) {
		if (draft.completed) {
			if (!isValidIsoDate(today)) throw new Error("today must be a real ISO date");
			ordinaryIntents.push({
				type: "set-status",
				key: task.key,
				statusChar: "x",
				date: today,
			});
		} else {
			ordinaryIntents.push({ type: "set-status", key: task.key, statusChar: " " });
		}
	}

	if (draft.priority !== task.priority) {
		ordinaryIntents.push({
			type: "set-priority",
			key: task.key,
			priority: draft.priority,
		});
	}

	for (const field of DATE_FIELDS) {
		const current = currentDateTime(task, field);
		const next = parsedDates[field];
		if (sameDateTime(current, next)) continue;
		ordinaryIntents.push(
			next.date === null
				? { type: "set-date", key: task.key, field, date: null }
				: {
						type: "set-date",
						key: task.key,
						field,
						date: next.date,
						time: next.time,
						timeEnd: next.timeEnd,
					},
		);
	}

	const location = draft.location.trim() || null;
	if (location !== task.location) {
		ordinaryIntents.push({ type: "set-location", key: task.key, location });
	}

	return { ordinaryIntents, metadataPatch };
}

function dateTimeDraft(
	date: IsoDate | null,
	time: string | null,
	timeEnd: string | null,
): TaskDateTimeDraft {
	return {
		date: date ?? "",
		timeRange: time === null ? "" : `${time}${timeEnd === null ? "" : `-${timeEnd}`}`,
	};
}

function parseDateTime(field: EditableDateField, draft: TaskDateTimeDraft): ParsedDateTime {
	const date = draft.date.trim();
	const timeRange = draft.timeRange.trim();
	if (date === "") {
		if (timeRange !== "") throw new Error(`${field} time requires a date`);
		return { date: null, time: null, timeEnd: null };
	}
	if (!isValidIsoDate(date)) throw new Error(`${field} must be a real ISO date`);
	if (timeRange === "") return { date, time: null, timeEnd: null };

	const separator = timeRange.indexOf("-");
	const time = separator === -1 ? timeRange : timeRange.slice(0, separator);
	const timeEnd = separator === -1 ? null : timeRange.slice(separator + 1);
	if (!TIME_RE.test(time) || (timeEnd !== null && !TIME_RE.test(timeEnd))) {
		throw new Error(`${field} time must use HH:mm or HH:mm-HH:mm`);
	}
	if (timeEnd !== null && timeEnd <= time) {
		throw new Error(`${field} time range must end after it starts`);
	}
	return { date, time, timeEnd };
}

function currentDateTime(task: Task, field: EditableDateField): ParsedDateTime {
	switch (field) {
		case "due":
			return { date: task.due, time: task.dueTime, timeEnd: task.dueTimeEnd };
		case "scheduled":
			return {
				date: task.scheduled,
				time: task.scheduledTime,
				timeEnd: task.scheduledTimeEnd,
			};
		case "start":
			return { date: task.start, time: task.startTime, timeEnd: task.startTimeEnd };
	}
}

function sameDateTime(left: ParsedDateTime, right: ParsedDateTime): boolean {
	return left.date === right.date && left.time === right.time && left.timeEnd === right.timeEnd;
}

function validateScopeAssignment(task: Task, rawScopeId: string, catalog: ScopeCatalog): void {
	const scopeId = rawScopeId.trim() || null;
	if (scopeId === null || scopeId === task.scopeId) return;
	if (!isActiveScopeId(catalog, scopeId)) {
		throw new Error("scope must be active");
	}
}
