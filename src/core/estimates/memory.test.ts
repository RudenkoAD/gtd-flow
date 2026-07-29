import { describe, expect, it } from "vitest";
import type { EstimateExample } from "./memory";
import { characterNgrams, lexicalTokens, retrieveEstimateExamples } from "./memory";

const baseValues = {
	durationMinutes: 30,
	cognitiveIntensity: 3,
	emotionalIntensity: 1,
	physicalIntensity: 0,
	scopeId: "work",
} as const;

function example(
	id: string,
	taskText: string,
	overrides: Partial<EstimateExample> = {},
): EstimateExample {
	return {
		id,
		taskId: `task-${id}`,
		taskText,
		scopeId: "work",
		tags: ["finance"],
		container: "inbox",
		heading: "Admin",
		recurrence: null,
		values: baseValues,
		confirmedFields: ["duration", "cognitive"],
		createdAt: "2026-07-28T00:00:00.000Z",
		...overrides,
	};
}

describe("estimate memory", () => {
	it("normalizes words and character n-grams", () => {
		expect([...lexicalTokens("  PAY invoices, today! ")]).toEqual(["pay", "invoices", "today"]);
		expect([...characterNgrams("Ab", 2)]).toEqual(["ab"]);
	});

	it("ranks independently per confirmed field", () => {
		const examples = [
			example("invoice", "Reconcile monthly invoices"),
			example("gym", "Go to the gym", {
				scopeId: "life",
				tags: ["health"],
				heading: null,
				confirmedFields: ["physical"],
			}),
		];
		const query = {
			taskText: "Reconcile vendor invoices",
			scopeId: "work",
			tags: ["#finance"],
			container: "inbox",
			heading: "Admin",
			recurrence: null,
		};
		expect(retrieveEstimateExamples(examples, query, "duration")[0]?.example.id).toBe(
			"invoice",
		);
		expect(retrieveEstimateExamples(examples, query, "physical")[0]?.example.id).toBe("gym");
	});

	it("excludes unconfirmed AI suggestions from labels", () => {
		const suggestion = example("suggestion", "Reconcile invoices", {
			confirmedFields: [],
		});
		expect(
			retrieveEstimateExamples(
				[suggestion],
				{
					taskText: "Reconcile invoices",
					scopeId: "work",
					tags: [],
					container: "inbox",
					heading: null,
					recurrence: null,
				},
				"duration",
			),
		).toEqual([]);
	});

	it("is deterministic on score ties and bounds the result", () => {
		const examples = [
			example("b", "Same words"),
			example("a", "Same words"),
			example("new", "Same words", { createdAt: "2026-07-29T00:00:00.000Z" }),
		];
		const result = retrieveEstimateExamples(
			examples,
			{
				taskText: "Same words",
				scopeId: "work",
				tags: ["finance"],
				container: "inbox",
				heading: "Admin",
				recurrence: null,
			},
			"duration",
			2,
		);
		expect(result.map((item) => item.example.id)).toEqual(["new", "a"]);
		expect(() =>
			retrieveEstimateExamples(
				examples,
				{
					taskText: "",
					scopeId: null,
					tags: [],
					container: "plain",
					heading: null,
					recurrence: null,
				},
				"duration",
				21,
			),
		).toThrow("estimate-example-limit-out-of-range");
	});
});
