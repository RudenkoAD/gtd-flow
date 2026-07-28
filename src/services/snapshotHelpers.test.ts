import { describe, expect, it } from "vitest";
import {
	fileContextFromFrontmatter,
	localTodayIso,
	nearestHeadingAbove,
	snapshotListItems,
	type HeadingLike,
	type ListItemLike,
} from "./snapshotHelpers";

function item(startLine: number, endLine: number, task?: string, parent = -1): ListItemLike {
	return { position: { start: { line: startLine }, end: { line: endLine } }, task, parent };
}

function heading(line: number, text: string): HeadingLike {
	return { position: { start: { line }, end: { line } }, heading: text };
}

describe("snapshotListItems", () => {
	it("проецирует позиции на номера строк", () => {
		const [li] = snapshotListItems([item(3, 4, "x")], []);
		expect(li).toEqual({
			lineStart: 3,
			lineEnd: 4,
			taskChar: "x",
			parentLine: null,
			heading: null,
		});
	});

	it("пункт без task-символа получает taskChar null", () => {
		const [li] = snapshotListItems([item(0, 0)], []);
		expect(li?.taskChar).toBeNull();
	});

	it("пробел — валидный символ незавершённой задачи, не теряется", () => {
		const [li] = snapshotListItems([item(0, 0, " ")], []);
		expect(li?.taskChar).toBe(" ");
	});

	it("отрицательный parent (корневой пункт) даёт parentLine null", () => {
		const [li] = snapshotListItems([item(5, 5, "x", -3)], []);
		expect(li?.parentLine).toBeNull();
	});

	it("неотрицательный parent пробрасывается как parentLine", () => {
		const [li] = snapshotListItems([item(6, 6, "x", 5)], []);
		expect(li?.parentLine).toBe(5);
	});

	it("каждому пункту достаётся ближайший заголовок выше", () => {
		const hs = [heading(0, "A"), heading(5, "B")];
		const [a, b, c] = snapshotListItems(
			[item(3, 3, "x"), item(6, 6, "x"), item(5, 5, "x")],
			hs,
		);
		expect(a?.heading).toBe("A");
		expect(b?.heading).toBe("B");
		expect(c?.heading).toBe("B"); // граница включительно
	});

	it("пункт до первого заголовка — heading null", () => {
		const [li] = snapshotListItems([item(1, 1, "x")], [heading(4, "Ниже")]);
		expect(li?.heading).toBeNull();
	});
});

describe("nearestHeadingAbove", () => {
	it("пустой список заголовков — null", () => {
		expect(nearestHeadingAbove([], 10)).toBeNull();
	});

	it("берёт последний заголовок с line <= искомой", () => {
		const hs = [heading(0, "A"), heading(3, "B"), heading(9, "C")];
		expect(nearestHeadingAbove(hs, 8)).toBe("B");
		expect(nearestHeadingAbove(hs, 9)).toBe("C");
	});
});

describe("fileContextFromFrontmatter", () => {
	it("без frontmatter — plain", () => {
		expect(fileContextFromFrontmatter("a.md", undefined)).toEqual({
			path: "a.md",
			container: "plain",
		});
		expect(fileContextFromFrontmatter("a.md", null)).toEqual({
			path: "a.md",
			container: "plain",
		});
		expect(fileContextFromFrontmatter("a.md", {})).toEqual({
			path: "a.md",
			container: "plain",
		});
	});

	it("gtd-board: true — board; false/мусор — plain", () => {
		expect(fileContextFromFrontmatter("b.md", { "gtd-board": true }).container).toBe("board");
		expect(fileContextFromFrontmatter("b.md", { "gtd-board": false }).container).toBe("plain");
		expect(fileContextFromFrontmatter("b.md", { "gtd-board": "yes" }).container).toBe("plain");
	});

	it("gtd-project без status — projectStatus отсутствует (⇒ active)", () => {
		const ctx = fileContextFromFrontmatter("p.md", { "gtd-project": true });
		expect(ctx.container).toBe("project");
		expect(ctx.projectStatus).toBeUndefined();
	});

	it("валидные статусы проекта пробрасываются", () => {
		for (const s of ["active", "on-hold", "done", "archived"] as const) {
			const ctx = fileContextFromFrontmatter("p.md", { "gtd-project": true, status: s });
			expect(ctx.projectStatus).toBe(s);
		}
	});

	it("неизвестный статус — fail-closed on-hold, пустой — как отсутствие", () => {
		expect(
			fileContextFromFrontmatter("p.md", { "gtd-project": true, status: "чепуха" })
				.projectStatus,
		).toBe("on-hold");
		expect(
			fileContextFromFrontmatter("p.md", { "gtd-project": true, status: "  " }).projectStatus,
		).toBeUndefined();
	});

	it("gtd-card-of с непустым значением — card; пустое — нет", () => {
		expect(fileContextFromFrontmatter("c.md", { "gtd-card-of": "abc1" }).container).toBe(
			"card",
		);
		expect(fileContextFromFrontmatter("c.md", { "gtd-card-of": 42 }).container).toBe("card");
		expect(fileContextFromFrontmatter("c.md", { "gtd-card-of": "" }).container).toBe("plain");
		expect(fileContextFromFrontmatter("c.md", { "gtd-card-of": null }).container).toBe("plain");
		// Truthy YAML objects/booleans must not accidentally create a card.
		expect(fileContextFromFrontmatter("c.md", { "gtd-card-of": true }).container).toBe("plain");
		expect(fileContextFromFrontmatter("c.md", { "gtd-card-of": ["abc1"] }).container).toBe(
			"plain",
		);
	});

	it("gtd-events: true — events; false/мусор — plain", () => {
		expect(fileContextFromFrontmatter("e.md", { "gtd-events": true }).container).toBe("events");
		expect(fileContextFromFrontmatter("e.md", { "gtd-events": false }).container).toBe("plain");
		expect(fileContextFromFrontmatter("e.md", { "gtd-events": "yes" }).container).toBe("plain");
	});

	it("gtd-external + gtd-events — контейнер ОСТАЁТСЯ events (зеркало в пайплайне событий), external=true", () => {
		const ctx = fileContextFromFrontmatter("ext.md", {
			"gtd-events": true,
			"gtd-external": true,
		});
		// зеркало внешнего календаря подхватывается пайплайном событий БЕЗ изменений
		expect(ctx.container).toBe("events");
		expect(ctx.external).toBe(true);
	});

	it("gtd-external — только read-only маркер; false/мусор → ключ external опущен", () => {
		expect(fileContextFromFrontmatter("x.md", { "gtd-external": true }).external).toBe(true);
		expect(fileContextFromFrontmatter("x.md", {})).not.toHaveProperty("external");
		expect(fileContextFromFrontmatter("x.md", { "gtd-external": false })).not.toHaveProperty(
			"external",
		);
		expect(fileContextFromFrontmatter("x.md", { "gtd-external": "yes" })).not.toHaveProperty(
			"external",
		);
	});

	it("gtd-archive: true — archive; false/мусор — plain", () => {
		expect(fileContextFromFrontmatter("a.md", { "gtd-archive": true }).container).toBe(
			"archive",
		);
		expect(fileContextFromFrontmatter("a.md", { "gtd-archive": false }).container).toBe(
			"plain",
		);
		expect(fileContextFromFrontmatter("a.md", { "gtd-archive": "yes" }).container).toBe(
			"plain",
		);
	});

	it("gtd-inbox: true — inbox; false/мусор — plain", () => {
		expect(fileContextFromFrontmatter("i.md", { "gtd-inbox": true }).container).toBe("inbox");
		expect(fileContextFromFrontmatter("i.md", { "gtd-inbox": false }).container).toBe("plain");
		expect(fileContextFromFrontmatter("i.md", { "gtd-inbox": "yes" }).container).toBe("plain");
	});

	it("приоритет: recurring > events > card > project > board > archive > inbox", () => {
		const all = {
			"gtd-recurring": true,
			"gtd-events": true,
			"gtd-card-of": "x",
			"gtd-project": true,
			"gtd-board": true,
			"gtd-archive": true,
			"gtd-inbox": true,
		};
		expect(fileContextFromFrontmatter("f.md", all).container).toBe("recurring");
		expect(
			fileContextFromFrontmatter("f.md", { ...all, "gtd-recurring": false }).container,
		).toBe("events");
		expect(
			fileContextFromFrontmatter("f.md", {
				...all,
				"gtd-recurring": false,
				"gtd-events": false,
			}).container,
		).toBe("card");
		expect(
			fileContextFromFrontmatter("f.md", { "gtd-project": true, "gtd-board": true })
				.container,
		).toBe("project");
		// archive и inbox стоят НИЖЕ содержательных флагов: доска важнее «архива»/«входящих»
		expect(
			fileContextFromFrontmatter("f.md", {
				"gtd-board": true,
				"gtd-archive": true,
				"gtd-inbox": true,
			}).container,
		).toBe("board");
		// archive выигрывает у inbox при одновременном наличии
		expect(
			fileContextFromFrontmatter("f.md", { "gtd-archive": true, "gtd-inbox": true })
				.container,
		).toBe("archive");
	});
});

describe("fileContextFromFrontmatter — gtd-namespace (override пространства)", () => {
	it("непустая строка → nsOverride (обрезанный)", () => {
		expect(fileContextFromFrontmatter("x.md", { "gtd-namespace": "Работа" }).nsOverride).toBe(
			"Работа",
		);
		expect(
			fileContextFromFrontmatter("x.md", { "gtd-namespace": "  Жизнь  " }).nsOverride,
		).toBe("Жизнь");
	});

	it("отсутствие / пусто / пробелы / не-строка → ключ nsOverride опущен", () => {
		// омичен, а не null: снапшот без override не отличается от «до пространств»
		expect(fileContextFromFrontmatter("x.md", {})).not.toHaveProperty("nsOverride");
		expect(fileContextFromFrontmatter("x.md", { "gtd-namespace": "" })).not.toHaveProperty(
			"nsOverride",
		);
		expect(fileContextFromFrontmatter("x.md", { "gtd-namespace": "   " })).not.toHaveProperty(
			"nsOverride",
		);
		expect(fileContextFromFrontmatter("x.md", { "gtd-namespace": 42 })).not.toHaveProperty(
			"nsOverride",
		);
		expect(fileContextFromFrontmatter("x.md", { "gtd-namespace": true })).not.toHaveProperty(
			"nsOverride",
		);
		expect(fileContextFromFrontmatter("x.md", undefined)).not.toHaveProperty("nsOverride");
	});

	it("override сосуществует с флагами контейнера (не влияет на container)", () => {
		const ctx = fileContextFromFrontmatter("b.md", {
			"gtd-board": true,
			"gtd-namespace": "Работа",
		});
		expect(ctx.container).toBe("board");
		expect(ctx.nsOverride).toBe("Работа");
	});
});

describe("localTodayIso", () => {
	it("форматирует локальную дату с ведущими нулями", () => {
		expect(localTodayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
		expect(localTodayIso(new Date(2026, 11, 31))).toBe("2026-12-31");
	});
});
