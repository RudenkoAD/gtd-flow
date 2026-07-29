import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "./config";
import { FsVault } from "./fsVault";
import {
	addEvent,
	addTask,
	deleteTask,
	gtdOverview,
	listBoards,
	listEvents,
	listTasks,
	moveCard,
	updateTask,
} from "./handlers";
import { openSession, type GtdSession } from "./session";
import { FIXTURE_FILES, FIXTURE_TODAY, makeVault, readVaultFile, removeVault } from "./testVault";

async function session(root: string): Promise<GtdSession> {
	return openSession({
		vault: new FsVault(root),
		settings: await loadSettings(root),
		today: FIXTURE_TODAY,
		genId: () => "coverage-id",
	});
}

function rows(result: Record<string, unknown>): Array<Record<string, unknown>> {
	return result["tasks"] as Array<Record<string, unknown>>;
}

describe("MCP handler contract breadth", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeVault(FIXTURE_FILES);
	});

	afterEach(async () => {
		await removeVault(root);
	});

	it("reports global scope-aware overviews and every task/event/board read view", async () => {
		const current = await session(root);
		expect(gtdOverview(current)).toMatchObject({
			today: FIXTURE_TODAY,
			inbox: 3,
			tickler: 1,
			boards: 1,
			projects: 1,
			events: 2,
			scopes: expect.arrayContaining([
				expect.objectContaining({ id: "work", task_count: 2 }),
				expect.objectContaining({ id: "life", task_count: 3 }),
			]),
		});

		expect(rows(listTasks(current, { view: "inbox" }))).toHaveLength(3);
		expect(rows(listTasks(current, { view: "tickler", scope: "life" }))).toHaveLength(1);
		expect(rows(listTasks(current, { view: "board" }))).toHaveLength(2);
		expect(rows(listTasks(current, { view: "board", board: "sprint" }))).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "card01", columnId: "todo" })]),
		);
		expect(rows(listTasks(current, { view: "project" }))).toHaveLength(1);
		expect(rows(listTasks(current, { view: "project", project: "Ремонт кухни" }))).toHaveLength(
			1,
		);
		expect(rows(listTasks(current, { view: "all", include_done: true }))).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "proj02", done: true })]),
		);
		expect(() => listTasks(current, { scope: "missing" })).toThrow("unknown scope");
		expect(() => listTasks(current, { view: "board", board: "missing" })).toThrow("not found");
		expect(() => listTasks(current, { view: "project", project: "missing" })).toThrow(
			"not found",
		);

		expect(listBoards(current, {})).toMatchObject({
			count: 1,
			boards: [expect.objectContaining({ id: "sprint", total: 2 })],
		});
		const events = listEvents(current, { from: "2026-07-19", to: "2026-07-26" });
		expect(events).toMatchObject({ count: 2 });
		expect(events["events"]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "series", title: "Йога", time: "08:00" }),
				expect.objectContaining({ kind: "single", title: "День рождения" }),
			]),
		);
		expect(() => listEvents(current, { from: "2026-07-26", to: "2026-07-19" })).toThrow(
			"must not be after",
		);
		expect(() => listEvents(current, { from: "bad", to: "2026-07-19" })).toThrow("not a valid");
	});

	it("writes validated task patches, deletes tasks, and moves cards", async () => {
		let current = await session(root);
		const created = await addTask(current, {
			text: "Prepare review",
			due: "2026-07-20 09:00-10:00",
			scheduled: "2026-07-19",
			start: "2026-07-18 08:00",
			duration_minutes: 30,
			cognitive_intensity: 3,
			emotional_intensity: 2,
			physical_intensity: 1,
			scope: "work",
		});
		expect(created).toMatchObject({ ok: true, file: "GTD/Inbox.md" });
		expect(await readVaultFile(root, "GTD/Inbox.md")).toContain("🧭 work");
		await expect(addTask(current, { text: "Bad", duration_minutes: 23 })).rejects.toThrow(
			"five-minute increments below 24h",
		);
		await expect(addTask(current, { text: "Bad", duration_minutes: 2_220 })).rejects.toThrow(
			"whole-day increments from 24h",
		);
		await expect(addTask(current, { text: "Bad", scope: "missing" })).rejects.toThrow(
			"unknown scope",
		);

		current = await session(root);
		await expect(
			updateTask(current, {
				id: "aaa111",
				text: "Updated task",
				due: "2026-07-21 10:00",
				scheduled: "2026-07-20",
				start: "2026-07-19",
				priority: "high",
				location: "Office",
				duration_minutes: 60,
				cognitive_intensity: 4,
				emotional_intensity: 3,
				physical_intensity: 2,
				scope: "life",
				done: true,
			}),
		).resolves.toMatchObject({
			ok: true,
			applied: [
				"text",
				"due",
				"scheduled",
				"start",
				"priority",
				"location",
				"metadata",
				"done",
			],
		});
		expect(await readVaultFile(root, "GTD/Inbox.md")).toContain("Updated task");
		await expect(updateTask(current, { id: "aaa111" })).rejects.toThrow("nothing to update");
		await expect(updateTask(current, { id: "aaa111", priority: "urgent" })).rejects.toThrow(
			"invalid priority",
		);

		current = await session(root);
		await expect(deleteTask(current, { id: "aaa111", with_children: false })).resolves.toEqual({
			ok: true,
			id: "aaa111",
			withChildren: false,
		});
		current = await session(root);
		await expect(
			moveCard(current, { board: "sprint", id: "card01", column: "doing" }),
		).resolves.toEqual({
			ok: true,
			board: "Спринт",
			column: "В работе",
			id: "card01",
		});
		await expect(
			moveCard(current, { board: "sprint", id: "card01", column: "missing" }),
		).rejects.toThrow("column 'missing' not found");
	});

	it("creates single and recurring events and rejects ambiguous schedules", async () => {
		const current = await session(root);
		await expect(
			addEvent(current, {
				name: "Planning",
				date: "2026-07-22 09:00",
				time: "10:00-11:00",
				location: "Room 1",
			}),
		).resolves.toMatchObject({ ok: true, kind: "single", file: "GTD/Events.md" });
		await expect(
			addEvent(current, { name: "Standup", rule: "every monday", time: "09:30" }),
		).resolves.toMatchObject({ ok: true, kind: "series" });
		const content = await readVaultFile(root, "GTD/Events.md");
		expect(content).toContain("Planning");
		expect(content).toContain("Standup");
		await expect(
			addEvent(current, { name: "Bad", date: "2026-07-22", rule: "every monday" }),
		).rejects.toThrow("mutually exclusive");
		await expect(addEvent(current, { name: "Bad" })).rejects.toThrow("provide either");
		await expect(
			addEvent(current, { name: "Bad", rule: "every monday at 09:00", time: "10:00" }),
		).rejects.toThrow("already sets a time");
		await expect(addEvent(current, { name: "Bad", rule: "every! day" })).rejects.toThrow(
			"from-completion",
		);
	});
});
