/**
 * Smoke-тест СОБРАННОГО бандла в изолированном контексте, эмулирующем QuickJS:
 * ни process, ни require, ни module — только ES-интринсики + минимальный console.
 * Бандлим тем же способом, что esbuild.widget.mjs (iife/neutral/es2020, globalName
 * GtdWidgetCore), берём код строкой (write:false) и исполняем через node:vm. Это
 * ловит протечки, которые не видны при импортe .ts напрямую: например, обращение к
 * process на верхнем уровне модуля упало бы здесь при исполнении бандла.
 */
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { describe, expect, it } from "vitest";

async function bundle(): Promise<string> {
	const res = await esbuild.build({
		entryPoints: [fileURLToPath(new URL("./widgetCore.ts", import.meta.url))],
		bundle: true,
		platform: "neutral",
		format: "iife",
		globalName: "GtdWidgetCore",
		target: "es2020",
		write: false,
		logLevel: "silent",
	});
	return res.outputFiles[0]!.text;
}

interface WidgetApi {
	computeWidgetData(input: unknown): Promise<string>;
	buildCaptureLine(text: string, location?: string | null, todayIso?: string | null): string;
	captureTargetPath(dataJson: string | null, namespace?: string | null): string;
	buildEditedLine(rawLine: string, edits: unknown): string;
	parseNlDate(
		text: string,
		today: string,
	): { title: string; date: string | null; time: string | null } | null;
}

describe("widget-core bundle в QuickJS-подобном контексте", () => {
	it("исполняется без process/require и отдаёт рабочий API", async () => {
		const code = await bundle();

		// контекст без node-глобалов: только console-заглушка
		const sandbox: Record<string, unknown> = {
			console: { log() {}, error() {}, warn() {}, info() {} },
		};
		vm.createContext(sandbox);

		// доказываем минимализм окружения: node-примитивов нет
		const probe = vm.runInContext(
			"typeof process + ',' + typeof require + ',' + typeof module + ',' + typeof setTimeout",
			sandbox,
		);
		expect(probe).toBe("undefined,undefined,undefined,undefined");

		// исполняем бандл — верхний уровень не должен трогать отсутствующие глобалы
		vm.runInContext(code, sandbox);
		const api = sandbox.GtdWidgetCore as WidgetApi;
		expect(typeof api.computeWidgetData).toBe("function");
		expect(typeof api.buildCaptureLine).toBe("function");
		expect(typeof api.captureTargetPath).toBe("function");
		expect(typeof api.buildEditedLine).toBe("function");
		expect(typeof api.parseNlDate).toBe("function");

		const json = await api.computeWidgetData({
			files: {
				"GTD/Входящие.md": "---\ngtd-inbox: true\n---\n- [ ] задача из виджета\n",
				"GTD/События.md":
					"---\ngtd-events: true\n---\n" +
					"- [ ] Встреча 📅 2026-07-20 10:00\n" +
					"- [ ] Планёрка 🔁 every day at 09:00\n",
			},
			dataJson: null,
			todayIso: "2026-07-20",
			nowMinutes: 8 * 60 + 30,
			inboxNamespace: null,
			agendaDays: 3,
		});
		const data = JSON.parse(json) as {
			today: {
				items: { title: string; itemKind: string; rawLine: string }[];
				generatedAt: string;
			};
			agenda: { days: { date: string; items: { title: string }[] }[] };
			inbox: { items: { title: string; namespace: string }[] };
			errors: string[];
		};
		expect(data.errors).toEqual([]);
		expect(data.inbox.items.map((i) => i.title)).toEqual(["задача из виджета"]);
		expect(data.inbox.items[0]!.namespace).toBe("Общее");
		expect(data.today.items.map((i) => i.title)).toEqual(["Планёрка", "Встреча"]);
		expect(data.today.items.find((i) => i.title === "Встреча")!.itemKind).toBe("single-event");
		expect(data.today.generatedAt).toBe("2026-07-20T08:30");
		// агенда: 3 дня от todayIso; серия «Планёрка» ежедневная — во всех днях
		expect(data.agenda.days.map((d) => d.date)).toEqual([
			"2026-07-20",
			"2026-07-21",
			"2026-07-22",
		]);
		expect(data.agenda.days.every((d) => d.items.some((i) => i.title === "Планёрка"))).toBe(
			true,
		);

		// синхронные экспорты тоже работают в этом контексте
		expect(api.buildCaptureLine("купить хлеб")).toBe("- [ ] купить хлеб");
		expect(api.captureTargetPath(null, null)).toBe("GTD/Входящие.md");

		// NLP-даты работают из бандла: и напрямую, и через buildCaptureLine(todayIso)
		expect(api.parseNlDate("завтра позвонить", "2026-07-20")).toEqual({
			title: "позвонить",
			date: "2026-07-21",
			time: null,
		});
		expect(api.buildCaptureLine("завтра в 15 звонок", null, "2026-07-20")).toBe(
			"- [ ] звонок 📅 2026-07-21 15:00",
		);

		// buildEditedLine — синхронная правка строки, JSON-результат
		const edited = JSON.parse(
			api.buildEditedLine("- [ ] задача из виджета", { title: "переименовано" }),
		) as {
			ok: boolean;
			line?: string;
		};
		expect(edited).toEqual({ ok: true, line: "- [ ] переименовано" });
	});
});
