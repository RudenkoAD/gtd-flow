import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import { isParseError } from "../../core/recurrence/grammar";
import { makeTask } from "../../stores/testSupport";
import { buildTemplateVM, groupByFileAndHeading, historyOf } from "./recurringLogic";

const TODAY = "2026-07-15";

function template(over: Partial<Task> = {}) {
	return makeTask({
		filePath: "GTD/Recurring.md",
		container: "recurring",
		recurrence: "every day",
		...over,
	});
}

describe("buildTemplateVM", () => {
	it("здоровый шаблон: правило распарсено, бейджей нет", () => {
		const t = template({ recurrence: "every month on the last day", nextSpawn: "2026-07-31" });
		const vm = buildTemplateVM(t, TODAY);
		expect(isParseError(vm.ruleParsed)).toBe(false);
		expect(vm.ruleText).toBe("every month on the last day");
		expect(vm.nextSpawn).toBe("2026-07-31");
		expect(vm.paused).toBe(false);
		expect(vm.expired).toBe(false);
		expect(vm.badges).toEqual([]);
		expect(vm.key).toBe(t.key);
		expect(vm.task).toBe(t);
	});

	it("статус '-' — пауза", () => {
		const vm = buildTemplateVM(template({ statusChar: "-" }), TODAY);
		expect(vm.paused).toBe(true);
		expect(vm.badges).toEqual(["paused"]);
	});

	it("любой статус, кроме ' ', — пауза (в том числе 'x')", () => {
		expect(buildTemplateVM(template({ statusChar: "x" }), TODAY).paused).toBe(true);
	});

	it("синтаксическая ошибка правила — бейдж error с сообщением парсера", () => {
		const vm = buildTemplateVM(template({ recurrence: "каждый вторник" }), TODAY);
		expect(vm.badges).toEqual(["error"]);
		expect(isParseError(vm.ruleParsed)).toBe(true);
		if (isParseError(vm.ruleParsed)) expect(vm.ruleParsed.error.length).toBeGreaterThan(0);
	});

	it("шаблон без 🔁 — тоже error, ruleText пуст", () => {
		const vm = buildTemplateVM(template({ recurrence: null }), TODAY);
		expect(vm.ruleText).toBe("");
		expect(vm.badges).toEqual(["error"]);
	});

	it("until в прошлом — expired", () => {
		const vm = buildTemplateVM(template({ recurrence: "every day until 2026-01-01" }), TODAY);
		expect(vm.expired).toBe(true);
		expect(vm.badges).toEqual(["expired"]);
	});

	it("until в будущем — не expired", () => {
		const vm = buildTemplateVM(template({ recurrence: "every day until 2027-01-01" }), TODAY);
		expect(vm.expired).toBe(false);
	});

	it("без until expired невозможен", () => {
		const vm = buildTemplateVM(template({ recurrence: "every day" }), TODAY);
		expect(vm.expired).toBe(false);
	});

	it("пауза и expired складываются в порядке paused, error, expired", () => {
		const vm = buildTemplateVM(
			template({ statusChar: "-", recurrence: "every day until 2026-01-01" }),
			TODAY,
		);
		expect(vm.badges).toEqual(["paused", "expired"]);
	});
});

describe("groupByFileAndHeading", () => {
	const vm = (filePath: string, heading: string | null, line: number) =>
		buildTemplateVM(template({ filePath, heading, lineStart: line }), TODAY);

	it("смежные шаблоны одного файла и заголовка — одна группа", () => {
		const a = vm("a.md", "Ревью", 1);
		const b = vm("a.md", "Ревью", 2);
		const groups = groupByFileAndHeading([a, b]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("a.md");
		expect(groups[0]!.heading).toBe("Ревью");
		expect(groups[0]!.templates).toEqual([a, b]);
	});

	it("смена заголовка или файла открывает новую группу, порядок сохраняется", () => {
		const a = vm("a.md", null, 1);
		const b = vm("a.md", "Быт", 3);
		const c = vm("b.md", "Быт", 1);
		const groups = groupByFileAndHeading([a, b, c]);
		expect(groups.map((g) => [g.filePath, g.heading])).toEqual([
			["a.md", null],
			["a.md", "Быт"],
			["b.md", "Быт"],
		]);
	});

	it("пустой вход — пусто", () => {
		expect(groupByFileAndHeading([])).toEqual([]);
	});
});

describe("historyOf", () => {
	it("отбирает только копии данного шаблона (🧬 === templateId)", () => {
		const mine = makeTask({ filePath: "in.md", spawnedFrom: "rev", created: "2026-07-01" });
		const other = makeTask({ filePath: "in.md", spawnedFrom: "park", created: "2026-07-02" });
		const plain = makeTask({ filePath: "in.md" });
		expect(historyOf([mine, other, plain], "rev")).toEqual([mine]);
	});

	it("сортировка ➕ desc, копии без ➕ — в конце", () => {
		const old = makeTask({ filePath: "in.md", lineStart: 1, spawnedFrom: "rev", created: "2026-05-31" });
		const fresh = makeTask({ filePath: "in.md", lineStart: 2, spawnedFrom: "rev", created: "2026-06-30" });
		const dateless = makeTask({ filePath: "in.md", lineStart: 3, spawnedFrom: "rev", created: null });
		expect(historyOf([old, dateless, fresh], "rev")).toEqual([fresh, old, dateless]);
	});

	it("равные даты упорядочены стабильно по (файл, строка)", () => {
		const b = makeTask({ filePath: "b.md", lineStart: 1, spawnedFrom: "rev", created: "2026-07-01" });
		const a2 = makeTask({ filePath: "a.md", lineStart: 2, spawnedFrom: "rev", created: "2026-07-01" });
		const a1 = makeTask({ filePath: "a.md", lineStart: 1, spawnedFrom: "rev", created: "2026-07-01" });
		expect(historyOf([b, a2, a1], "rev")).toEqual([a1, a2, b]);
	});
});
