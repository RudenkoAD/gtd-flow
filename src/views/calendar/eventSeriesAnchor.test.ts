import { describe, expect, it } from "vitest";
import { parseRule } from "../../core/recurrence/grammar";
import { withSeriesAnchor } from "./eventSeries";

// withSeriesAnchor закрепляет чётность недель новой серии при создании из UI:
// weekly n>1 с byDay без from получает 'from <дата серии>'.

describe("withSeriesAnchor", () => {
	it("дописывает 'from <дата>' для weekly n>1 с byDay без from", () => {
		expect(withSeriesAnchor("every 2 weeks on tue", "2026-07-14")).toBe(
			"every 2 weeks on tue from 2026-07-14",
		);
		expect(withSeriesAnchor("every 3 weeks on mon, thu", "2026-07-13")).toBe(
			"every 3 weeks on mon, thu from 2026-07-13",
		);
	});

	it("from вставляется ПЕРЕД хвостом 'at' (splitEventRule на правке остаётся рабочим)", () => {
		const out = withSeriesAnchor("every 2 weeks on tue at 19:00-20:30", "2026-07-14");
		expect(out).toBe("every 2 weeks on tue from 2026-07-14 at 19:00-20:30");
		// и результат по-прежнему парсится
		const parsed = parseRule(out);
		expect("error" in parsed).toBe(false);
	});

	it("идемпотентно: from уже есть — текст не меняется", () => {
		const r = "every 2 weeks on tue from 2026-01-01";
		expect(withSeriesAnchor(r, "2026-07-14")).toBe(r);
	});

	it("не трогает n=1 (фаза не нужна)", () => {
		expect(withSeriesAnchor("every week on tue", "2026-07-14")).toBe("every week on tue");
		expect(withSeriesAnchor("every tuesday", "2026-07-14")).toBe("every tuesday");
	});

	it("не трогает weekly без byDay и другие частоты", () => {
		expect(withSeriesAnchor("every 2 weeks", "2026-07-14")).toBe("every 2 weeks");
		expect(withSeriesAnchor("every day", "2026-07-14")).toBe("every day");
		expect(withSeriesAnchor("every month on the 15th", "2026-07-14")).toBe(
			"every month on the 15th",
		);
	});

	it("битое правило возвращается как есть", () => {
		expect(withSeriesAnchor("nonsense rule", "2026-07-14")).toBe("nonsense rule");
	});
});
