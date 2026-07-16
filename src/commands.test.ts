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
		style: Record<string, string> = {};
		children: FakeEl[] = [];
		private listeners = new Map<string, Listener[]>();

		setText(_t: string): void {}
		createDiv(_o?: unknown): FakeEl {
			const el = new FakeEl();
			this.children.push(el);
			return el;
		}
		createEl(_tag: string, _o?: unknown): FakeEl {
			const el = new FakeEl();
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
		empty(): void {
			this.children = [];
		}
	}

	const notices: string[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
	callback?: () => void;
}

function makePlugin(over?: {
	ensureFile?: (path: string) => Promise<void>;
	processFile?: (path: string, t: (c: string) => string | null) => Promise<boolean>;
	processFrontmatter?: (path: string, fn: (fm: Record<string, unknown>) => void) => Promise<unknown>;
}) {
	const commands = new Map<string, Cmd>();
	const ensureFile = vi.fn(over?.ensureFile ?? (() => Promise.resolve()));
	const processFile = vi.fn(over?.processFile ?? (() => Promise.resolve(true)));
	// capture() помечает файл входящих gtd-inbox: true через processFrontmatter
	// СТРОГО до записи строки — двойник vault обязан удовлетворять FrontmatterVaultPort
	const processFrontmatter = vi.fn(over?.processFrontmatter ?? (() => Promise.resolve(true)));
	const plugin = {
		app: {},
		settings: { inboxSources: ["GTD/Inbox.md"] },
		vaultAdapter: { ensureFile, processFile, processFrontmatter },
		// цель захвата теперь ищет gtd-inbox файлы в индексе; пустой индекс ⇒ фолбэк inboxSources[0]
		taskStore: { index: () => ({ all: () => [] as never[] }) },
		addCommand: (cmd: Cmd) => commands.set(cmd.id, cmd),
	};
	registerCommands(plugin as unknown as GtdFlowPlugin);
	return { commands, ensureFile, processFile, processFrontmatter };
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
