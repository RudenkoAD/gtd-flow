import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "./config";
import { FsVault } from "./fsVault";
import { addTask, gtdOverview, listEvents, listTasks, updateTask } from "./handlers";
import { openSession, type GtdSession } from "./session";
import { FIXTURE_FILES, FIXTURE_TODAY, makeVault, readVaultFile, removeVault } from "./testVault";

async function session(root: string): Promise<GtdSession> {
	return openSession({
		vault: new FsVault(root),
		settings: await loadSettings(root),
		today: FIXTURE_TODAY,
		genId: () => "meta1",
	});
}

describe("MCP canonical task metadata", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeVault(FIXTURE_FILES);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	it("lists canonical fields and filters globally by scope without namespace output", async () => {
		const result = listTasks(await session(root), { view: "all", scope: "work" }) as any;
		expect(result.scope).toBe("work");
		expect(result).not.toHaveProperty("namespace");
		const task = result.tasks.find((item: any) => item.id === "card01");
		expect(task).toMatchObject({
			duration_minutes: null,
			cognitive_intensity: null,
			emotional_intensity: null,
			physical_intensity: null,
			scope: "work",
		});
		expect(task).not.toHaveProperty("namespace");
	});

	it("does not expose legacy gtd-inbox files through the configured inbox view", async () => {
		const result = listTasks(await session(root), { view: "inbox" }) as any;
		expect(result.tasks.map((item: any) => item.description)).not.toContain("Позвонить маме");
	});

	it("adds all metadata fields to the unified inbox", async () => {
		const result = (await addTask(await session(root), {
			text: "Reconcile invoices",
			duration_minutes: 90,
			cognitive_intensity: 4,
			emotional_intensity: 2,
			physical_intensity: 0,
			scope: "work",
		})) as any;
		expect(result.file).toBe("GTD/Inbox.md");
		const content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("⏱ 90m 🧠 4 💓 2 💪 0 🧭 work");
	});

	it("updates and clears correlated fields through one atomic metadata operation", async () => {
		const s = await session(root);
		const result = (await updateTask(s, {
			id: "aaa111",
			duration_minutes: 60,
			cognitive_intensity: 3,
			emotional_intensity: 1,
			physical_intensity: 0,
			scope: "life",
		})) as any;
		expect(result).toMatchObject({ ok: true, applied: ["metadata"] });
		let content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("🆔 aaa111 ⏱ 60m 🧠 3 💓 1 💪 0 🧭 life");

		await updateTask(await session(root), {
			id: "aaa111",
			duration_minutes: null,
			cognitive_intensity: null,
			emotional_intensity: null,
			physical_intensity: null,
			scope: null,
		});
		content = await readVaultFile(root, "GTD/Inbox.md");
		expect(content).toContain("- [ ] Задача с айди 🆔 aaa111");
		expect(content).not.toMatch(/🆔 aaa111[^\n]*(?:⏱|🧠|💓|💪|🧭)/u);
	});

	// §external: зеркало внешнего календаря защищено на записи, но раньше об
	// этом молчала проекция — агент узнавал о read-only только по отказу.
	it("marks external-calendar mirrors as read-only in task and event projections", async () => {
		const mirrorRoot = await makeVault({
			...FIXTURE_FILES,
			"Календари/Google.md": `---
gtd-events: true
gtd-external: true
gtd-external-name: "Google"
---
- [ ] Созвон с командой 📅 2026-07-22 10:00-11:00 🆔 ext001
`,
		});
		try {
			const events = listEvents(await session(mirrorRoot), {
				from: "2026-07-20",
				to: "2026-07-26",
			}) as any;
			const occurrence = events.events.find((item: any) => item.seriesId === "ext001");
			expect(occurrence).toMatchObject({ external: true });
			const localEvent = events.events.find((item: any) => item.title === "День рождения");
			expect(localEvent).not.toHaveProperty("external");

			const rejected = (await updateTask(await session(mirrorRoot), {
				id: "ext001",
				scope: "work",
			})) as any;
			expect(rejected.ok).toBe(false);
		} finally {
			await removeVault(mirrorRoot);
		}
	});

	// §битый каталог: молчаливый пустой каталог превращал любой scope в
	// «unknown scope», хотя 🧭 стоит прямо в строках задач.
	it("reports a broken scope catalog and still filters by an id seen in task lines", async () => {
		const brokenRoot = await makeVault({
			...FIXTURE_FILES,
			".gtd-flow/config/scopes.json": "{ not json",
		});
		try {
			const broken = await session(brokenRoot);
			const overview = gtdOverview(broken) as any;
			expect(overview.scopes).toEqual([]);
			expect(overview.warnings).toEqual([expect.stringContaining("scope catalog")]);

			const listed = listTasks(broken, { view: "all", scope: "work" }) as any;
			expect(listed.count).toBeGreaterThan(0);
			expect(() => listTasks(broken, { view: "all", scope: "nope" })).toThrow(
				/unknown scope/,
			);
			// запись по-прежнему требует читаемый каталог
			await expect(addTask(broken, { text: "Bad", scope: "work" })).rejects.toThrow(
				/unknown scope/,
			);
		} finally {
			await removeVault(brokenRoot);
		}
	});

	it("rejects unknown/archived scope assignment but allows known scope read filtering", async () => {
		await expect(
			addTask(await session(root), { text: "Bad", scope: "missing" }),
		).rejects.toThrow(/unknown scope/);
		const overview = gtdOverview(await session(root)) as any;
		expect(overview.scopes).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "work", name: "Работа" })]),
		);
	});
});
