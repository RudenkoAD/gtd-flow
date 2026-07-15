/**
 * mergeSettings: data.json пишется/правится руками (вкладки настроек пока
 * нет), поэтому частичные вложенные объекты — штатный вход, а не край.
 * Регрессия этапа 9: плоский Object.assign обнулял catchUp/catchUpCap и
 * debounceMs.fileReindex при частичном data.json.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./Settings";
import { mergeSettings } from "./mergeSettings";

describe("mergeSettings", () => {
	it("null/undefined/пустой объект → полные дефолты (и не тот же объект)", () => {
		for (const loaded of [null, undefined, {}]) {
			const merged = mergeSettings(DEFAULT_SETTINGS, loaded);
			expect(merged).toEqual(DEFAULT_SETTINGS);
			expect(merged).not.toBe(DEFAULT_SETTINGS);
			expect(merged.recurring).not.toBe(DEFAULT_SETTINGS.recurring);
			expect(merged.debounceMs).not.toBe(DEFAULT_SETTINGS.debounceMs);
		}
	});

	it("частичный recurring: недостающие вложенные ключи берут дефолты", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, { recurring: { spawnTarget: "My/Inbox.md" } });
		expect(merged.recurring.spawnTarget).toBe("My/Inbox.md");
		expect(merged.recurring.catchUp).toBe("latest"); // регрессия: было undefined → политика 'none'
		expect(merged.recurring.catchUpCap).toBe(30);
	});

	it("частичный debounceMs: fileReindex не превращается в undefined (= 0 мс)", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, { debounceMs: { queryRecompute: 10 } });
		expect(merged.debounceMs.queryRecompute).toBe(10);
		expect(merged.debounceMs.fileReindex).toBe(150);
	});

	it("неизвестные ключи (будущие версии) сохраняются — верхние и вложенные", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			futureFlag: true,
			recurring: { futureNested: "x" },
		});
		expect((merged as unknown as Record<string, unknown>)["futureFlag"]).toBe(true);
		expect((merged.recurring as Record<string, unknown>)["futureNested"]).toBe("x");
	});

	it("скаляры и массивы верхнего уровня заменяются целиком", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, {
			autoInjectId: false,
			inboxSources: ["A.md"],
			statusMap: { "/": "next" },
		});
		expect(merged.autoInjectId).toBe(false);
		expect(merged.inboxSources).toEqual(["A.md"]);
		expect(merged.statusMap).toEqual({ "/": "next" });
	});

	it("мусор вместо вложенного объекта не ломает слияние", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, { debounceMs: 5, recurring: "oops" });
		expect(merged.debounceMs).toEqual(DEFAULT_SETTINGS.debounceMs);
		expect(merged.recurring).toEqual(DEFAULT_SETTINGS.recurring);
	});

	it("DEFAULT_SETTINGS не мутируются", () => {
		const before = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as unknown;
		const merged = mergeSettings(DEFAULT_SETTINGS, { recurring: { catchUpCap: 7 } });
		merged.recurring.catchUpCap = 99;
		merged.debounceMs.fileReindex = 1;
		expect(DEFAULT_SETTINGS).toEqual(before);
	});
});
