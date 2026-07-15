import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import type { Task } from "../core/model/Task";
import { createTaskStore } from "./taskStore";
import { FakeFeed, makeTask } from "./testSupport";

describe("createTaskStore", () => {
	it("отдаёт начальные epoch и today из feed", () => {
		const feed = new FakeFeed("2026-07-15");
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		const ts = createTaskStore(feed);
		expect(get(ts.epoch)).toBe(feed.getEpoch());
		expect(get(ts.today)).toBe("2026-07-15");
		ts.dispose();
	});

	it("index() возвращает живой TaskIndex из feed", () => {
		const feed = new FakeFeed();
		const ts = createTaskStore(feed);
		expect(ts.index()).toBe(feed.getIndex());
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		expect([...ts.index().all()].length).toBe(1);
		ts.dispose();
	});

	it("epoch обновляется при правке индекса", () => {
		const feed = new FakeFeed();
		const ts = createTaskStore(feed);
		const seen: number[] = [];
		const un = ts.epoch.subscribe((e) => seen.push(e));
		feed.replaceFile("a.md", [makeTask({ filePath: "a.md" })]);
		feed.replaceFile("b.md", [makeTask({ filePath: "b.md" })]);
		expect(seen).toEqual([0, 1, 2]);
		un();
		ts.dispose();
	});

	it("today обновляется при смене дня, epoch тоже двигается", () => {
		const feed = new FakeFeed("2026-07-15");
		const ts = createTaskStore(feed);
		const days: string[] = [];
		const un = ts.today.subscribe((d) => days.push(d));
		const epochBefore = get(ts.epoch);
		feed.rollover("2026-07-16");
		expect(days).toEqual(["2026-07-15", "2026-07-16"]);
		expect(get(ts.epoch)).toBe(epochBefore + 1);
		un();
		ts.dispose();
	});

	it("notify без изменений не дёргает подписчиков (set того же примитива молчит)", () => {
		const feed = new FakeFeed();
		const ts = createTaskStore(feed);
		let epochCalls = 0;
		let todayCalls = 0;
		const unE = ts.epoch.subscribe(() => epochCalls++);
		const unT = ts.today.subscribe(() => todayCalls++);
		feed.notify();
		feed.notify();
		expect(epochCalls).toBe(1); // только начальное значение
		expect(todayCalls).toBe(1);
		unE();
		unT();
		ts.dispose();
	});

	it("dispose отписывается от feed; повторный dispose безопасен", () => {
		const feed = new FakeFeed();
		const ts = createTaskStore(feed);
		const seen: number[] = [];
		const un = ts.epoch.subscribe((e) => seen.push(e));
		ts.dispose();
		ts.dispose();
		const tasks: Task[] = [makeTask({ filePath: "a.md" })];
		feed.replaceFile("a.md", tasks);
		expect(seen).toEqual([0]); // после dispose обновления не приходят
		expect(get(ts.today)).toBe("2026-07-15");
		un();
	});
});
