/**
 * Приёмочный критерий A.4 CalDAV-заказа (§4.5): файл-зеркало, СОБРАННЫЙ РЕАЛЬНЫМ
 * пайплайном (projectOccurrences → buildMirrorFile с idNamespace/scopeId), должен
 * проецироваться через MCP-поверхности так же, как ICS-зеркала — как внешние
 * read-only события/задачи. Тест НЕ мокает ни один шаг пайплайна: MirrorOccurrence
 * собираются вручную (как это сделал бы parseIcs), затем идут через настоящие
 * projectOccurrences/buildMirrorFile, и только готовый .md-текст кладётся в vault —
 * дальше всё видит MCP-сервер так же, как видел бы файл настоящей синхронизации.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "./config";
import { FsVault } from "./fsVault";
import { deleteTask, listEvents, listTasks, updateTask } from "./handlers";
import { openSession, type GtdSession } from "./session";
import { makeVault, removeVault } from "./testVault";
import { EXTERNAL_READONLY_REASON } from "../services/WritebackService";
import { BUSY_TITLE, projectOccurrences } from "../sync/caldav/projection";
import type { MirrorOccurrence } from "../sync/icsParse";
import { buildMirrorFile, externalOccurrenceId } from "../sync/mirrorBuilder";

const TODAY = "2026-07-19";

async function session(root: string): Promise<GtdSession> {
	return openSession({
		vault: new FsVault(root),
		settings: await loadSettings(root),
		today: TODAY,
		genId: () => "meta1",
	});
}

// --- сырые вхождения — то, что parseIcs отдал бы developer'у до проекции ---

// Таймированное вхождение с конференц-ссылкой в названии/месте: details-режим
// обязан вырезать URI, оставив читаемый остаток (§4.3).
const OCC_TIMED: MirrorOccurrence = {
	uid: "evt-timed-1",
	recurrenceKey: "20260722T100000",
	date: "2026-07-22",
	allDay: false,
	startTime: "10:00",
	endTime: "11:00",
	title: "Планёрка https://meet.example/x",
	location: "Zoom https://meet.example/loc",
	dayIndex: 0,
	dayCount: 1,
};

const OCC_ALLDAY: MirrorOccurrence = {
	uid: "evt-allday-1",
	recurrenceKey: "20260723",
	date: "2026-07-23",
	allDay: true,
	startTime: null,
	endTime: null,
	title: "Отпуск",
	location: null,
	dayIndex: 0,
	dayCount: 1,
};

// Двухдневное таймированное вхождение — пайплайн раскладывает его на ДВЕ
// строки-зеркала (первые/последние сутки), тот же uid/recurrenceKey, разный
// dayIndex (см. icsParse.emitOccurrence: HH:mm-23:59 / 00:00-HH:mm).
const OCC_MULTI_DAY1: MirrorOccurrence = {
	uid: "evt-multi-1",
	recurrenceKey: "20260724T140000",
	date: "2026-07-24",
	allDay: false,
	startTime: "14:00",
	endTime: "23:59",
	title: "Конференция",
	location: "Отель Космос",
	dayIndex: 0,
	dayCount: 2,
};
const OCC_MULTI_DAY2: MirrorOccurrence = {
	...OCC_MULTI_DAY1,
	date: "2026-07-25",
	startTime: "00:00",
	endTime: "10:00",
	dayIndex: 1,
};

const RAW_OCCURRENCES: MirrorOccurrence[] = [OCC_TIMED, OCC_ALLDAY, OCC_MULTI_DAY1, OCC_MULTI_DAY2];

// Отдельное вхождение для busy-режима — свой uid, чтобы не пересекаться с
// details-лентой выше ни по дате, ни по идентичности.
const OCC_BUSY_SOURCE: MirrorOccurrence = {
	uid: "evt-busy-1",
	recurrenceKey: "20260726T090000",
	date: "2026-07-26",
	allDay: false,
	startTime: "09:00",
	endTime: "09:30",
	title: "Тет-а-тет",
	location: "Переговорная 3",
	dayIndex: 0,
	dayCount: 1,
};

// Один и тот же фид, две РАЗНЫЕ caldav-коллекции/аккаунта (§4.5): idNamespace —
// opaque `accountId\0collectionKey` (реальный разделитель — NUL, здесь взят
// читаемый ':' — namespace непрозрачен для externalOccurrenceId, разделитель
// значения не имеет); намеренно различается только хвостом.
const NS_1 = "acc-1:ck-aaa";
const NS_2 = "acc-1:ck-bbb";
const NS_BUSY = "acc-1:ck-busy";

const projectedDetails = projectOccurrences(RAW_OCCURRENCES, "details");
const projectedBusy = projectOccurrences([OCC_BUSY_SOURCE], "busy");

// Собраны РЕАЛЬНЫМ buildMirrorFile — ровно то, что положила бы на диск синхронизация.
const MIRROR_1 = buildMirrorFile(projectedDetails, {
	name: "Работа",
	subscriptionId: "cd-sub-1",
	idNamespace: NS_1,
	scopeId: "work",
});
const MIRROR_2 = buildMirrorFile(projectedDetails, {
	name: "Работа",
	subscriptionId: "cd-sub-2",
	idNamespace: NS_2,
	scopeId: "work",
});
const MIRROR_BUSY = buildMirrorFile(projectedBusy, {
	name: "Работа (busy)",
	subscriptionId: "cd-sub-3",
	idNamespace: NS_BUSY,
	scopeId: null,
});

const DATA_JSON = JSON.stringify({ settingsVersion: 5, inboxFile: "GTD/Inbox.md" });

const VAULT_FILES: Record<string, string> = {
	".obsidian/plugins/gtd-flow/data.json": DATA_JSON,
	"GTD/External/Работа-xxxxxx.md": MIRROR_1,
	"GTD/External/Работа-yyyyyy.md": MIRROR_2,
	"GTD/External/Работа-busy.md": MIRROR_BUSY,
};

describe("A.4: зеркало реального CalDAV-пайплайна через MCP-поверхности", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeVault(VAULT_FILES);
	});
	afterEach(async () => {
		await removeVault(root);
	});

	it("buildMirrorFile реально санировал названия/места — фикстура не подложена вручную", () => {
		expect(MIRROR_1).toContain("gtd-external: true");
		expect(MIRROR_1).toContain('gtd-external-name: "Работа"');
		expect(MIRROR_1).not.toContain("meet.example");
		expect(MIRROR_1).not.toContain("https://");
	});

	it("list_events: вхождения details-зеркала видны как external:true с очищенными названиями/местом", async () => {
		const events = listEvents(await session(root), {
			from: "2026-07-20",
			to: "2026-07-27",
		}) as any;

		const idTimed = externalOccurrenceId(OCC_TIMED, NS_1);
		const timed = events.events.find((e: any) => e.seriesId === idTimed);
		expect(timed).toMatchObject({
			date: "2026-07-22",
			time: "10:00",
			timeEnd: "11:00",
			title: "Планёрка",
			location: "Zoom",
			external: true,
		});
		expect(timed.title).not.toContain("meet.example");
		expect(timed.location).not.toContain("meet.example");

		const idAllDay = externalOccurrenceId(OCC_ALLDAY, NS_1);
		const allDay = events.events.find((e: any) => e.seriesId === idAllDay);
		expect(allDay).toMatchObject({ date: "2026-07-23", title: "Отпуск", external: true });
		expect(allDay).not.toHaveProperty("time");

		// многодневное — два раздельных вхождения, свои даты/время, РАЗНЫЕ 🆔
		const idDay1 = externalOccurrenceId(OCC_MULTI_DAY1, NS_1);
		const idDay2 = externalOccurrenceId(OCC_MULTI_DAY2, NS_1);
		expect(idDay1).not.toBe(idDay2);
		const day1 = events.events.find((e: any) => e.seriesId === idDay1);
		const day2 = events.events.find((e: any) => e.seriesId === idDay2);
		expect(day1).toMatchObject({
			date: "2026-07-24",
			time: "14:00",
			timeEnd: "23:59",
			title: "Конференция",
			location: "Отель Космос",
			external: true,
		});
		expect(day2).toMatchObject({
			date: "2026-07-25",
			time: "00:00",
			timeEnd: "10:00",
			title: "Конференция",
			external: true,
		});
	});

	// §container-фильтрация: файл-зеркало несёт gtd-events:true ⇒ container
	// "events" — а list_tasks во ВСЕХ ветках ("all" явно, остальные — своими
	// собственными фильтрами) исключает container "events". Строки зеркала
	// поэтому не всплывают в list_tasks НИКОГДА — это единственная поверхность
	// задач, но не события. 🧭-scope, записанный в строку зеркала, из-за этого
	// не виден ни в одной MCP-поверхности: list_tasks строку не отдаёт вовсе, а
	// list_events (см. handlers.ts listEvents) вообще не проецирует поле scope
	// в объект вхождения. Это не сбой конкретной проверки — таково текущее
	// поведение сервера; см. итоговый отчёт.
	it("list_tasks не отдаёт строки зеркала; 🧭-scope зеркала не всплывает ни в одной поверхности", async () => {
		const s = await session(root);
		const all = listTasks(s, { view: "all" }) as any;
		expect(all.tasks.some((t: any) => String(t.description ?? "").includes("Планёрка"))).toBe(
			false,
		);
		expect(
			all.tasks.some((t: any) => String(t.description ?? "").includes("Конференция")),
		).toBe(false);

		// задача реально в индексе, реально несёт container "events", external:true
		// и scopeId "work" (🧭 распознан парсером) — просто list_tasks её не отдаёт.
		const mirrorTask = s.allTasks.find(
			(t) => t.filePath === "GTD/External/Работа-xxxxxx.md" && t.description === "Планёрка",
		);
		expect(mirrorTask?.container).toBe("events");
		expect(mirrorTask?.external).toBe(true);
		expect(mirrorTask?.scopeId).toBe("work");

		// list_events — единственная поверхность, где зеркало видно — не содержит scope.
		const events = listEvents(s, { from: "2026-07-20", to: "2026-07-27" }) as any;
		const occurrence = events.events.find((e: any) => e.title === "Планёрка");
		expect(occurrence).toBeDefined();
		expect(occurrence).not.toHaveProperty("scope");
	});

	it("update_task отклоняет правку по 🆔 зеркала (read-only)", async () => {
		const s = await session(root);
		const id = externalOccurrenceId(OCC_ALLDAY, NS_1);
		const result = (await updateTask(s, { id, text: "Переименовано агентом" })) as any;
		expect(result.ok).toBe(false);
		expect(result.failed).toEqual([{ op: "text", reason: EXTERNAL_READONLY_REASON }]);
	});

	it("delete_task отклоняет удаление по 🆔 зеркала (read-only)", async () => {
		const s = await session(root);
		const id = externalOccurrenceId(OCC_TIMED, NS_2);
		await expect(deleteTask(s, { id })).rejects.toThrow(EXTERNAL_READONLY_REASON);
	});

	it("два зеркала одной ленты с разными idNamespace дают разные 🆔 — без коллизий и двусмысленности", async () => {
		const s = await session(root);
		const events = listEvents(s, { from: "2026-07-20", to: "2026-07-27" }) as any;

		const idAllDay1 = externalOccurrenceId(OCC_ALLDAY, NS_1);
		const idAllDay2 = externalOccurrenceId(OCC_ALLDAY, NS_2);
		expect(idAllDay1).not.toBe(idAllDay2);
		expect(events.events.filter((e: any) => e.seriesId === idAllDay1)).toHaveLength(1);
		expect(events.events.filter((e: any) => e.seriesId === idAllDay2)).toHaveLength(1);
		// оба вхождения одного дня видны ОДНОВРЕМЕННО — обе подписки сосуществуют
		expect(
			events.events.filter((e: any) => e.date === "2026-07-23" && e.title === "Отпуск"),
		).toHaveLength(2);

		// правка по 🆔 второго зеркала резолвится в РОВНО одну строку (не throw
		// "ambiguous id"): resolves, а не rejects, и падает уже на read-only-защите.
		await expect(updateTask(s, { id: idAllDay2, done: true })).resolves.toMatchObject({
			ok: false,
			failed: [{ op: "done", reason: EXTERNAL_READONLY_REASON }],
		});
	});

	it("busy-режим: generic-заголовок вместо названия, место не переносится", async () => {
		const s = await session(root);
		const events = listEvents(s, { from: "2026-07-20", to: "2026-07-27" }) as any;
		const idBusy = externalOccurrenceId(OCC_BUSY_SOURCE, NS_BUSY);
		const busy = events.events.find((e: any) => e.seriesId === idBusy);
		expect(busy).toMatchObject({
			date: "2026-07-26",
			time: "09:00",
			timeEnd: "09:30",
			title: BUSY_TITLE,
			external: true,
		});
		expect(busy).not.toHaveProperty("location");
		expect(busy.title).not.toBe("Тет-а-тет");
	});
});
