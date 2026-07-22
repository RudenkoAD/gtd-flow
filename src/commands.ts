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
import {
	NS_CONVENTION,
	nsCommonTarget,
	resolveNamespace,
	type NamespaceFilter,
} from "./core/namespace/namespace";
import { pickBoardColumn, pickDate, pickNamespace } from "./views/common/pickers";
import {
	captureTargetInNamespace,
	ensureCaptureFileNs,
	findTaskAtLine,
	quickCaptureLine,
} from "./views/common/taskActions";

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
		id: "sync-external-calendars",
		name: "Синхронизировать внешние календари",
		callback: () => void syncExternalCalendars(plugin),
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

	// Переключатель активного пространства виден в палитре ТОЛЬКО когда настроено
	// ≥1 пространство (checkCallback вернёт false → команда скрыта): иначе поведение
	// и палитра прежние — обратная совместимость без единой настройки.
	plugin.addCommand({
		id: "switch-namespace",
		name: "Переключить пространство GTD",
		checkCallback: (checking) => {
			if (plugin.settings.namespaces.length === 0) return false;
			if (!checking) void switchNamespace(plugin);
			return true;
		},
	});
}

/**
 * Пикер пространства → переключение ВЕЗДЕ: глобальный дефолт + локальные пространства
 * всех открытых вкладок GTD (setNamespaceEverywhere). Это осознанное «переключить всё
 * разом»; отдельные виды по-прежнему меняются своими селекторами шапок пофайлово.
 */
async function switchNamespace(plugin: GtdFlowPlugin): Promise<void> {
	const name = await pickNamespace(
		plugin.app,
		plugin.settings.namespaces,
		plugin.settings.activeNamespace,
	);
	if (name === null) return;
	plugin.setNamespaceEverywhere(name);
}

// ---------------------------------------------------------------------------
// Быстрый ввод (паттерн quick-add календаря: append в первый gtd-inbox файл,
// фолбэк <commonRoot>/Входящие.md для «Общего», <root>/Входящие.md для именованного)
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
	// цель захвата — в АКТИВНОМ пространстве, В МОМЕНТ ввода: первый gtd-inbox файл
	// этого пространства, иначе конвенционные Входящие.md: <root>/ (именованное) или
	// <commonRoot>/ («Общее» — nsCommonTarget подставляет корень «Общего»)
	const active = plugin.settings.activeNamespace;
	const defs = plugin.settings.namespaces;
	const fallback = nsCommonTarget(active, defs, NS_CONVENTION.inbox, plugin.settings.commonRoot);
	const target = captureTargetInNamespace(plugin.taskStore.index().all(), active, defs, fallback);
	if (target === "") {
		new Notice("GTD Flow: не задан файл входящих (пустая «Корневая папка Общего»)");
		return;
	}
	try {
		// файл входящих создаётся и помечается gtd-inbox: true (+ gtd-namespace для
		// файла-исключения вне корня пространства) СТРОГО до записи строки
		if (!(await ensureCaptureFileNs(plugin.vaultAdapter, target, active, defs))) {
			new Notice(`GTD Flow: не удалось подготовить файл входящих ${target}\nТекст: ${text}`, 0);
			return;
		}
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

async function syncExternalCalendars(plugin: GtdFlowPlugin): Promise<void> {
	if (plugin.settings.externalCalendars.length === 0) {
		new Notice("GTD Flow: внешние календари не настроены");
		return;
	}
	new Notice("GTD Flow: синхронизация внешних календарей…");
	await plugin.sync.syncAll();
	new Notice("GTD Flow: синхронизация внешних календарей завершена");
}

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
	// доски ПРОСТРАНСТВА ЗАДАЧИ (не активного вида): перенос идёт внутри пространства
	// задачи под курсором — она едет на доску своего же пространства
	const taskFilter: NamespaceFilter = {
		active: resolveNamespace(task.filePath, task.nsOverride ?? null, plugin.settings.namespaces),
		defs: plugin.settings.namespaces,
	};
	const found = plugin.boards.discoverBoards(taskFilter).boards;
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
