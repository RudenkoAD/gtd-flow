import { describe, expect, it } from "vitest";
import { createScopeCatalog } from "../../core/scope/scope";
import { makeTask } from "../../stores/testSupport";
import {
	taskDetailsChangesFromDraft,
	taskDetailsDraftFromTask,
	type TaskDetailsDraft,
} from "./taskDetails";

const TODAY = "2026-08-02";
const CATALOG = createScopeCatalog([
	{ id: "work", name: "Work", order: 0, archived: false },
	{ id: "old", name: "Old", order: 1, archived: true },
]);

describe("task details draft", () => {
	it("round-trips a task without producing changes", () => {
		const task = makeTask({
			filePath: "Inbox.md",
			description: "Prepare report",
			statusChar: "X",
			priority: "high",
			due: "2026-08-04",
			dueTime: "09:00",
			dueTimeEnd: "10:30",
			location: "Office",
			durationMinutes: 90,
			cognitiveIntensity: 4,
			emotionalIntensity: 2,
			physicalIntensity: 0,
			scopeId: "work",
		});
		const draft = taskDetailsDraftFromTask(task);
		expect(draft).toMatchObject({
			description: "Prepare report",
			completed: true,
			due: { date: "2026-08-04", timeRange: "09:00-10:30" },
			location: "Office",
		});
		expect(taskDetailsChangesFromDraft(task, draft, TODAY, CATALOG)).toEqual({
			ordinaryIntents: [],
			metadataPatch: {},
		});
	});

	it("builds minimal keyed intents and one metadata patch", () => {
		const task = makeTask({
			filePath: "Inbox.md",
			key: "id:task-1",
			description: "Prepare report",
			priority: "none",
			scheduled: "2026-08-03",
			location: "Office",
			durationMinutes: 30,
			cognitiveIntensity: 2,
			scopeId: "work",
		});
		const draft: TaskDetailsDraft = {
			...taskDetailsDraftFromTask(task),
			description: "  Prepare final report  ",
			completed: true,
			priority: "high",
			due: { date: "2026-08-05", timeRange: "09:00-10:30" },
			scheduled: { date: "", timeRange: "" },
			location: "  Home  ",
			metadata: {
				...taskDetailsDraftFromTask(task).metadata,
				durationMinutes: "45",
				cognitiveIntensity: "4",
				scopeId: "",
			},
		};
		expect(taskDetailsChangesFromDraft(task, draft, TODAY, CATALOG)).toEqual({
			ordinaryIntents: [
				{ type: "set-text", key: "id:task-1", text: "Prepare final report" },
				{
					type: "set-status",
					key: "id:task-1",
					statusChar: "x",
					date: TODAY,
				},
				{ type: "set-priority", key: "id:task-1", priority: "high" },
				{
					type: "set-date",
					key: "id:task-1",
					field: "due",
					date: "2026-08-05",
					time: "09:00",
					timeEnd: "10:30",
				},
				{ type: "set-date", key: "id:task-1", field: "scheduled", date: null },
				{ type: "set-location", key: "id:task-1", location: "Home" },
			],
			metadataPatch: {
				durationMinutes: 45,
				cognitiveIntensity: 4,
				scopeId: null,
			},
		});
	});

	it("rejects invalid titles, dates, time ranges, and due/start coexistence", () => {
		const task = makeTask({ filePath: "Inbox.md", description: "Task" });
		const draft = taskDetailsDraftFromTask(task);
		expect(() =>
			taskDetailsChangesFromDraft(task, { ...draft, description: "  " }, TODAY, CATALOG),
		).toThrow(/title/);
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{ ...draft, due: { date: "2026-02-29", timeRange: "" } },
				TODAY,
				CATALOG,
			),
		).toThrow(/real ISO date/);
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{ ...draft, due: { date: "2026-08-03", timeRange: "9:00" } },
				TODAY,
				CATALOG,
			),
		).toThrow(/HH:mm/);
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{ ...draft, due: { date: "2026-08-03", timeRange: "10:00-09:00" } },
				TODAY,
				CATALOG,
			),
		).toThrow(/end after/);
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{
					...draft,
					due: { date: "2026-08-03", timeRange: "" },
					start: { date: "2026-08-04", timeRange: "" },
				},
				TODAY,
				CATALOG,
			),
		).toThrow(/cannot coexist/);
	});

	it("reuses metadata validation and only permits active scope assignment", () => {
		const task = makeTask({ filePath: "Inbox.md", description: "Task", scopeId: "old" });
		const draft = taskDetailsDraftFromTask(task);
		expect(taskDetailsChangesFromDraft(task, draft, TODAY, CATALOG).metadataPatch).toEqual({});
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{ ...draft, metadata: { ...draft.metadata, scopeId: "missing" } },
				TODAY,
				CATALOG,
			),
		).toThrow(/scope must be active/);
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{ ...draft, metadata: { ...draft.metadata, durationMinutes: "2220" } },
				TODAY,
				CATALOG,
			),
		).toThrow(/whole-day increments/);
		expect(() =>
			taskDetailsChangesFromDraft(
				task,
				{ ...draft, metadata: { ...draft.metadata, physicalIntensity: "6" } },
				TODAY,
				CATALOG,
			),
		).toThrow(/0 to 5/);
	});
});
