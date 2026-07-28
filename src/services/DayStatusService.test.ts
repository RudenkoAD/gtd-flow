import { describe, expect, it } from "vitest";
import { DayStatusService, type DayStatusDeps } from "./DayStatusService";

// ---------------------------------------------------------------------------
// Обвязка: файлы/frontmatter в памяти. discoverFile ищет флаг gtd-day-status.
// ---------------------------------------------------------------------------

interface Harness {
	service: DayStatusService;
	frontmatters: Map<string, Record<string, unknown>>;
	contents: Map<string, string>;
	files: Set<string>;
	ensured: string[];
	statusesAt: (path: string) => Record<string, unknown>;
}

function makeHarness(opts?: {
	defaultPath?: string;
	seed?: Record<string, Record<string, unknown>>;
	processFile?: DayStatusDeps["processFile"];
	processFrontmatter?: DayStatusDeps["processFrontmatter"];
}): Harness {
	const defaultPath = opts?.defaultPath ?? "GTD/Статусы дней.md";
	const frontmatters = new Map<string, Record<string, unknown>>();
	const contents = new Map<string, string>();
	const files = new Set<string>();
	const ensured: string[] = [];

	for (const [path, fm] of Object.entries(opts?.seed ?? {})) {
		frontmatters.set(path, { ...fm });
		contents.set(path, "");
		files.add(path);
	}

	const discoverFile = (): string | null => {
		for (const [path, fm] of frontmatters) {
			if (fm["gtd-day-status"] === true) return path;
		}
		return null;
	};

	const deps: DayStatusDeps = {
		discoverFile,
		readFrontmatter: (path) => frontmatters.get(path) ?? null,
		readFile: async (path) => (files.has(path) ? (contents.get(path) ?? "") : null),
		processFile:
			opts?.processFile ??
			(async (path, transform) => {
				const cur = contents.get(path) ?? "";
				const next = transform(cur);
				if (next === null || next === cur) return false;
				contents.set(path, next);
				return true;
			}),
		ensureFile: async (path) => {
			ensured.push(path);
			if (!files.has(path)) {
				files.add(path);
				contents.set(path, "");
			}
		},
		processFrontmatter:
			opts?.processFrontmatter ??
			(async (path, fn) => {
				if (!files.has(path)) return false;
				const fm = frontmatters.get(path) ?? {};
				fn(fm);
				frontmatters.set(path, fm);
				return true;
			}),
		defaultFilePath: () => defaultPath,
		onVaultChange: () => {},
	};

	const service = new DayStatusService(deps);
	const statusesAt = (path: string): Record<string, unknown> =>
		(frontmatters.get(path)?.["statuses"] as Record<string, unknown>) ?? {};
	return { service, frontmatters, contents, files, ensured, statusesAt };
}

describe("DayStatusService.setStatusDef", () => {
	it("на чистом хранилище создаёт файл со стартовой палитрой и добавляет статус", async () => {
		const h = makeHarness();
		await h.service.setStatusDef("отпуск", "#ff0000");

		const path = "GTD/Статусы дней.md";
		expect(h.ensured).toContain(path);
		expect(h.frontmatters.get(path)?.["gtd-day-status"]).toBe(true);
		// стартовая палитра сохранена + новый ключ
		expect(h.statusesAt(path)).toMatchObject({ работаю: "#4c8bf5", отпуск: "#ff0000" });
		// модель обновлена после refresh
		expect(h.service.statuses()).toContainEqual({ name: "отпуск", color: "#ff0000" });
	});

	it("upsert: меняет цвет существующего ключа, добавляет новый", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { работаю: "#111111" } } },
		});
		await h.service.setStatusDef("работаю", "#222222");
		await h.service.setStatusDef("новый", "#00ff00");

		expect(h.statusesAt(path)).toEqual({ работаю: "#222222", новый: "#00ff00" });
		expect(h.service.statuses()).toEqual([
			{ name: "работаю", color: "#222222" },
			{ name: "новый", color: "#00ff00" },
		]);
	});

	it("пустое/пробельное имя — no-op (без ensureFile и правок)", async () => {
		const h = makeHarness();
		await h.service.setStatusDef("   ", "#123456");
		expect(h.ensured).toHaveLength(0);
		expect(h.frontmatters.size).toBe(0);
	});

	it("имя триммится перед записью", async () => {
		const path = "s.md";
		const h = makeHarness({ seed: { [path]: { "gtd-day-status": true, statuses: {} } } });
		await h.service.setStatusDef("  выходной  ", "#4caf50");
		expect(h.statusesAt(path)).toEqual({ выходной: "#4caf50" });
	});

	it("не трогает тело файла (правит только frontmatter)", async () => {
		const path = "s.md";
		const h = makeHarness({ seed: { [path]: { "gtd-day-status": true, statuses: {} } } });
		h.contents.set(path, "2026-07-20: работаю\n");
		await h.service.setStatusDef("работаю", "#4c8bf5");
		expect(h.contents.get(path)).toBe("2026-07-20: работаю\n");
	});
});

describe("DayStatusService.removeStatusDef", () => {
	it("удаляет ключ, прочие статусы сохраняет", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { a: "#111111", b: "#222222" } } },
		});
		await h.service.removeStatusDef("a");
		expect(h.statusesAt(path)).toEqual({ b: "#222222" });
		expect(h.service.statuses()).toEqual([{ name: "b", color: "#222222" }]);
	});

	it("удаление несуществующего ключа безвредно", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { a: "#111111" } } },
		});
		await h.service.removeStatusDef("нет-такого");
		expect(h.statusesAt(path)).toEqual({ a: "#111111" });
	});

	it("пустое имя — no-op", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { a: "#111111" } } },
		});
		await h.service.removeStatusDef("  ");
		expect(h.statusesAt(path)).toEqual({ a: "#111111" });
	});

	it("переименование как remove+set: старое имя ушло, новое с цветом на месте", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { работаю: "#4c8bf5" } } },
		});
		// сценарий модала: remove старого имени + set нового
		await h.service.removeStatusDef("работаю");
		await h.service.setStatusDef("работа", "#4c8bf5");
		expect(h.statusesAt(path)).toEqual({ работа: "#4c8bf5" });
	});
});

describe("DayStatusService.addRecurring", () => {
	it("дописывает строку правила в тело существующего файла", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { работаю: "#4c8bf5" } } },
		});
		await h.service.addRecurring("every monday", "работаю");
		expect(h.contents.get(path)).toBe("every monday: работаю\n");
		// понедельник покрашен согласно правилу
		expect(h.service.statusOf("2026-07-20")).toEqual({ name: "работаю", color: "#4c8bf5" });
	});

	it("на чистом хранилище создаёт файл (со стартовым правилом) и дописывает своё", async () => {
		const h = makeHarness();
		await h.service.addRecurring("every month on the 1st", "работаю");
		const path = "GTD/Статусы дней.md";
		expect(h.contents.get(path)).toBe(
			"every week on saturday,sunday: выходной\nevery month on the 1st: работаю\n",
		);
	});
});

describe("DayStatusService: стартовое правило при создании файла", () => {
	it("новый файл засеивается правилом выходных", async () => {
		const h = makeHarness();
		await h.service.ensureConfig();
		const path = "GTD/Статусы дней.md";
		expect(h.contents.get(path)).toBe("every week on saturday,sunday: выходной\n");
		// суббота покрашена статусом «выходной» из стартовой палитры
		expect(h.service.statusOf("2026-07-18")).toEqual({ name: "выходной", color: "#4caf50" });
	});

	it("существующий файл не засеивается стартовым правилом", async () => {
		const path = "s.md";
		const h = makeHarness({
			seed: { [path]: { "gtd-day-status": true, statuses: { работаю: "#4c8bf5" } } },
		});
		// тело пустое; ensureConfig не должен добавить стартовое правило в существующий файл
		await h.service.ensureConfig();
		expect(h.contents.get(path)).toBe("");
	});
});

describe("DayStatusService: refresh/write races", () => {
	it("поздний refresh старого файла не затирает более новую модель", async () => {
		let discovered = "old.md";
		let releaseOld!: (value: string) => void;
		const oldRead = new Promise<string>((resolve) => {
			releaseOld = resolve;
		});
		const service = new DayStatusService({
			discoverFile: () => discovered,
			readFrontmatter: (path) => ({
				statuses: path === "old.md" ? { old: "#111" } : { fresh: "#222" },
			}),
			readFile: async (path) => (path === "old.md" ? oldRead : "2026-07-20: fresh\n"),
			processFile: async () => true,
			ensureFile: async () => undefined,
			processFrontmatter: async () => true,
			defaultFilePath: () => "new.md",
			onVaultChange: () => {},
		});

		const staleRefresh = service.refresh();
		discovered = "fresh.md";
		await service.refresh();
		releaseOld("2026-07-20: old\n");
		await staleRefresh;

		expect(service.filePath()).toBe("fresh.md");
		expect(service.statusOf("2026-07-20")).toEqual({ name: "fresh", color: "#222" });
	});

	it("файл, исчезнувший между discovery и write, отклоняет операцию", async () => {
		const h = makeHarness({
			seed: { "s.md": { "gtd-day-status": true, statuses: {} } },
			processFile: async () => false, // VaultAdapter не вызовет transform, если файла уже нет
		});
		await expect(h.service.setDay("2026-07-20", "работаю")).rejects.toMatchObject({
			name: "DayStatusWriteError",
		});
	});

	it("исчезнувший перед frontmatter-правкой файл тоже не выдаёт ложный успех", async () => {
		const h = makeHarness({
			seed: { "s.md": { "gtd-day-status": true, statuses: {} } },
			processFrontmatter: async () => false,
		});
		await expect(h.service.setStatusDef("работаю", "#111")).rejects.toMatchObject({
			name: "DayStatusWriteError",
		});
	});
});
