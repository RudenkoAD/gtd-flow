/**
 * Команды палитры headless: 'obsidian' подменяется структурными двойниками
 * (Modal/Notice/FuzzySuggestModal), DOM модалки — минимальный FakeEl.
 * Покрытие — регрессии этапа 9: IME-Enter в быстром вводе и потеря текста
 * при сбое записи capture().
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
	type Listener = (ev: unknown) => void;

	class FakeEl {
		value = "";
		tag = "";
		text = "";
		className = "";
		disabled = false;
		style: Record<string, string> = {};
		children: FakeEl[] = [];
		parent: FakeEl | null = null;
		private listeners = new Map<string, Listener[]>();

		setText(_t: string): void {}
		createDiv(options?: unknown): FakeEl {
			const el = new FakeEl();
			el.tag = "div";
			if (typeof options === "object" && options !== null) {
				const record = options as Record<string, unknown>;
				if (typeof record["cls"] === "string") el.className = record["cls"];
			}
			el.parent = this;
			this.children.push(el);
			return el;
		}
		createEl(tag: string, options?: unknown): FakeEl {
			const el = new FakeEl();
			el.tag = tag;
			if (typeof options === "object" && options !== null) {
				const record = options as Record<string, unknown>;
				if (typeof record["value"] === "string") el.value = record["value"];
				if (typeof record["text"] === "string") el.text = record["text"];
				if (typeof record["cls"] === "string") el.className = record["cls"];
			}
			el.parent = this;
			this.children.push(el);
			return el;
		}
		addEventListener(name: string, cb: Listener): void {
			const arr = this.listeners.get(name) ?? [];
			arr.push(cb);
			this.listeners.set(name, arr);
		}
		dispatch(name: string, ev: unknown): void {
			for (const cb of [...(this.listeners.get(name) ?? [])]) cb(ev);
		}
		focus(): void {}
		querySelector(selector: string): FakeEl | null {
			return this.querySelectorAll(selector)[0] ?? null;
		}
		querySelectorAll(selector: string): FakeEl[] {
			const tags = selector.split(",").map((item) => item.trim());
			const matches = (element: FakeEl): boolean =>
				tags.some((tag) =>
					tag.startsWith(".")
						? element.className.split(/\s+/u).includes(tag.slice(1))
						: element.tag === tag,
				);
			const found: FakeEl[] = [];
			const visit = (element: FakeEl): void => {
				for (const child of element.children) {
					if (matches(child)) found.push(child);
					visit(child);
				}
			};
			visit(this);
			return found;
		}
		remove(): void {
			if (this.parent === null) return;
			this.parent.children = this.parent.children.filter((child) => child !== this);
			this.parent = null;
		}
		empty(): void {
			for (const child of this.children) child.parent = null;
			this.children = [];
		}
	}

	const notices: string[] = [];
	const modals: any[] = [];

	class Modal {
		titleEl = new FakeEl();
		contentEl = new FakeEl();
		closed = false;
		constructor(public app: unknown) {}
		open(): void {
			modals.push(this);
			(this as unknown as { onOpen?: () => void }).onOpen?.();
		}
		close(): void {
			this.closed = true;
			(this as unknown as { onClose?: () => void }).onClose?.();
		}
	}

	class Notice {
		constructor(msg: string, _timeout?: number) {
			notices.push(msg);
		}
	}

	class FuzzySuggestModal {
		constructor(public app: unknown) {}
		setPlaceholder(_p: string): void {}
		open(): void {}
		close(): void {}
	}

	return { FakeEl, Modal, Notice, FuzzySuggestModal, notices, modals };
});

vi.mock("obsidian", () => ({
	Modal: H.Modal,
	Notice: H.Notice,
	FuzzySuggestModal: H.FuzzySuggestModal,
}));

import { registerCommands } from "./commands";
import type GtdFlowPlugin from "./main";

// --- обвязка ---

interface Cmd {
	id: string;
	name: string;
	callback?: () => void;
	editorCallback?: (editor: unknown, ctx: unknown) => void;
}

function makePlugin(over?: {
	ensureFile?: (path: string) => Promise<void>;
	processFile?: (path: string, t: (c: string) => string | null) => Promise<boolean>;
	processFrontmatter?: (
		path: string,
		fn: (fm: Record<string, unknown>) => void,
	) => Promise<unknown>;
	aiProcess?: () => Promise<unknown>;
	aiReprocessTask?: (task: unknown) => Promise<unknown>;
	aiOpenSession?: (sessionId: string) => Promise<void>;
	aiCancelProcessing?: () => number;
	aiRetryWaiting?: () => Promise<unknown[]>;
	taskStoreTasks?: readonly unknown[];
	desktopFeatures?: boolean;
}) {
	const commands = new Map<string, Cmd>();
	const ensureFile = vi.fn(over?.ensureFile ?? (() => Promise.resolve()));
	const processFile = vi.fn(over?.processFile ?? (() => Promise.resolve(true)));
	// capture() помечает файл входящих gtd-inbox: true через processFrontmatter
	// СТРОГО до записи строки — двойник vault обязан удовлетворять FrontmatterVaultPort
	const processFrontmatter = vi.fn(over?.processFrontmatter ?? (() => Promise.resolve(true)));
	const aiProcess = vi.fn(
		over?.aiProcess ??
			(() =>
				Promise.resolve({
					runId: "run-1",
					sessionId: "session-1",
					state: "completed",
					applied: 1,
					skippedLocked: 0,
					failed: [],
					questions: [],
					actualModel: "free/model",
					nextEligibleAt: null,
					feedbackWarnings: 0,
				})),
	);
	const aiReprocessTask = vi.fn(
		over?.aiReprocessTask ??
			(() =>
				Promise.resolve({
					runId: "run-2",
					sessionId: "session-2",
					state: "completed",
					applied: 1,
					skippedLocked: 0,
					failed: [],
					questions: [],
					actualModel: "free/model",
					nextEligibleAt: null,
					feedbackWarnings: 0,
				})),
	);
	const aiOpenSession = vi.fn(over?.aiOpenSession ?? (() => Promise.resolve()));
	const aiCancelProcessing = vi.fn(over?.aiCancelProcessing ?? (() => 0));
	const aiRetryWaiting = vi.fn(over?.aiRetryWaiting ?? (() => Promise.resolve([])));
	const bindMigrationPreview = vi.fn(async (value: Record<string, unknown>) => ({
		...value,
		fileBindings: [],
		settingsBinding: { inboxFile: "GTD/Inbox.md", legacy: {} },
	}));
	const plugin = {
		app: {},
		settings: { inboxFile: "GTD/Inbox.md" },
		scopes: {
			current: () => ({
				schemaVersion: 1 as const,
				scopes: [{ id: "work", name: "Work", order: 0, archived: false }],
			}),
		},
		legacyNamespaceMigrationInventory: () => ({
			inventory: { namespaces: [], inboxes: [], tasks: [] },
			missingTaskIds: [],
		}),
		namespaceMigration: {
			bindPreview: bindMigrationPreview,
			prepare: async () => ({ id: "migration-1" }),
			apply: async () => ({ ok: true }),
		},
		vaultAdapter: { ensureFile, processFile, processFrontmatter },
		// unified inbox is configured directly, independent from indexed files
		taskStore: {
			index: () => ({
				all: () => over?.taskStoreTasks ?? [],
				fileTasks: () => over?.taskStoreTasks ?? [],
			}),
		},
		ai: {
			process: aiProcess,
			reprocessTask: aiReprocessTask,
			cancelProcessing: aiCancelProcessing,
			openSession: aiOpenSession,
			openLastRun: async () => false,
			retryWaiting: aiRetryWaiting,
		},
		addCommand: (cmd: Cmd) => commands.set(cmd.id, cmd),
	};
	registerCommands(plugin as unknown as GtdFlowPlugin, {
		desktopFeatures: over?.desktopFeatures ?? true,
	});
	return {
		commands,
		ensureFile,
		processFile,
		processFrontmatter,
		aiProcess,
		aiReprocessTask,
		aiOpenSession,
		aiCancelProcessing,
		aiRetryWaiting,
		bindMigrationPreview,
	};
}

/** Открывает модал быстрого ввода; структура onOpen: contentEl → wrap → input. */
function openQuickCapture(commands: Map<string, Cmd>) {
	commands.get("quick-capture")!.callback!();
	const modal = H.modals.at(-1) as InstanceType<typeof H.Modal>;
	const wrap = modal.contentEl.children[0]!;
	const input = wrap.children[0]!;
	return { modal, input };
}

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

beforeEach(() => {
	H.notices.length = 0;
	H.modals.length = 0;
});

describe("AI command registration", () => {
	it("does not register desktop-only commands for the Android MVP", () => {
		const { commands } = makePlugin({ desktopFeatures: false });
		expect([...commands.keys()]).toEqual(["quick-capture", "run-recurrence-pass"]);
	});

	it("registers explicit processing, reprocessing, unlock, history, and retry commands", () => {
		const { commands } = makePlugin();
		expect([...commands.keys()]).toEqual(
			expect.arrayContaining([
				"process-inbox-with-ai",
				"cancel-active-ai-inbox-processing",
				"reprocess-task-at-cursor-with-ai",
				"unlock-ai-field-at-cursor",
				"open-last-ai-run",
				"retry-waiting-ai-jobs",
			]),
		);
		expect(commands.get("reprocess-task-at-cursor-with-ai")?.editorCallback).toBeTypeOf(
			"function",
		);
		expect(commands.get("unlock-ai-field-at-cursor")?.editorCallback).toBeTypeOf("function");
		expect(commands.get("cancel-active-ai-inbox-processing")?.name).toBe(
			"Отменить активную AI-обработку входящих",
		);
	});

	it("processes the inbox only when the explicit command is invoked", async () => {
		const { commands, aiProcess } = makePlugin();
		expect(aiProcess).not.toHaveBeenCalled();
		commands.get("process-inbox-with-ai")!.callback!();
		await tick();
		expect(aiProcess).toHaveBeenCalledOnce();
		expect(H.notices.at(-1)).toContain("применено 1");
	});

	it("routes cursor reprocessing through the question-aware explicit command path", async () => {
		const task = {
			key: "id:task-1",
			taskId: "task-1",
			description: "Reconcile invoices",
			lineStart: 0,
		};
		const { commands, aiProcess, aiReprocessTask } = makePlugin({
			taskStoreTasks: [task],
		});

		commands.get("reprocess-task-at-cursor-with-ai")!.editorCallback!(
			{
				getCursor: () => ({ line: 0 }),
				getLine: () => "- [ ] Reconcile invoices 🆔 task-1",
			},
			{ file: { path: "GTD/Inbox.md" } },
		);
		await tick();

		expect(aiReprocessTask).toHaveBeenCalledWith(task);
		expect(aiProcess).not.toHaveBeenCalled();
		expect(H.notices.at(-1)).toContain("применено 1");
	});

	it.each([
		{
			state: "rate_limited",
			expected: "бесплатная ёмкость исчерпана",
			notExpected: "временная ошибка AI",
		},
		{
			state: "retry_waiting",
			expected: "временная ошибка AI",
			notExpected: "бесплатная ёмкость исчерпана",
		},
	])("reports $state without conflating retry reasons", async (sample) => {
		const { commands } = makePlugin({
			aiProcess: () =>
				Promise.resolve({
					runId: "run-waiting",
					sessionId: "session-waiting",
					state: sample.state,
					applied: 0,
					skippedLocked: 0,
					failed: [],
					questions: [],
					actualModel: null,
					nextEligibleAt: "2026-07-28T12:01:00.000Z",
					feedbackWarnings: 0,
				}),
		});

		commands.get("process-inbox-with-ai")!.callback!();
		await tick();

		expect(H.notices.at(-1)).toContain(sample.expected);
		expect(H.notices.at(-1)).not.toContain(sample.notExpected);
	});

	it("counts quota waits and generic retry waits separately after explicit retry", async () => {
		const { commands } = makePlugin({
			aiRetryWaiting: () =>
				Promise.resolve([
					{ state: "rate_limited", applied: 0 },
					{ state: "retry_waiting", applied: 0 },
					{ state: "completed", applied: 2 },
				]),
		});

		commands.get("retry-waiting-ai-jobs")!.callback!();
		await tick();

		expect(H.notices.at(-1)).toContain("лимит ёмкости ожидают 1");
		expect(H.notices.at(-1)).toContain("повторную попытку ожидают 1");
	});

	it("reports a cancelled processing command without a misleading zero-result summary", async () => {
		const { commands } = makePlugin({
			aiProcess: () =>
				Promise.resolve({
					runId: "run-cancelled",
					sessionId: "session-cancelled",
					state: "cancelled",
					applied: 0,
					skippedLocked: 0,
					failed: [],
					questions: [],
					actualModel: null,
					nextEligibleAt: null,
					feedbackWarnings: 0,
				}),
		});

		commands.get("process-inbox-with-ai")!.callback!();
		await tick();

		expect(H.notices.at(-1)).toContain("отменена");
		expect(H.notices.at(-1)).not.toContain("применено 0");
	});

	it("cancels every active inbox-processing invocation and reports the count", () => {
		const { commands, aiCancelProcessing } = makePlugin({
			aiCancelProcessing: () => 2,
		});

		commands.get("cancel-active-ai-inbox-processing")!.callback!();

		expect(aiCancelProcessing).toHaveBeenCalledOnce();
		expect(H.notices.at(-1)).toContain("2");
	});

	it("reports when there is no active inbox processing to cancel", () => {
		const { commands, aiCancelProcessing } = makePlugin();

		commands.get("cancel-active-ai-inbox-processing")!.callback!();

		expect(aiCancelProcessing).toHaveBeenCalledOnce();
		expect(H.notices.at(-1)).toContain("активных AI-обработок входящих нет");
	});

	it("opens the run conversation after provisional values produce questions", async () => {
		const { commands, aiOpenSession } = makePlugin({
			aiProcess: () =>
				Promise.resolve({
					runId: "run-1",
					sessionId: "session-questions",
					state: "awaiting_answers",
					applied: 1,
					skippedLocked: 0,
					failed: [],
					questions: [
						{
							taskId: "task-1",
							question: {
								id: "question-1",
								text: "How long?",
								affectedFields: ["duration"],
							},
						},
					],
					actualModel: "free/model",
					nextEligibleAt: null,
					feedbackWarnings: 0,
				}),
		});
		commands.get("process-inbox-with-ai")!.callback!();
		await tick();
		await tick();
		expect(aiOpenSession).toHaveBeenCalledWith("session-questions");
	});
});

describe("legacy namespace migration choices", () => {
	it("requires explicit D1 and D2 selections before building a dry-run", () => {
		const { commands } = makePlugin();
		commands.get("migrate-legacy-namespaces")!.callback!();
		const modal = H.modals.at(-1) as InstanceType<typeof H.Modal>;
		const selects = modal.contentEl.children.filter((child) => child.tag === "select");
		const preview = modal.contentEl.children.find(
			(child) => child.tag === "button" && child.text === "Показать dry-run",
		);

		expect(selects).toHaveLength(2);
		expect(selects.map((select) => select.value)).toEqual(["", ""]);
		preview!.dispatch("click", {});
		expect(H.notices.at(-1)).toContain("D1");

		selects[0]!.value = "inbox-only";
		preview!.dispatch("click", {});
		expect(H.notices.at(-1)).toContain("D2");
	});

	it("binds a valid dry-run and invalidates its Apply consent when a choice changes", async () => {
		const { commands, bindMigrationPreview } = makePlugin();
		commands.get("migrate-legacy-namespaces")!.callback!();
		const modal = H.modals.at(-1) as InstanceType<typeof H.Modal>;
		const selects = modal.contentEl.children.filter((child) => child.tag === "select");
		const preview = modal.contentEl.children.find(
			(child) => child.tag === "button" && child.text === "Показать dry-run",
		)!;
		selects[0]!.value = "inbox-only";
		selects[1]!.value = "leave-unscoped";

		preview.dispatch("click", {});
		await tick();

		expect(bindMigrationPreview).toHaveBeenCalledOnce();
		expect(modal.contentEl.querySelector(".gtd-namespace-migration-preview")).not.toBeNull();
		expect(preview.disabled).toBe(false);

		selects[0]!.value = "all-tasks";
		selects[0]!.dispatch("change", {});
		expect(modal.contentEl.querySelector(".gtd-namespace-migration-preview")).toBeNull();
	});
});

// --- IME: Enter во время композиции не отправляет ---

describe("quick-capture: IME", () => {
	it("Enter с isComposing=true (Chromium) игнорируется", () => {
		const { commands, processFile } = makePlugin();
		const { modal, input } = openQuickCapture(commands);
		input.value = "недописанная задача";

		input.dispatch("keydown", { key: "Enter", isComposing: true, keyCode: 229 });

		expect(modal.closed).toBe(false); // модал жив, композиция продолжается
		expect(processFile).not.toHaveBeenCalled();
	});

	it("Enter с keyCode 229 при isComposing=false (WebKit/iOS) игнорируется", () => {
		const { commands, processFile } = makePlugin();
		const { modal, input } = openQuickCapture(commands);
		input.value = "半分だけ";

		input.dispatch("keydown", { key: "Enter", isComposing: false, keyCode: 229 });

		expect(modal.closed).toBe(false);
		expect(processFile).not.toHaveBeenCalled();
	});

	it("обычный Enter отправляет и закрывает модал", async () => {
		const { commands, processFile } = makePlugin();
		const { modal, input } = openQuickCapture(commands);
		input.value = "купить хлеб";

		input.dispatch("keydown", { key: "Enter", isComposing: false, keyCode: 13 });
		await tick();

		expect(modal.closed).toBe(true);
		expect(processFile).toHaveBeenCalledTimes(1);
		const [target, transform] = processFile.mock.calls[0]!;
		expect(target).toBe("GTD/Inbox.md");
		expect(transform("")).toContain("- [ ] купить хлеб");
	});
});

// --- capture(): сбой записи не глотается молча ---

describe("quick-capture: ошибки записи", () => {
	it("ensureFile кинул — Notice с целью и введённым текстом, без unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown): void => {
			unhandled.push(e);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const { commands, processFile } = makePlugin({
				ensureFile: () => Promise.reject(new Error("File already exists.")),
			});
			const { modal, input } = openQuickCapture(commands);
			input.value = "купить хлеб";

			input.dispatch("keydown", { key: "Enter", keyCode: 13 });
			await tick();
			await tick();

			expect(modal.closed).toBe(true); // модал уже закрыт — поэтому текст в Notice
			expect(processFile).not.toHaveBeenCalled();
			expect(H.notices).toHaveLength(1);
			expect(H.notices[0]).toContain("GTD/Inbox.md");
			expect(H.notices[0]).toContain("купить хлеб"); // ввод не потерян
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("processFile вернул false (файла нет) — прежний Notice остаётся", async () => {
		const { commands } = makePlugin({ processFile: () => Promise.resolve(false) });
		const { input } = openQuickCapture(commands);
		input.value = "задача";

		input.dispatch("keydown", { key: "Enter", keyCode: 13 });
		await tick();

		expect(H.notices).toHaveLength(1);
		expect(H.notices[0]).toContain("не удалось записать");
	});
});
