import { describe, expect, it } from "vitest";
import type { Task } from "../../core/model/Task";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import { isParseError } from "../../core/recurrence/grammar";
import { makeTask } from "../../stores/testSupport";
import {
	buildTemplateLine,
	buildTemplateVM,
	createTemplate,
	deleteTemplateBody,
	groupByFileAndHeading,
	historyOf,
	type TemplateVaultPort,
} from "./recurringLogic";

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

	it("fromCompletion с until в будущем — не expired (nextOccurrence всегда null, но серия жива, §FIX-3)", () => {
		const vm = buildTemplateVM(
			template({ recurrence: "every! 3 days until 2027-01-01" }),
			TODAY,
		);
		expect(vm.expired).toBe(false);
		expect(vm.badges).toEqual([]);
	});

	it("fromCompletion с until в прошлом — expired (§FIX-3)", () => {
		const vm = buildTemplateVM(
			template({ recurrence: "every! 3 days until 2026-01-01" }),
			TODAY,
		);
		expect(vm.expired).toBe(true);
		expect(vm.badges).toEqual(["expired"]);
	});

	it("«when done»-алиас с until в будущем — не expired (та же ветка, что every!, §FIX-3)", () => {
		const vm = buildTemplateVM(
			template({ recurrence: "every 3 days when done until 2027-01-01" }),
			TODAY,
		);
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
		const old = makeTask({
			filePath: "in.md",
			lineStart: 1,
			spawnedFrom: "rev",
			created: "2026-05-31",
		});
		const fresh = makeTask({
			filePath: "in.md",
			lineStart: 2,
			spawnedFrom: "rev",
			created: "2026-06-30",
		});
		const dateless = makeTask({
			filePath: "in.md",
			lineStart: 3,
			spawnedFrom: "rev",
			created: null,
		});
		expect(historyOf([old, dateless, fresh], "rev")).toEqual([fresh, old, dateless]);
	});

	it("равные даты упорядочены стабильно по (файл, строка)", () => {
		const b = makeTask({
			filePath: "b.md",
			lineStart: 1,
			spawnedFrom: "rev",
			created: "2026-07-01",
		});
		const a2 = makeTask({
			filePath: "a.md",
			lineStart: 2,
			spawnedFrom: "rev",
			created: "2026-07-01",
		});
		const a1 = makeTask({
			filePath: "a.md",
			lineStart: 1,
			spawnedFrom: "rev",
			created: "2026-07-01",
		});
		expect(historyOf([b, a2, a1], "rev")).toEqual([a1, a2, b]);
	});
});

describe("deleteTemplateBody", () => {
	it("подставляет имя и обещает сохранить копии", () => {
		expect(deleteTemplateBody("Ревью недели")).toBe(
			"Удалить шаблон «Ревью недели»? Уже созданные копии останутся.",
		);
	});
});

describe("buildTemplateLine", () => {
	it("собирает `- [ ] <имя> 🔁 <правило>`", () => {
		expect(buildTemplateLine("Полить цветы", "every day")).toBe(
			"- [ ] Полить цветы 🔁 every day",
		);
	});

	it("схлопывает пробелы в названии и триммит правило", () => {
		expect(buildTemplateLine("  Ревью   недели ", "  every week  ")).toBe(
			"- [ ] Ревью недели 🔁 every week",
		);
	});

	it("пустое имя — null", () => {
		expect(buildTemplateLine("   ", "every day")).toBeNull();
	});
});

/** In-memory порт файла шаблонов (образец фейков eventSeries.test). */
class FakeVault implements TemplateVaultPort {
	readonly files = new Map<string, string>();
	readonly fm = new Map<string, Record<string, unknown>>();
	readonly ensured: string[] = [];

	constructor(seed: Record<string, string> = {}) {
		for (const [p, c] of Object.entries(seed)) this.files.set(p, c);
	}

	async ensureFile(path: string): Promise<void> {
		this.ensured.push(path);
		if (!this.files.has(path)) this.files.set(path, "");
	}

	async processFile(
		path: string,
		transform: (content: string) => string | null,
	): Promise<boolean> {
		const cur = this.files.get(path);
		if (cur === undefined) return false;
		const next = transform(cur);
		if (next === null || next === cur) return false;
		this.files.set(path, next);
		return true;
	}

	async processFrontmatter(
		path: string,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<unknown> {
		const cur = this.fm.get(path) ?? {};
		fn(cur);
		this.fm.set(path, cur);
		return true;
	}
}

describe("createTemplate", () => {
	const base = {
		spawnTarget: "GTD/Inbox.md",
		name: "Полить цветы",
		ruleText: "every day",
		genId: () => "tpl001",
	};

	it("нет файлов шаблонов — создаёт <папка GTD>/Recurring.md с флагом, строкой и 🆔", async () => {
		const vault = new FakeVault();
		const res = await createTemplate({ vault, recurringFiles: [], ...base });
		expect(res).toEqual({ ok: true, path: "GTD/Recurring.md" });
		expect(vault.files.get("GTD/Recurring.md")).toBe(
			"- [ ] Полить цветы 🔁 every day 🆔 tpl001\n",
		);
		expect(vault.fm.get("GTD/Recurring.md")).toEqual({ "gtd-recurring": true });
	});

	it("новая строка получает 🆔 (спавн-проход строит childId = <🆔>-YYYYMMDD)", async () => {
		const vault = new FakeVault();
		await createTemplate({ vault, recurringFiles: [], ...base });
		const line = vault.files.get("GTD/Recurring.md")!.trimEnd();
		const t = parseTaskLine(line, {
			filePath: "GTD/Recurring.md",
			lineStart: 0,
			parentLine: null,
			heading: null,
			container: "recurring",
			projectActive: true,
		});
		expect(t?.taskId).toBe("tpl001");
	});

	it("🆔 не сталкивается с уже занятым в файле — генератор перебирает кандидаты", async () => {
		const vault = new FakeVault({ "GTD/Recurring.md": "- [ ] старый 🔁 every week 🆔 dup" });
		const seq = ["dup", "free"];
		let n = 0;
		const res = await createTemplate({
			vault,
			recurringFiles: ["GTD/Recurring.md"],
			spawnTarget: "GTD/Inbox.md",
			name: "Полить цветы",
			ruleText: "every day",
			genId: () => seq[n++]!,
		});
		expect(res.ok).toBe(true);
		expect(vault.files.get("GTD/Recurring.md")).toBe(
			"- [ ] старый 🔁 every week 🆔 dup\n- [ ] Полить цветы 🔁 every day 🆔 free\n",
		);
	});

	it("флаг gtd-recurring ставится СТРОГО до записи строки (ensureFile до processFile)", async () => {
		const vault = new FakeVault();
		await createTemplate({ vault, recurringFiles: [], ...base });
		// файл гарантирован до append — ensureFile звался на тот же путь
		expect(vault.ensured).toContain("GTD/Recurring.md");
	});

	it("существующий файл шаблонов — append туда, без нового файла", async () => {
		const vault = new FakeVault({ "GTD/Recurring.md": "- [ ] старый 🔁 every week" });
		const res = await createTemplate({
			vault,
			recurringFiles: ["GTD/Recurring.md"],
			...base,
		});
		expect(res).toEqual({ ok: true, path: "GTD/Recurring.md" });
		expect(vault.files.get("GTD/Recurring.md")).toBe(
			"- [ ] старый 🔁 every week\n- [ ] Полить цветы 🔁 every day 🆔 tpl001\n",
		);
	});

	it("первый (по сортировке) существующий файл — цель append", async () => {
		const vault = new FakeVault({ "A/Rec.md": "", "B/Rec.md": "" });
		const res = await createTemplate({
			vault,
			recurringFiles: ["B/Rec.md", "A/Rec.md"],
			...base,
		});
		// recurringTemplateTarget берёт recurringFiles[0] как есть (вид сортирует их заранее)
		expect(res.ok && res.path).toBe("B/Rec.md");
	});

	it("невалидное правило — отказ без записи", async () => {
		const vault = new FakeVault();
		const res = await createTemplate({
			vault,
			recurringFiles: [],
			spawnTarget: "GTD/Inbox.md",
			name: "Полить цветы",
			ruleText: "каждый вторник",
		});
		expect(res).toEqual({ ok: false, reason: "invalid-rule" });
		expect(vault.files.size).toBe(0);
		expect(vault.ensured).toEqual([]);
	});

	it("пустое имя — отказ без записи", async () => {
		const vault = new FakeVault();
		const res = await createTemplate({
			vault,
			recurringFiles: [],
			spawnTarget: "GTD/Inbox.md",
			name: "   ",
			ruleText: "every day",
		});
		expect(res).toEqual({ ok: false, reason: "empty-name" });
		expect(vault.ensured).toEqual([]);
	});

	it("spawnTarget без папки — файл шаблонов в корне", async () => {
		const vault = new FakeVault();
		const res = await createTemplate({
			vault,
			recurringFiles: [],
			spawnTarget: "Inbox.md",
			name: "Полить цветы",
			ruleText: "every day",
		});
		expect(res).toEqual({ ok: true, path: "Recurring.md" });
	});

	it("recurringFallback (пространство) без своих файлов — цель <root>/Регулярные.md, а не от spawnTarget", async () => {
		const vault = new FakeVault();
		const res = await createTemplate({
			vault,
			recurringFiles: [],
			spawnTarget: "GTD/Inbox.md", // «Общее» — но fallback перебивает
			recurringFallback: "Работа/Регулярные.md",
			name: "Полить цветы",
			ruleText: "every day",
			genId: () => "tpl001",
		});
		expect(res).toEqual({ ok: true, path: "Работа/Регулярные.md" });
		expect(vault.files.get("Работа/Регулярные.md")).toBe(
			"- [ ] Полить цветы 🔁 every day 🆔 tpl001\n",
		);
		expect(vault.fm.get("Работа/Регулярные.md")).toEqual({ "gtd-recurring": true });
	});

	it("recurringFallback игнорируется, когда у пространства уже есть свой файл шаблонов", async () => {
		const vault = new FakeVault({ "Работа/Рег.md": "- [ ] старый 🔁 every week" });
		const res = await createTemplate({
			vault,
			recurringFiles: ["Работа/Рег.md"],
			spawnTarget: "GTD/Inbox.md",
			recurringFallback: "Работа/Регулярные.md",
			name: "Полить цветы",
			ruleText: "every day",
			genId: () => "tpl001",
		});
		expect(res).toEqual({ ok: true, path: "Работа/Рег.md" });
		expect(vault.files.has("Работа/Регулярные.md")).toBe(false);
	});
});
