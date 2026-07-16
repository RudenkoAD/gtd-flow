import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../core/model/Task";
import { evaluate } from "../../core/query/QueryEngine";
import { defaultInboxConfig } from "../../core/query/querySpec";
import { createTaskStore, type TaskStore } from "../taskStore";
import { FakeFeed, makeTask } from "../testSupport";
import {
	calendarRangeStore,
	createQueryStore,
	inboxStore,
	projectMembersStore,
	templatesStore,
	ticklerStore,
} from "./queryStore";

describe("createQueryStore: мемоизация и дебаунс", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(debounceMs?: number) {
		const feed = new FakeFeed("2026-07-15");
		const ts = createTaskStore(feed);
		const spy = vi.fn(evaluate);
		const store = createQueryStore(
			ts,
			{ kind: "active" },
			{ settingsBits: defaultInboxConfig([]), evaluate: spy },
			debounceMs,
		);
		return { feed, ts, spy, store };
	}

	it("первое значение считается синхронно при подписке, без дебаунса", () => {
		const { feed, spy, store } = setup();
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		let value: Task[] = [];
		const un = store.subscribe((v) => {
			value = v;
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(value.length).toBe(1);
		un();
	});

	it("тот же (epoch, today, spec): второй подписчик и переподписка — ноль пересчётов", () => {
		const { feed, spy, store } = setup();
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		const un1 = store.subscribe(() => {});
		expect(spy).toHaveBeenCalledTimes(1);

		const un2 = store.subscribe(() => {});
		expect(spy).toHaveBeenCalledTimes(1); // второй подписчик — без пересчёта

		un1();
		un2();
		let after: Task[] = [];
		const un3 = store.subscribe((v) => {
			after = v;
		});
		expect(spy).toHaveBeenCalledTimes(1); // полная переподписка — мемо живо
		expect(after.length).toBe(1);
		un3();
	});

	it("bump epoch: пересчёт только по trailing edge дебаунса", () => {
		const { feed, spy, store } = setup();
		let value: Task[] = [];
		const un = store.subscribe((v) => {
			value = v;
		});
		expect(spy).toHaveBeenCalledTimes(1);

		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		expect(spy).toHaveBeenCalledTimes(1); // сразу — нет
		expect(value.length).toBe(0); // старый снэпшот до срабатывания таймера

		vi.advanceTimersByTime(49);
		expect(spy).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(value.length).toBe(1);
		un();
	});

	it("серия bump'ов внутри окна дебаунса схлопывается в один пересчёт", () => {
		const { feed, spy, store } = setup();
		const un = store.subscribe(() => {});
		expect(spy).toHaveBeenCalledTimes(1);

		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		vi.advanceTimersByTime(20);
		feed.replaceFile("b.md", [makeTask({ filePath: "b.md" })]);
		vi.advanceTimersByTime(20);
		feed.replaceFile("c.md", [makeTask({ filePath: "c.md" })]);
		expect(spy).toHaveBeenCalledTimes(1); // таймер каждый раз перезапускался

		vi.advanceTimersByTime(50);
		expect(spy).toHaveBeenCalledTimes(2); // один пересчёт с последним epoch
		expect(get(store).length).toBe(3);
		un();
	});

	it("смена today без bump epoch тоже инвалидирует мемо-ключ", () => {
		const { feed, spy, store } = setup();
		const un = store.subscribe(() => {});
		expect(spy).toHaveBeenCalledTimes(1);

		feed.rolloverWithoutEpochBump("2026-07-16");
		vi.advanceTimersByTime(50);
		expect(spy).toHaveBeenCalledTimes(2);
		const lastCall = spy.mock.calls.at(-1);
		expect(lastCall?.[1].today).toBe("2026-07-16");
		un();
	});

	it("отписка снимает отложенный таймер — пересчёта после неё нет", () => {
		const { feed, spy, store } = setup();
		const un = store.subscribe(() => {});
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		un(); // таймер ещё не сработал
		vi.advanceTimersByTime(1000);
		expect(spy).toHaveBeenCalledTimes(1); // только начальный расчёт
	});

	it("dispose у taskStore останавливает обновления запроса", () => {
		const { feed, ts, spy, store } = setup();
		const un = store.subscribe(() => {});
		ts.dispose();
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		vi.advanceTimersByTime(1000);
		expect(spy).toHaveBeenCalledTimes(1);
		un();
	});

	it("уважает нестандартный debounceMs", () => {
		const { feed, spy, store } = setup(200);
		const un = store.subscribe(() => {});
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		vi.advanceTimersByTime(199);
		expect(spy).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(spy).toHaveBeenCalledTimes(2);
		un();
	});
});

describe("готовые фабрики: реальный evaluate поверх TaskIndex", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(today = "2026-07-15") {
		const feed = new FakeFeed(today);
		const ts: TaskStore = createTaskStore(feed);
		return { feed, ts };
	}

	it("inboxStore: захваченное без due/доски/проекта — во входящих; с due — нет", () => {
		const { feed, ts } = setup();
		const captured = makeTask({ filePath: "notes.md", lineStart: 1, container: "inbox" });
		const withDue = makeTask({
			filePath: "notes.md",
			lineStart: 2,
			container: "inbox",
			due: "2026-07-20",
		});
		feed.replaceFile("notes.md", [captured, withDue]);

		const store = inboxStore(ts, defaultInboxConfig([]));
		const items = get(store);
		expect(items.map((t) => t.lineStart)).toEqual([1]);
		ts.dispose();
	});

	it("ticklerStore: start > today; после rollover задача уходит из тикля", () => {
		const { feed, ts } = setup("2026-07-15");
		feed.replaceFile("t.md", [
			makeTask({ filePath: "t.md", lineStart: 1, start: "2026-07-16" }),
		]);
		const store = ticklerStore(ts);
		let value: Task[] = [];
		const un = store.subscribe((v) => {
			value = v;
		});
		expect(value.length).toBe(1);

		feed.rollover("2026-07-16"); // start == today — уже не тикль (строгое >)
		vi.advanceTimersByTime(50);
		expect(value.length).toBe(0);
		un();
		ts.dispose();
	});

	it("calendarRangeStore: границы включительно, placement определяет поле", () => {
		const { feed, ts } = setup();
		feed.replaceFile("c.md", [
			makeTask({ filePath: "c.md", lineStart: 1, due: "2026-07-01" }),
			makeTask({ filePath: "c.md", lineStart: 2, due: "2026-07-31" }),
			makeTask({ filePath: "c.md", lineStart: 3, due: "2026-08-01" }), // вне диапазона
			makeTask({ filePath: "c.md", lineStart: 4, scheduled: "2026-07-10" }), // не в placement
		]);
		const store = calendarRangeStore(ts, "2026-07-01", "2026-07-31", ["due"]);
		expect(get(store).map((t) => t.lineStart)).toEqual([1, 2]);
		ts.dispose();
	});

	it("projectMembersStore: все задачи файла проекта, включая done; чужие — нет", () => {
		const { feed, ts } = setup();
		feed.replaceFile("P/alpha.md", [
			makeTask({ filePath: "P/alpha.md", lineStart: 1, container: "project" }),
			makeTask({ filePath: "P/alpha.md", lineStart: 2, container: "project", statusChar: "x" }),
		]);
		feed.replaceFile("P/beta.md", [
			makeTask({ filePath: "P/beta.md", lineStart: 1, container: "project" }),
		]);
		const store = projectMembersStore(ts, "P/alpha.md");
		expect(get(store).map((t) => t.lineStart)).toEqual([1, 2]);
		ts.dispose();
	});

	it("templatesStore: только задачи контейнера recurring", () => {
		const { feed, ts } = setup();
		feed.replaceFile("R/monthly.md", [
			makeTask({ filePath: "R/monthly.md", lineStart: 1, container: "recurring" }),
		]);
		feed.replaceFile("plain.md", [makeTask({ filePath: "plain.md", lineStart: 1 })]);
		const store = templatesStore(ts);
		const items = get(store);
		expect(items.length).toBe(1);
		expect(items[0]?.filePath).toBe("R/monthly.md");
		ts.dispose();
	});
});
