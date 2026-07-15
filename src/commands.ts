/**
 * Команды палитры (ТЗ §8, слой 3 — обязательный паритет без drag).
 *
 * Команды «под курсором» работают из ЛЮБОГО markdown-редактора — это главный
 * паритет для мобильных: single pane, кросс-видовой drag выключен, а строка
 * задачи всегда под рукой в нативном редакторе.
 *
 * Подключение: оркестратор вызывает registerCommands(plugin) из main.ts —
 * сам main.ts здесь не трогаем.
 */
import { Modal, Notice, type App, type Editor } from "obsidian";
import type GtdFlowPlugin from "./main";
import type { CardPort } from "./services/CardService";
import type { Task } from "./core/model/Task";
import { appendLine } from "./views/calendar/calendarLogic";
import { pickBoardColumn, pickDate } from "./views/common/pickers";
import { findTaskAtLine, quickCaptureLine } from "./views/common/taskActions";

export function registerCommands(plugin: GtdFlowPlugin): void {
	plugin.addCommand({
		id: "quick-capture",
		name: "Быстрый ввод во входящие",
		callback: () => {
			new QuickCaptureModal(plugin.app, (text) => void capture(plugin, text)).open();
		},
	});

	plugin.addCommand({
		id: "run-recurrence-pass",
		name: "Проверить регулярные сейчас",
		callback: () => void runRecurrencePass(plugin),
	});

	plugin.addCommand({
		id: "card-at-cursor",
		name: "Карточка задачи под курсором",
		editorCallback: (editor, ctx) => void cardAtCursor(plugin, editor, ctx.file?.path ?? null),
	});

	plugin.addCommand({
		id: "defer-at-cursor",
		name: "Отложить задачу под курсором…",
		editorCallback: (editor, ctx) => void deferAtCursor(plugin, editor, ctx.file?.path ?? null),
	});

	plugin.addCommand({
		id: "move-to-column-at-cursor",
		name: "Задачу под курсором — в колонку…",
		editorCallback: (editor, ctx) => void columnAtCursor(plugin, editor, ctx.file?.path ?? null),
	});
}

// ---------------------------------------------------------------------------
// Быстрый ввод (паттерн quick-add календаря: append в inboxSources[0])
// ---------------------------------------------------------------------------

class QuickCaptureModal extends Modal {
	constructor(
		app: App,
		private readonly onSubmit: (text: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Быстрый ввод во входящие");
		const wrap = this.contentEl.createDiv({ cls: "gtd-quick-capture" });
		const input = wrap.createEl("input", { type: "text", placeholder: "Новая задача…" });
		const submit = (): void => {
			const value = input.value;
			this.close();
			this.onSubmit(value);
		};
		input.addEventListener("keydown", (e) => {
			// Enter в IME подтверждает композицию, а не отправку; keyCode 229 —
			// WebKit/iOS, где на коммит-Enter isComposing уже false
			if (e.isComposing || e.keyCode === 229) return;
			if (e.key === "Enter") submit();
		});
		const ok = wrap.createEl("button", { text: "OK", cls: "mod-cta" });
		ok.addEventListener("click", submit);
		wrap.style.display = "flex";
		wrap.style.gap = "8px";
		input.style.flex = "1 1 auto";
		input.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

async function capture(plugin: GtdFlowPlugin, text: string): Promise<void> {
	const line = quickCaptureLine(text);
	if (line === null) return; // пустой ввод — молча ничего
	const target = plugin.settings.inboxSources[0];
	if (target === undefined) {
		new Notice("GTD Flow: не задан файл входящих (inboxSources)");
		return;
	}
	try {
		await plugin.vaultAdapter.ensureFile(target);
		const ok = await plugin.vaultAdapter.processFile(target, (content) => appendLine(content, line));
		if (!ok) new Notice(`GTD Flow: не удалось записать в ${target}`);
	} catch (e) {
		// модалка уже закрыта — возвращаем текст в уведомлении, чтобы ввод
		// не пропал молча (ensureFile кидает на гонке create/кривом пути)
		new Notice(`GTD Flow: не удалось записать в ${target}: ${String(e)}\nТекст: ${text}`, 0);
	}
}

// ---------------------------------------------------------------------------
// Проход регулярных
// ---------------------------------------------------------------------------

async function runRecurrencePass(plugin: GtdFlowPlugin): Promise<void> {
	try {
		const rep = await plugin.recurrence.runPass();
		const parts = [`создано ${rep.spawned}`, `курсоров ${rep.advanced}`, `дедуп ${rep.deduped}`];
		if (rep.conflicts.length > 0) parts.push(`конфликтов ${rep.conflicts.length}`);
		if (rep.errors.length > 0) parts.push(`ошибок ${rep.errors.length}`);
		new Notice(`GTD Flow: проход повторов — ${parts.join(", ")}`);
	} catch (e) {
		new Notice(`GTD Flow: проход повторов не удался: ${String(e)}`);
	}
}

// ---------------------------------------------------------------------------
// Команды «под курсором»
// ---------------------------------------------------------------------------

/** Задача индекса по строке под курсором; null — не задача / индекс отстаёт. */
function taskUnderCursor(plugin: GtdFlowPlugin, editor: Editor, path: string | null): Task | null {
	if (path === null) return null;
	const lineNo = editor.getCursor().line;
	return findTaskAtLine(plugin.taskStore.index().fileTasks(path), editor.getLine(lineNo), path, lineNo);
}

function noticeNoTask(): void {
	new Notice("GTD Flow: под курсором нет задачи (или индекс её ещё не увидел)");
}

async function cardAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	// поле cards появляется на плагине при связке CardService в main.ts — читаем опционально
	const cards = (plugin as GtdFlowPlugin & { cards?: CardPort }).cards ?? null;
	if (cards === null) {
		new Notice("GTD Flow: сервис карточек недоступен");
		return;
	}
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const res = await cards.openOrCreate(task.key);
	if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "карточка недоступна"}`);
}

async function deferAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const date = await pickDate(plugin.app, "Отложить до", task.start ?? undefined);
	if (date === null) return;
	const res = await plugin.dispatcher.dispatch({ type: "defer", key: task.key, until: date });
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
}

async function columnAtCursor(
	plugin: GtdFlowPlugin,
	editor: Editor,
	path: string | null,
): Promise<void> {
	const task = taskUnderCursor(plugin, editor, path);
	if (task === null) {
		noticeNoTask();
		return;
	}
	const found = plugin.boards.discoverBoards().boards;
	if (found.length === 0) {
		new Notice("GTD Flow: досок не найдено");
		return;
	}
	const choice = await pickBoardColumn(plugin.app, found);
	if (choice === null) return;
	// «в конец колонки»: insertIntoColumnOrder клампит индекс к длине
	const res = await plugin.boards.moveCard(
		choice.boardPath,
		choice.def,
		task.key,
		choice.colId,
		Number.MAX_SAFE_INTEGER,
	);
	if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
}
