import { describe, expect, it } from "vitest";
import type { Task } from "../model/Task";
import type { Rule } from "./grammar";
import { parseRule } from "./grammar";
import { makeChildId, planSpawns, type SpawnPlanInput, type TemplateInfo } from "./spawnPlan";

function makeTemplate(over: Partial<Task> = {}): Task {
	return {
		key: "id:rev-prio",
		taskId: "rev-prio",
		filePath: "GTD/Recurring.md",
		lineStart: 2,
		lineEnd: 2,
		parentLine: null,
		heading: null,
		description: "Review priorities",
		rawLine:
			"- [ ] Review priorities #review 🔺 🔁 every month on the last day 🛫 -3d 🆔 rev-prio 🔜 2026-07-31",
		statusChar: " ",
		due: null,
		scheduled: null,
		start: null,
		created: null,
		done: null,
		cancelled: null,
		dueTime: null,
		scheduledTime: null,
		startTime: null,
		dueTimeEnd: null,
		scheduledTimeEnd: null,
		startTimeEnd: null,
		recurrence: "every month on the last day",
		nextSpawn: "2026-07-31",
		spawnedFrom: null,
		priority: "highest",
		dependsOn: [],
		excludedDates: [],
		location: null,
		tags: ["#review"],
		container: "recurring",
		projectActive: true,
		...over,
	};
}

function tpl(task: Task, ruleText?: string): TemplateInfo {
	return { task, rule: parseRule(ruleText ?? task.recurrence ?? "") };
}

function plan(templates: TemplateInfo[], over: Partial<SpawnPlanInput> = {}) {
	return planSpawns({
		templates,
		today: "2026-07-15",
		catchUp: "latest",
		catchUpCap: 30,
		existingIds: new Set(),
		...over,
	});
}

describe("planSpawns — spec §6 example (late catch-up offsets)", () => {
	// шаблон 🛫 -3d, вхождение 2026-07-31, спавн 2026-08-03:
	// 🛫 считается от даты ВХОЖДЕНИЯ (2026-07-28), ➕ — от дня спавна (2026-08-03)
	it("resolves 🛫 from the occurrence and ➕ from the spawn day", () => {
		const res = plan([tpl(makeTemplate())], { today: "2026-08-03" });
		expect(res.errors).toEqual([]);
		expect(res.spawns).toHaveLength(1);
		const s = res.spawns[0]!;
		expect(s.templateId).toBe("rev-prio");
		expect(s.occurrence).toBe("2026-07-31");
		expect(s.childId).toBe("rev-prio-20260731");
		expect(s.instanceLine).toBe(
			"- [ ] Review priorities #review 🔺 🛫 2026-07-28 ➕ 2026-08-03 🧬 rev-prio 🆔 rev-prio-20260731",
		);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-08-31" }]);
	});

	it("on-time spawn: ➕ equals the occurrence day", () => {
		const res = plan([tpl(makeTemplate())], { today: "2026-07-31" });
		const s = res.spawns[0]!;
		expect(s.instanceLine).toContain("🛫 2026-07-28");
		expect(s.instanceLine).toContain("➕ 2026-07-31");
		expect(s.instanceLine).not.toContain("🔁");
		expect(s.instanceLine).not.toContain("🔜");
	});
});

describe("planSpawns — bootstrap (no 🔜)", () => {
	it("writes the cursor without retro-spawning", () => {
		const t = makeTemplate({ nextSpawn: null });
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-31" }]);
		expect(res.errors).toEqual([]);
	});
	it("spawns today's occurrence if bootstrap lands on today", () => {
		const t = makeTemplate({
			nextSpawn: null,
			recurrence: "every day",
			rawLine: "- [ ] Daily standup 🔁 every day 🆔 rev-prio",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.occurrence).toBe("2026-07-15");
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-16" }]);
	});
	it("bootstrap on a listed weekday spawns today for weekly n>1 (regression)", () => {
		// пн 2026-07-13: bootstrap after=today−1 — воскресенье ПРЕДЫДУЩЕЙ недели;
		// без якоря чётности к цепочке курсоров спавн уезжал на 2026-07-20
		const t = makeTemplate({
			nextSpawn: null,
			recurrence: "every 2 weeks on monday",
			rawLine: "- [ ] Biweekly 🔁 every 2 weeks on monday 🆔 rev-prio",
		});
		const res = plan([tpl(t)], { today: "2026-07-13" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.occurrence).toBe("2026-07-13");
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-27" }]);
	});
	it("skips a template whose until is already exhausted", () => {
		const t = makeTemplate({
			nextSpawn: null,
			recurrence: "every day until 2026-01-01",
			rawLine: "- [ ] Old habit 🔁 every day until 2026-01-01 🆔 rev-prio",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([]);
		expect(res.errors).toEqual([]);
	});
});

describe("planSpawns — catchUp policies over a 90-day gap", () => {
	const daily = () =>
		makeTemplate({
			recurrence: "every day",
			nextSpawn: "2026-04-16",
			rawLine: "- [ ] Daily standup 🔁 every day 🆔 rev-prio 🔜 2026-04-16",
		});

	it("latest: exactly one freshest copy", () => {
		const res = plan([tpl(daily())], { catchUp: "latest" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.occurrence).toBe("2026-07-15");
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-16" }]);
	});
	it("all: capped at catchUpCap, keeping the most recent", () => {
		const res = plan([tpl(daily())], { catchUp: "all", catchUpCap: 30 });
		expect(res.spawns).toHaveLength(30);
		expect(res.spawns[0]!.occurrence).toBe("2026-06-16");
		expect(res.spawns[29]!.occurrence).toBe("2026-07-15");
		// все childId уникальны
		expect(new Set(res.spawns.map((s) => s.childId)).size).toBe(30);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-16" }]);
	});
	it("none: only an occurrence landing exactly on today", () => {
		const res = plan([tpl(daily())], { catchUp: "none" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.occurrence).toBe("2026-07-15");
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-16" }]);
	});
	it("none: missed occurrence not on today spawns nothing but advances the cursor", () => {
		const t = makeTemplate({
			recurrence: "every friday",
			nextSpawn: "2026-07-10",
			rawLine: "- [ ] Weekly review 🔁 every friday 🆔 rev-prio 🔜 2026-07-10",
		});
		const res = plan([tpl(t)], { catchUp: "none", today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-17" }]);
	});
});

describe("planSpawns — idempotency and skips", () => {
	it("skips childIds already present in the index (cursor still advances)", () => {
		const res = plan([tpl(makeTemplate())], {
			today: "2026-08-03",
			existingIds: new Set(["rev-prio-20260731"]),
		});
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-08-31" }]);
	});
	it("a second pass over the advanced cursor is an empty plan", () => {
		const first = plan([tpl(makeTemplate())], { today: "2026-08-03" });
		const advanced = makeTemplate({ nextSpawn: first.cursorAdvances[0]!.newCursor });
		const second = plan([tpl(advanced)], {
			today: "2026-08-03",
			existingIds: new Set([first.spawns[0]!.childId]),
		});
		expect(second.spawns).toEqual([]);
		expect(second.cursorAdvances).toEqual([]);
	});
	it("skips paused templates (statusChar !== ' ') entirely", () => {
		const paused = makeTemplate({ statusChar: "-", rawLine: "- [-] Review priorities 🔁 every month on the last day 🆔 rev-prio 🔜 2026-04-30" });
		const res = plan([tpl(paused)], { today: "2026-08-03" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([]);
		expect(res.errors).toEqual([]);
	});
	it("does nothing when the cursor is in the future", () => {
		const res = plan([tpl(makeTemplate({ nextSpawn: "2026-07-31" }))], { today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([]);
	});
	it("parks the cursor past until when the rule exhausts", () => {
		const t = makeTemplate({
			recurrence: "every day until 2026-07-15",
			nextSpawn: "2026-07-14",
			rawLine: "- [ ] Countdown 🔁 every day until 2026-07-15 🆔 rev-prio 🔜 2026-07-14",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.occurrence).toBe("2026-07-15");
		// курсор паркуется на until+1: идемпотентность не должна висеть на existingIds
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-16" }]);
	});
	it("a deleted copy of an until-exhausted rule does not resurrect on later passes (regression)", () => {
		const countdown = (nextSpawn: string) =>
			makeTemplate({
				recurrence: "every day until 2026-07-15",
				nextSpawn,
				rawLine: `- [ ] Countdown 🔁 every day until 2026-07-15 🆔 rev-prio 🔜 ${nextSpawn}`,
			});
		// проход в день until: спавн + парковка курсора
		const first = plan([tpl(countdown("2026-07-14"))], { today: "2026-07-15" });
		expect(first.spawns.map((s) => s.childId)).toEqual(["rev-prio-20260715"]);
		expect(first.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-16" }]);
		// месяцы спустя пользователь удалил строку-копию: existingIds БЕЗ rev-prio-20260715,
		// но припаркованный курсор держит план пустым — зомби не возвращается
		const later = plan([tpl(countdown("2026-07-16"))], {
			today: "2026-09-20",
			existingIds: new Set(),
		});
		expect(later.spawns).toEqual([]);
		expect(later.cursorAdvances).toEqual([]); // ноль записей: шаблон стабилен
	});
});

describe("planSpawns — broken templates", () => {
	it("reports an unparseable rule as an error entry", () => {
		const t = makeTemplate({ recurrence: "whenever I feel like it" });
		const res = plan([tpl(t)]);
		expect(res.spawns).toEqual([]);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]!.templateId).toBe("rev-prio");
		expect(res.errors[0]!.filePath).toBe("GTD/Recurring.md");
		expect(res.errors[0]!.message).toContain("unparseable");
	});
	it("reports a template without 🆔", () => {
		const t = makeTemplate({ taskId: null });
		const res = plan([tpl(t)]);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]!.templateId).toBeNull();
		expect(res.spawns).toEqual([]);
	});
	it("re-snaps a hand-edited cursor that is not a member of the rule (no spawn)", () => {
		const t = makeTemplate({
			recurrence: "every month on the 15th",
			nextSpawn: "2026-07-20", // не 15-е — курсор битый
			rawLine: "- [ ] Pay rent 🔁 every month on the 15th 🆔 rev-prio 🔜 2026-07-20",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-08-15" }]);
	});
});

describe("planSpawns — instance line construction", () => {
	it("resolves 📅 +Nd offsets from the occurrence date", () => {
		const t = makeTemplate({
			taskId: "rent",
			key: "id:rent",
			recurrence: "every month on the 1st",
			nextSpawn: "2026-07-01",
			rawLine: "- [ ] Pay rent 📅 +14d 🔁 every month on the 1st 🆔 rent 🔜 2026-07-01",
		});
		const res = plan([tpl(t)], { today: "2026-07-01" });
		expect(res.spawns[0]!.instanceLine).toBe(
			"- [ ] Pay rent 📅 2026-07-15 ➕ 2026-07-01 🧬 rent 🆔 rent-20260701",
		);
	});
	it("keeps tags, priority and kanban tags; strips only template plumbing", () => {
		const t = makeTemplate({
			rawLine:
				"- [ ] Review priorities #review #kanban/work/todo 🔺 🔁 every month on the last day 🆔 rev-prio 🔜 2026-07-31",
		});
		const res = plan([tpl(t)], { today: "2026-07-31" });
		const line = res.spawns[0]!.instanceLine;
		expect(line).toContain("#review");
		expect(line).toContain("#kanban/work/todo");
		expect(line).toContain("🔺");
		expect(line).not.toContain("🔁");
		expect(line).not.toContain("🔜");
		expect(line).toContain("🆔 rev-prio-20260731");
		expect(line).toContain("🧬 rev-prio");
	});
	it("replaces a template's own ➕ with the spawn date (exactly one ➕)", () => {
		const t = makeTemplate({
			rawLine:
				"- [ ] Review priorities ➕ 2026-01-01 🔁 every month on the last day 🆔 rev-prio 🔜 2026-07-31",
		});
		const res = plan([tpl(t)], { today: "2026-07-31" });
		const line = res.spawns[0]!.instanceLine;
		expect(line.split("➕").length - 1).toBe(1);
		expect(line).toContain("➕ 2026-07-31");
	});
	it("preserves indentation of the template line", () => {
		const t = makeTemplate({
			rawLine: "  - [ ] Nested template 🔁 every month on the last day 🆔 rev-prio 🔜 2026-07-31",
		});
		const res = plan([tpl(t)], { today: "2026-07-31" });
		expect(res.spawns[0]!.instanceLine.startsWith("  - [ ] Nested template")).toBe(true);
	});
	it("strips fields whose emoji carry a U+FE0F variation selector (regression)", () => {
		// мобильные клавиатуры дописывают FE0F после эмодзи; токенизатор это терпит,
		// значит и строитель копии обязан — иначе «tpl 2026-07-14» утекает в описание
		const t = makeTemplate({
			taskId: "tpl",
			key: "id:tpl",
			recurrence: "every day",
			nextSpawn: "2026-07-14",
			rawLine: "- [ ] Mobile template 🔁️ every day 🆔️ tpl 🔜️ 2026-07-14",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.instanceLine).toBe(
			"- [ ] Mobile template ➕ 2026-07-15 🧬 tpl 🆔 tpl-20260715",
		);
	});
	it("expands ±Nd offsets and strips ➕/🧬 with a trailing U+FE0F (regression)", () => {
		const t = makeTemplate({
			rawLine:
				"- [ ] Review priorities ➕️ 2026-01-01 🛫️ -3d 🧬️ old-tpl 🔁️ every month on the last day 🆔️ rev-prio 🔜️ 2026-07-31",
		});
		const res = plan([tpl(t)], { today: "2026-07-31" });
		expect(res.spawns[0]!.instanceLine).toBe(
			"- [ ] Review priorities 🛫 2026-07-28 ➕ 2026-07-31 🧬 rev-prio 🆔 rev-prio-20260731",
		);
	});
});

describe("planSpawns — multiple templates and catch-up 'all' on monthly", () => {
	it("plans independently per template", () => {
		const good = makeTemplate();
		const paused = makeTemplate({
			taskId: "paused-tpl",
			key: "id:paused-tpl",
			statusChar: "-",
		});
		const res = plan([tpl(good), tpl(paused)], { today: "2026-08-03" });
		expect(res.spawns).toHaveLength(1);
		expect(res.spawns[0]!.templateId).toBe("rev-prio");
	});
	it("catchUp all over three monthly occurrences", () => {
		const t = makeTemplate({
			taskId: "rent",
			key: "id:rent",
			recurrence: "every month on the 1st",
			nextSpawn: "2026-05-01",
			rawLine: "- [ ] Pay rent 🔁 every month on the 1st 🆔 rent 🔜 2026-05-01",
		});
		const res = plan([tpl(t)], { catchUp: "all", today: "2026-07-15" });
		expect(res.spawns.map((s) => s.occurrence)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
		expect(res.spawns.map((s) => s.childId)).toEqual([
			"rent-20260501",
			"rent-20260601",
			"rent-20260701",
		]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rent", newCursor: "2026-08-01" }]);
	});
});

describe("planSpawns — MAX_ITERATIONS truncation (>1000 missed occurrences)", () => {
	const stale = (cursor: string) =>
		makeTemplate({
			recurrence: "every day",
			nextSpawn: cursor,
			rawLine: `- [ ] Daily standup 🔁 every day 🆔 rev-prio 🔜 ${cursor}`,
		});

	it("a truncated pass spawns nothing and only advances the cursor (regression)", () => {
		// курсор 2022-01-01, today 2026-07-15: 1657 пропущенных вхождений > 1000.
		// Раньше «latest» спавнил несвежее due[999]=2024-09-26 — двойная копия
		const res = plan([tpl(stale("2022-01-01"))], { today: "2026-07-15", catchUp: "latest" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2024-09-27" }]);
	});

	it("repeated passes converge to exactly one freshest copy (3-year gap, latest)", () => {
		const existingIds = new Set<string>();
		const spawned: string[] = [];
		let cursor = "2022-01-01";
		for (let pass = 0; pass < 10; pass++) {
			const res = plan([tpl(stale(cursor))], {
				today: "2026-07-15",
				catchUp: "latest",
				existingIds,
			});
			for (const s of res.spawns) {
				spawned.push(s.occurrence);
				existingIds.add(s.childId);
			}
			const adv = res.cursorAdvances[0];
			if (res.spawns.length === 0 && adv === undefined) break; // план пуст — сошлись
			if (adv !== undefined) cursor = adv.newCursor;
		}
		expect(spawned).toEqual(["2026-07-15"]);
	});

	it("'all' over a truncated window never emits stale mid-window occurrences", () => {
		const existingIds = new Set<string>();
		const spawned: string[] = [];
		let cursor = "2022-01-01";
		for (let pass = 0; pass < 10; pass++) {
			const res = plan([tpl(stale(cursor))], {
				today: "2026-07-15",
				catchUp: "all",
				catchUpCap: 5,
				existingIds,
			});
			for (const s of res.spawns) {
				spawned.push(s.occurrence);
				existingIds.add(s.childId);
			}
			const adv = res.cursorAdvances[0];
			if (res.spawns.length === 0 && adv === undefined) break;
			if (adv !== undefined) cursor = adv.newCursor;
		}
		// потолок держит именно СВЕЖАЙШИЙ хвост, а не срез из середины окна
		expect(spawned).toEqual([
			"2026-07-11",
			"2026-07-12",
			"2026-07-13",
			"2026-07-14",
			"2026-07-15",
		]);
	});
});

describe("planSpawns — from (нижняя граница шаблона)", () => {
	it("шаблон с from в будущем не спавнит, курсор паркуется на from", () => {
		const t = makeTemplate({
			nextSpawn: null, // bootstrap
			recurrence: "every day from 2026-08-01",
			rawLine: "- [ ] Future habit 🔁 every day from 2026-08-01 🆔 rev-prio",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-08-01" }]);
		expect(res.errors).toEqual([]);
	});

	it("не спавнит вхождений раньше from при курсоре до from (снап вперёд)", () => {
		const t = makeTemplate({
			nextSpawn: "2026-07-12", // до from — не член правила
			recurrence: "every day from 2026-07-20",
			rawLine: "- [ ] Bounded 🔁 every day from 2026-07-20 🆔 rev-prio 🔜 2026-07-12",
		});
		const res = plan([tpl(t)], { today: "2026-07-15" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "rev-prio", newCursor: "2026-07-20" }]);
	});

	it("спавнит начиная ровно с from, ничего раньше (catchUp all)", () => {
		const t = makeTemplate({
			taskId: "daily",
			key: "id:daily",
			nextSpawn: "2026-07-13",
			recurrence: "every day from 2026-07-13",
			rawLine: "- [ ] Standup 🔁 every day from 2026-07-13 🆔 daily 🔜 2026-07-13",
		});
		const res = plan([tpl(t)], { today: "2026-07-15", catchUp: "all" });
		expect(res.spawns.map((s) => s.occurrence)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
		expect(res.cursorAdvances).toEqual([{ templateId: "daily", newCursor: "2026-07-16" }]);
	});
});

describe("planSpawns — weekly n>1 с from: чётность недель курсора", () => {
	// Ориентиры: вторники 2026 — 07-14, 07-21, 07-28, 08-11 (from = 07-14, чётные недели).
	it("курсор на «не той» неделе (07-21) пере-снапится на ближайшее фазовое вхождение", () => {
		// апгрейд существующего пользователя: старый баг увёл 🔜 на нечётную неделю
		const t = makeTemplate({
			taskId: "bw",
			key: "id:bw",
			recurrence: "every 2 weeks on tue from 2026-07-14",
			nextSpawn: "2026-07-21", // вторник, но неделя не в фазе
			rawLine: "- [ ] Biweekly 🔁 every 2 weeks on tue from 2026-07-14 🆔 bw 🔜 2026-07-21",
		});
		// today до 07-28: пере-снап курсора без спавна (ближайшее фазовое ещё впереди)
		const res = plan([tpl(t)], { today: "2026-07-22" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "bw", newCursor: "2026-07-28" }]);
	});

	it("пере-снап НЕ пропускает ближайшее легитимное вхождение (спавнит его при due)", () => {
		const t = makeTemplate({
			taskId: "bw",
			key: "id:bw",
			recurrence: "every 2 weeks on tue from 2026-07-14",
			nextSpawn: "2026-07-21", // не в фазе
			rawLine: "- [ ] Biweekly 🔁 every 2 weeks on tue from 2026-07-14 🆔 bw 🔜 2026-07-21",
		});
		// today = 07-28: ближайшее фазовое (07-28) — сегодня, оно спавнится
		const res = plan([tpl(t)], { today: "2026-07-28" });
		expect(res.spawns.map((s) => s.occurrence)).toEqual(["2026-07-28"]);
		expect(res.cursorAdvances).toEqual([{ templateId: "bw", newCursor: "2026-08-11" }]);
	});

	it("уже созданные копии обеих фаз (старый баг) не дублируются при пере-снапе", () => {
		const t = makeTemplate({
			taskId: "bw",
			key: "id:bw",
			recurrence: "every 2 weeks on tue from 2026-07-14",
			nextSpawn: "2026-07-21",
			rawLine: "- [ ] Biweekly 🔁 every 2 weeks on tue from 2026-07-14 🆔 bw 🔜 2026-07-21",
		});
		// копия за 07-28 уже существует (была наспавнена еженедельным багом) → не дубль
		const res = plan([tpl(t)], { today: "2026-07-28", existingIds: new Set(["bw-20260728"]) });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "bw", newCursor: "2026-08-11" }]);
	});

	it("курсор в фазе принимается как есть", () => {
		const t = makeTemplate({
			taskId: "bw",
			key: "id:bw",
			recurrence: "every 2 weeks on tue from 2026-07-14",
			nextSpawn: "2026-07-14", // в фазе
			rawLine: "- [ ] Biweekly 🔁 every 2 weeks on tue from 2026-07-14 🆔 bw 🔜 2026-07-14",
		});
		const res = plan([tpl(t)], { today: "2026-07-14" });
		expect(res.spawns.map((s) => s.occurrence)).toEqual(["2026-07-14"]);
		expect(res.cursorAdvances).toEqual([{ templateId: "bw", newCursor: "2026-07-28" }]);
	});

	it("bootstrap с from садится на фазовую неделю (не +1 неделя)", () => {
		const t = makeTemplate({
			taskId: "bw",
			key: "id:bw",
			nextSpawn: null,
			recurrence: "every 2 weeks on tue from 2026-07-14",
			rawLine: "- [ ] Biweekly 🔁 every 2 weeks on tue from 2026-07-14 🆔 bw",
		});
		// today=07-20 (нечётная неделя): курсор bootstrap = 07-28, НЕ 07-21
		const res = plan([tpl(t)], { today: "2026-07-20" });
		expect(res.spawns).toEqual([]);
		expect(res.cursorAdvances).toEqual([{ templateId: "bw", newCursor: "2026-07-28" }]);
	});
});

describe("makeChildId", () => {
	it("is <templateId>-<YYYYMMDD>", () => {
		expect(makeChildId("rev-prio", "2026-07-31")).toBe("rev-prio-20260731");
	});
});
