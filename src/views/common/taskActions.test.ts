import { describe, expect, it } from "vitest";
import type { Intent } from "../../core/intents/Intent";
import type { IntentResult } from "../../services/WritebackService";
import { makeTask } from "../../stores/testSupport";
import { DEFAULT_NS, type NamespaceDef } from "../../core/namespace/namespace";
import {
	captureTarget,
	captureTargetInNamespace,
	captureTargets,
	captureTargetsInNamespace,
	ensureArchiveFile,
	ensureCaptureFile,
	ensureCaptureFileNs,
	findTaskAtLine,
	moveTaskToTemplates,
	nlCaptureHint,
	quickCaptureLine,
	quickCaptureLineNl,
	recurringFilePaths,
	recurringFilePathsInNamespace,
	recurringTemplateTarget,
} from "./taskActions";

describe("quickCaptureLine: санитация быстрого ввода", () => {
	it("обычный текст → строка захвата", () => {
		expect(quickCaptureLine("Купить хлеб")).toBe("- [ ] Купить хлеб");
	});

	it("обрезает пробелы и схлопывает внутренние", () => {
		expect(quickCaptureLine("  Купить   хлеб  ")).toBe("- [ ] Купить хлеб");
	});

	it("переводы строк схлопываются — многострочный ввод не разваливает файл", () => {
		expect(quickCaptureLine("Купить\r\nхлеб\nи молоко")).toBe("- [ ] Купить хлеб и молоко");
	});

	it("пусто/пробелы → null (не пишем)", () => {
		expect(quickCaptureLine("")).toBeNull();
		expect(quickCaptureLine("   \n  ")).toBeNull();
	});

	it("уже набранный префикс задачи срезается — двойного чекбокса нет", () => {
		expect(quickCaptureLine("- [ ] Купить хлеб")).toBe("- [ ] Купить хлеб");
		expect(quickCaptureLine("- [x] Купить хлеб")).toBe("- [ ] Купить хлеб");
		expect(quickCaptureLine("* [/] Купить хлеб")).toBe("- [ ] Купить хлеб");
	});

	it("голый префикс без текста → null", () => {
		expect(quickCaptureLine("- [ ] ")).toBeNull();
	});

	it("минус-текст не принимается за префикс", () => {
		expect(quickCaptureLine("-5 градусов утром")).toBe("- [ ] -5 градусов утром");
	});
});

describe("quickCaptureLineNl: быстрый ввод с NLP-датами", () => {
	const WED = "2026-07-22"; // среда

	it("today=null — полное соответствие quickCaptureLine (без дат)", () => {
		expect(quickCaptureLineNl("завтра встреча", null)).toBe("- [ ] завтра встреча");
		expect(quickCaptureLineNl("  ", null)).toBeNull();
	});

	it("дата+время → 📅 <дата> HH:mm", () => {
		expect(quickCaptureLineNl("завтра в 15 позвонить маме", WED)).toBe(
			"- [ ] позвонить маме 📅 2026-07-23 15:00",
		);
	});

	it("интервал → 📅 <дата> HH:mm-HH:mm", () => {
		expect(quickCaptureLineNl("с 14 до 16 совещание", WED)).toBe(
			"- [ ] совещание 📅 2026-07-22 14:00-16:00",
		);
	});

	it("только дата → 📅 без времени", () => {
		expect(quickCaptureLineNl("через 3 дня отчёт", WED)).toBe("- [ ] отчёт 📅 2026-07-25");
	});

	it("нет выражения → обычная строка", () => {
		expect(quickCaptureLineNl("купить молоко", WED)).toBe("- [ ] купить молоко");
	});

	it("escape: слово в кавычках → без даты, кавычки сняты", () => {
		expect(quickCaptureLineNl('"завтра" встреча', WED)).toBe("- [ ] завтра встреча");
	});

	it("пустой title после вырезания → берём исходный текст как есть", () => {
		expect(quickCaptureLineNl("завтра", WED)).toBe("- [ ] завтра");
	});
});

describe("nlCaptureHint: живая подсказка распознанной даты", () => {
	const WED = "2026-07-22"; // среда

	it("дата + время — «📅 чт 23 июл · 15:00»", () => {
		expect(nlCaptureHint("завтра в 15 позвонить", WED)).toBe("📅 чт 23 июл · 15:00");
	});

	it("только дата — без времени", () => {
		expect(nlCaptureHint("15 августа поездка", WED)).toBe("📅 сб 15 авг");
	});

	it("интервал — en-dash", () => {
		expect(nlCaptureHint("с 14 до 16 совещание", WED)).toBe("📅 ср 22 июл · 14:00–16:00");
	});

	it("нет даты / только escape → null (подсказки нет)", () => {
		expect(nlCaptureHint("купить молоко", WED)).toBeNull();
		expect(nlCaptureHint('"завтра" купить', WED)).toBeNull();
	});
});

describe("findTaskAtLine: задача под курсором", () => {
	const PATH = "GTD/Inbox.md";

	it("по 🆔 — даже если описание в индексе разошлось со строкой", () => {
		const t = makeTask({
			filePath: PATH,
			taskId: "abc123",
			description: "старый текст",
			lineStart: 3,
		});
		const found = findTaskAtLine([t], "- [ ] новый текст 🆔 abc123", PATH, 10);
		expect(found).toBe(t);
	});

	it("без 🆔 — по описанию среди задач без id", () => {
		const withId = makeTask({
			filePath: PATH,
			taskId: "x1",
			description: "Купить хлеб",
			lineStart: 0,
		});
		const noId = makeTask({
			filePath: PATH,
			taskId: null,
			description: "Купить хлеб",
			lineStart: 5,
		});
		const found = findTaskAtLine([withId, noId], "- [ ] Купить хлеб", PATH, 5);
		expect(found).toBe(noId); // строка без 🆔 не захватывает носителя id
	});

	it("из нескольких кандидатов — ближайший к строке курсора", () => {
		const a = makeTask({ filePath: PATH, taskId: null, description: "дубль", lineStart: 1 });
		const b = makeTask({ filePath: PATH, taskId: null, description: "дубль", lineStart: 20 });
		expect(findTaskAtLine([a, b], "- [ ] дубль", PATH, 18)).toBe(b);
		expect(findTaskAtLine([a, b], "- [ ] дубль", PATH, 2)).toBe(a);
	});

	it("строка не задача → null", () => {
		expect(findTaskAtLine([makeTask({ filePath: PATH })], "просто текст", PATH, 0)).toBeNull();
	});

	it("нет совпадений (индекс отстал) → null", () => {
		const t = makeTask({ filePath: PATH, description: "другое" });
		expect(findTaskAtLine([t], "- [ ] новая строка", PATH, 0)).toBeNull();
	});
});

describe("recurringFilePaths / recurringTemplateTarget", () => {
	it("собирает уникальные пути gtd-recurring файлов, сортированные", () => {
		const tasks = [
			makeTask({ filePath: "b.md", container: "recurring" }),
			makeTask({ filePath: "a.md", container: "recurring" }),
			makeTask({ filePath: "b.md", container: "recurring" }),
			makeTask({ filePath: "plain.md", container: "plain" }),
			makeTask({ filePath: "board.md", container: "board" }),
		];
		expect(recurringFilePaths(tasks)).toEqual(["a.md", "b.md"]);
	});

	it("есть файл шаблонов → первый по сортировке, без создания", () => {
		expect(recurringTemplateTarget(["a.md", "b.md"], "GTD/Inbox.md")).toEqual({
			path: "a.md",
			create: false,
		});
	});

	it("файлов нет → <папка spawnTarget>/Recurring.md с созданием", () => {
		expect(recurringTemplateTarget([], "GTD/Inbox.md")).toEqual({
			path: "GTD/Recurring.md",
			create: true,
		});
	});

	it("spawnTarget в корне vault → Recurring.md в корне", () => {
		expect(recurringTemplateTarget([], "Inbox.md")).toEqual({
			path: "Recurring.md",
			create: true,
		});
	});
});

describe("captureTargets / captureTarget: цели записи быстрого ввода", () => {
	it("нет gtd-inbox файлов → пустой список, цель = первый фолбэк", () => {
		const tasks = [
			makeTask({ filePath: "a.md", container: "plain" }),
			makeTask({ filePath: "b.md", container: "board" }),
		];
		expect(captureTargets(tasks)).toEqual([]);
		expect(captureTarget(tasks, ["GTD/Inbox.md"])).toBe("GTD/Inbox.md");
	});

	it("один gtd-inbox файл → он и есть цель (фолбэк не используется)", () => {
		const tasks = [
			makeTask({ filePath: "GTD/Capture.md", container: "inbox" }),
			makeTask({ filePath: "other.md", container: "plain" }),
		];
		expect(captureTargets(tasks)).toEqual(["GTD/Capture.md"]);
		expect(captureTarget(tasks, ["GTD/Inbox.md"])).toBe("GTD/Capture.md");
	});

	it("несколько gtd-inbox файлов → уникальные и сортированные, цель = первый", () => {
		const tasks = [
			makeTask({ filePath: "GTD/Работа.md", container: "inbox" }),
			makeTask({ filePath: "GTD/Быт.md", container: "inbox" }),
			makeTask({ filePath: "GTD/Работа.md", container: "inbox" }), // дубль пути
		];
		expect(captureTargets(tasks)).toEqual(["GTD/Быт.md", "GTD/Работа.md"]);
		expect(captureTarget(tasks, ["GTD/Inbox.md"])).toBe("GTD/Быт.md");
	});

	it("ни помеченных файлов, ни фолбэка → undefined (вызывающий не пишет)", () => {
		expect(captureTarget([], [])).toBeUndefined();
	});
});

describe("captureTargetsInNamespace / captureTargetInNamespace: цели per-namespace", () => {
	const WORK: NamespaceDef = { name: "Работа", root: "Work" };
	const LIFE: NamespaceDef = { name: "Жизнь", root: "Личное" };
	const defs = [WORK, LIFE];

	it("оставляет только gtd-inbox файлы активного пространства (по папке)", () => {
		const tasks = [
			makeTask({ filePath: "Work/Входящие.md", container: "inbox" }),
			makeTask({ filePath: "Личное/Входящие.md", container: "inbox" }),
			makeTask({ filePath: "Разное/capture.md", container: "inbox" }),
		];
		expect(captureTargetsInNamespace(tasks, "Работа", defs)).toEqual(["Work/Входящие.md"]);
		expect(captureTargetsInNamespace(tasks, "Жизнь", defs)).toEqual(["Личное/Входящие.md"]);
		// «Общее» — только файлы вне корней
		expect(captureTargetsInNamespace(tasks, DEFAULT_NS, defs)).toEqual(["Разное/capture.md"]);
	});

	it("frontmatter-override уводит файл в чужое пространство", () => {
		const tasks = [
			// физически в Work/, но override → «Жизнь»
			makeTask({ filePath: "Work/личное.md", container: "inbox", nsOverride: "Жизнь" }),
		];
		expect(captureTargetsInNamespace(tasks, "Работа", defs)).toEqual([]);
		expect(captureTargetsInNamespace(tasks, "Жизнь", defs)).toEqual(["Work/личное.md"]);
	});

	it("цель = первый файл пространства, иначе fallback (конвенция считается снаружи)", () => {
		const tasks = [makeTask({ filePath: "Личное/Входящие.md", container: "inbox" })];
		// в «Работе» своих файлов нет → fallback
		expect(captureTargetInNamespace(tasks, "Работа", defs, "Work/Входящие.md")).toBe(
			"Work/Входящие.md",
		);
		// в «Жизни» есть свой файл → он, не fallback
		expect(captureTargetInNamespace(tasks, "Жизнь", defs, "Личное/Входящие.md")).toBe(
			"Личное/Входящие.md",
		);
	});

	it("пустой defs ⇒ DEFAULT_NS ловит все inbox-файлы (обратная совместимость)", () => {
		const tasks = [
			makeTask({ filePath: "GTD/Capture.md", container: "inbox" }),
			makeTask({ filePath: "any/x.md", container: "inbox" }),
		];
		expect(captureTargetsInNamespace(tasks, DEFAULT_NS, [])).toEqual([
			"GTD/Capture.md",
			"any/x.md",
		]);
	});
});

describe("recurringFilePathsInNamespace: шаблоны per-namespace", () => {
	const WORK: NamespaceDef = { name: "Работа", root: "Work" };
	const LIFE: NamespaceDef = { name: "Жизнь", root: "Личное" };
	const defs = [WORK, LIFE];

	it("оставляет только gtd-recurring файлы активного пространства", () => {
		const tasks = [
			makeTask({ filePath: "Work/Регулярные.md", container: "recurring" }),
			makeTask({ filePath: "Личное/Регулярные.md", container: "recurring" }),
			makeTask({ filePath: "Work/other.md", container: "plain" }), // не recurring
		];
		expect(recurringFilePathsInNamespace(tasks, "Работа", defs)).toEqual([
			"Work/Регулярные.md",
		]);
		expect(recurringFilePathsInNamespace(tasks, "Жизнь", defs)).toEqual([
			"Личное/Регулярные.md",
		]);
	});
});

describe("ensureCaptureFileNs: gtd-inbox + условный gtd-namespace override", () => {
	const WORK: NamespaceDef = { name: "Работа", root: "Work" };
	const defs = [WORK];

	function fakeVault() {
		const fm: Record<string, unknown> = {};
		return {
			fm,
			vault: {
				ensureFile: async (): Promise<void> => {},
				processFrontmatter: async (
					_path: string,
					fn: (fm: Record<string, unknown>) => void,
				): Promise<void> => {
					fn(fm);
				},
			},
		};
	}

	it("файл ВНУТРИ корня именованного пространства — только gtd-inbox (override не нужен)", async () => {
		const f = fakeVault();
		const ok = await ensureCaptureFileNs(f.vault, "Work/Входящие.md", "Работа", defs);
		expect(ok).toBe(true);
		expect(f.fm).toEqual({ "gtd-inbox": true });
	});

	it("файл ВНЕ корня именованного пространства — добавляет gtd-namespace override", async () => {
		const f = fakeVault();
		const ok = await ensureCaptureFileNs(f.vault, "Разное/capture.md", "Работа", defs);
		expect(ok).toBe(true);
		expect(f.fm).toEqual({ "gtd-inbox": true, "gtd-namespace": "Работа" });
	});

	it("DEFAULT_NS — override не пишется никогда", async () => {
		const f = fakeVault();
		const ok = await ensureCaptureFileNs(f.vault, "Разное/capture.md", DEFAULT_NS, defs);
		expect(ok).toBe(true);
		expect(f.fm).toEqual({ "gtd-inbox": true });
	});
});

describe("ensureArchiveFile: файл архива с флагом gtd-archive", () => {
	function fakeVault(over?: { ensureFile?: () => Promise<void> }) {
		const calls: string[] = [];
		const fm: Record<string, unknown> = {};
		return {
			calls,
			fm,
			vault: {
				ensureFile: async (path: string): Promise<void> => {
					if (over?.ensureFile) return over.ensureFile();
					calls.push(`ensure:${path}`);
				},
				processFrontmatter: async (
					path: string,
					fn: (fm: Record<string, unknown>) => void,
				): Promise<void> => {
					calls.push(`frontmatter:${path}`);
					fn(fm);
				},
			},
		};
	}

	it("ensureFile → processFrontmatter ставит gtd-archive: true (порядок сохранён)", async () => {
		const f = fakeVault();
		const ok = await ensureArchiveFile(f.vault, "GTD/Archive.md");
		expect(ok).toBe(true);
		expect(f.calls).toEqual(["ensure:GTD/Archive.md", "frontmatter:GTD/Archive.md"]);
		expect(f.fm).toEqual({ "gtd-archive": true });
	});

	it("идемпотентно: у файла с уже стоящим флагом флаг остаётся true", async () => {
		const f = fakeVault();
		f.fm["gtd-archive"] = true;
		const ok = await ensureArchiveFile(f.vault, "GTD/Archive.md");
		expect(ok).toBe(true);
		expect(f.fm).toEqual({ "gtd-archive": true });
	});

	it("ensureFile упал → false, флаг не ставится", async () => {
		const f = fakeVault({
			ensureFile: () => Promise.reject(new Error("disk full")),
		});
		const ok = await ensureArchiveFile(f.vault, "GTD/Archive.md");
		expect(ok).toBe(false);
		expect(f.fm).toEqual({});
	});
});

describe("ensureCaptureFile: файл входящих с флагом gtd-inbox", () => {
	function fakeVault(over?: { ensureFile?: () => Promise<void> }) {
		const calls: string[] = [];
		const fm: Record<string, unknown> = {};
		return {
			calls,
			fm,
			vault: {
				ensureFile: async (path: string): Promise<void> => {
					if (over?.ensureFile) return over.ensureFile();
					calls.push(`ensure:${path}`);
				},
				processFrontmatter: async (
					path: string,
					fn: (fm: Record<string, unknown>) => void,
				): Promise<void> => {
					calls.push(`frontmatter:${path}`);
					fn(fm);
				},
			},
		};
	}

	it("ensureFile → processFrontmatter ставит gtd-inbox: true (порядок сохранён)", async () => {
		const f = fakeVault();
		const ok = await ensureCaptureFile(f.vault, "GTD/Inbox.md");
		expect(ok).toBe(true);
		expect(f.calls).toEqual(["ensure:GTD/Inbox.md", "frontmatter:GTD/Inbox.md"]);
		expect(f.fm).toEqual({ "gtd-inbox": true });
	});

	it("идемпотентно: у файла с уже стоящим флагом флаг остаётся true", async () => {
		const f = fakeVault();
		f.fm["gtd-inbox"] = true;
		const ok = await ensureCaptureFile(f.vault, "GTD/Inbox.md");
		expect(ok).toBe(true);
		expect(f.fm).toEqual({ "gtd-inbox": true });
	});

	it("ensureFile упал → false, флаг не ставится", async () => {
		const f = fakeVault({
			ensureFile: () => Promise.reject(new Error("disk full")),
		});
		const ok = await ensureCaptureFile(f.vault, "GTD/Inbox.md");
		expect(ok).toBe(false);
		expect(f.fm).toEqual({});
	});
});

describe("moveTaskToTemplates", () => {
	function fakes() {
		const calls: string[] = [];
		const fm: Record<string, unknown> = {};
		const intents: Intent[] = [];
		return {
			calls,
			fm,
			intents,
			vault: {
				ensureFile: async (path: string): Promise<void> => {
					calls.push(`ensure:${path}`);
				},
				processFrontmatter: async (
					path: string,
					fn: (fm: Record<string, unknown>) => void,
				): Promise<void> => {
					calls.push(`frontmatter:${path}`);
					fn(fm);
				},
			},
			dispatcher: {
				dispatch: async (intent: Intent): Promise<IntentResult> => {
					intents.push(intent);
					return { ok: true };
				},
			},
		};
	}

	it("существующий файл шаблонов: только move-line, без создания", async () => {
		const f = fakes();
		const res = await moveTaskToTemplates({
			taskKey: "k1",
			recurringFiles: ["GTD/Recurring.md"],
			spawnTarget: "GTD/Inbox.md",
			vault: f.vault,
			dispatcher: f.dispatcher,
		});
		expect(res.ok).toBe(true);
		expect(f.calls).toEqual([]); // ensure/frontmatter не звались
		expect(f.intents).toEqual([{ type: "move-line", key: "k1", toFile: "GTD/Recurring.md" }]);
	});

	it("файла нет: создание + frontmatter СТРОГО до move-line", async () => {
		const f = fakes();
		const res = await moveTaskToTemplates({
			taskKey: "k2",
			recurringFiles: [],
			spawnTarget: "GTD/Inbox.md",
			vault: f.vault,
			dispatcher: {
				dispatch: async (intent: Intent): Promise<IntentResult> => {
					f.calls.push(`dispatch:${intent.type}`);
					f.intents.push(intent);
					return { ok: true };
				},
			},
		});
		expect(res.ok).toBe(true);
		expect(f.calls).toEqual([
			"ensure:GTD/Recurring.md",
			"frontmatter:GTD/Recurring.md",
			"dispatch:move-line",
		]);
		expect(f.fm).toEqual({ "gtd-recurring": true });
		expect(f.intents).toEqual([{ type: "move-line", key: "k2", toFile: "GTD/Recurring.md" }]);
	});

	it("создание файла упало → {ok:false}, строку не трогаем", async () => {
		const f = fakes();
		const res = await moveTaskToTemplates({
			taskKey: "k3",
			recurringFiles: [],
			spawnTarget: "GTD/Inbox.md",
			vault: {
				ensureFile: async () => {
					throw new Error("disk full");
				},
				processFrontmatter: f.vault.processFrontmatter,
			},
			dispatcher: f.dispatcher,
		});
		expect(res).toEqual({ ok: false, reason: "template-file-create-failed" });
		expect(f.intents).toEqual([]);
	});

	it("ошибка move-line пробрасывается как есть", async () => {
		const f = fakes();
		const res = await moveTaskToTemplates({
			taskKey: "k4",
			recurringFiles: ["R.md"],
			spawnTarget: "GTD/Inbox.md",
			vault: f.vault,
			dispatcher: {
				dispatch: async (): Promise<IntentResult> => ({
					ok: false,
					reason: "task-not-found",
				}),
			},
		});
		expect(res).toEqual({ ok: false, reason: "task-not-found" });
	});
});
