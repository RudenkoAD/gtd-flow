/**
 * CardService (ТЗ §4, §13 этап 8): заметки-карточки задач с планом/чеклистом.
 *
 * Карточка = отдельный markdown-файл с frontmatter `gtd-card-of: <🆔>`;
 * её чек-строки — состояние DETAIL (§1): приватный план карточки, в глобальные
 * запросы не протекает. Поиск карточки — строго по frontmatter
 * (MetadataAdapter.findByFrontmatterValue), а не по конвенции имени файла:
 * переименованная пользователем карточка не теряется.
 *
 * Ноль импортов obsidian: запись — через WritePort/IntentDispatcher, создание
 * и открытие файла — через инжектированные ensureFile/openFile.
 */
import type { Task } from "../core/model/Task";
import {
	buildCardContent,
	cardFileName,
	cardPath,
	checklistProgress,
	insertCardLink,
} from "./cardLogic";
import type { IndexFeed } from "./types";
import {
	locateTaskLine,
	type IntentDispatcher,
	type WritePort,
} from "./WritebackService";

// ---------------------------------------------------------------------------
// Общий контракт (вид TaskCard кодируется против него дословно)
// ---------------------------------------------------------------------------

export interface CardPort {
	/** Заметка-карточка задачи, если есть (по gtd-card-of == 🆔 задачи). */
	cardPathOf(taskId: string | null): string | null;
	/** Прогресс чеклиста заметки-карточки: {done, total} | null. */
	progressOf(taskId: string | null): { done: number; total: number } | null;
	/**
	 * Открыть карточку задачи, создав при необходимости (+ ленивый 🆔 через
	 * dispatcher set-id, + [[ссылка]] в строку при settings.cardLinkInLine).
	 * Возвращает путь.
	 */
	openOrCreate(taskKey: string): Promise<{ ok: boolean; path?: string; reason?: string }>;
}

export interface CardServiceDeps {
	feed: IndexFeed;
	write: WritePort;
	dispatcher: IntentDispatcher;
	/** Создать пустой файл (и папку), если его ещё нет (VaultAdapter.ensureFile). */
	ensureFile: (path: string) => Promise<void>;
	settings: () => { cardsFolder: string; cardLinkInLine: boolean };
	/** Генератор 🆔; по умолчанию 6 символов base36. */
	genId?: () => string;
	/** Открыть заметку в редакторе; инжектируется из вида/main — сервис без obsidian. */
	openFile: (path: string) => Promise<void>;
	/** Файл-карточка по gtd-card-of == taskId (MetadataAdapter.findByFrontmatterValue). */
	findCardFile: (taskId: string) => string | null;
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function defaultGenId(): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += BASE36.charAt(Math.floor(Math.random() * BASE36.length));
	return s;
}

export class CardService implements CardPort {
	private readonly genId: () => string;

	constructor(private readonly deps: CardServiceDeps) {
		this.genId = deps.genId ?? defaultGenId;
	}

	// --- чтение ---

	cardPathOf(taskId: string | null): string | null {
		return taskId === null ? null : this.deps.findCardFile(taskId);
	}

	/**
	 * Прогресс чеклиста карточки из индекса (byFile карточного файла):
	 * done = x/X, total = все чек-строки. Карточка без единой чек-строки
	 * индексу не видна — это честные {done: 0, total: 0}.
	 */
	progressOf(taskId: string | null): { done: number; total: number } | null {
		const path = this.cardPathOf(taskId);
		if (path === null) return null;
		return checklistProgress(this.deps.feed.getIndex().fileTasks(path));
	}

	// --- открыть/создать ---

	async openOrCreate(taskKey: string): Promise<{ ok: boolean; path?: string; reason?: string }> {
		const task = this.deps.feed.getIndex().get(taskKey);
		if (task === undefined) return { ok: false, reason: "task-not-found" };

		// 1. Ленивый 🆔. Индекс после set-id обновится ПОЗЖЕ (дебаунс), поэтому
		// id генерируем заранее и дальше используем именно это значение,
		// не перечитывая задачу (ТЗ: dispatch вернул ok ⇒ строка в файле уже с 🆔).
		let id = task.taskId;
		if (id === null) {
			const fresh = this.freshId();
			if (fresh === null) return { ok: false, reason: "id-collision" };
			const res = await this.deps.dispatcher.dispatch({
				type: "set-id",
				key: taskKey,
				taskId: fresh,
			});
			if (!res.ok) return { ok: false, reason: res.reason };
			id = fresh;
		}

		// 2. Существующая карточка (по frontmatter) или создание новой.
		const settings = this.deps.settings();
		let path = this.deps.findCardFile(id);
		if (path === null) {
			path = cardPath(settings.cardsFolder, cardFileName(id, task.description));
			const created = await this.createCard(path, id, task.description);
			if (!created) return { ok: false, reason: "create-failed" };
		}

		// 3. [[ссылка]] в строку задачи — best effort: карточка уже существует,
		// отсутствие ссылки не фатально и дозаписывается повторным вызовом.
		if (settings.cardLinkInLine) await this.appendLink(task, id, path);

		await this.deps.openFile(path);
		return { ok: true, path };
	}

	// --- внутренности ---

	/**
	 * ensureFile-паттерн: создать пустой файл, затем заполнить его атомарно
	 * и ТОЛЬКО если он пуст — файл с содержимым под этим именем (гонка двух
	 * устройств, ручная заметка с тем же именем) не перезаписывается.
	 */
	private async createCard(path: string, id: string, description: string): Promise<boolean> {
		try {
			await this.deps.ensureFile(path);
			let seen = false;
			await this.deps.write.processFile(path, (content) => {
				seen = true;
				if (content.trim() !== "") return null;
				return buildCardContent(id, description);
			});
			return seen;
		} catch {
			return false;
		}
	}

	/**
	 * Вставка " [[имя-карточки]]" в строку задачи перед первым эмодзи-полем
	 * (cardLogic.insertCardLink). Локализация строки — по 🆔 (он гарантированно
	 * есть: только что вписан либо был). Повторный вызов ссылку не дублирует —
	 * insertCardLink возвращает строку без изменений ⇒ ноль записей.
	 */
	private async appendLink(task: Task, id: string, path: string): Promise<void> {
		const base = path.split("/").pop() ?? path;
		const noteName = base.endsWith(".md") ? base.slice(0, -3) : base;
		try {
			await this.deps.write.processFile(task.filePath, (content) => {
				const lines = content.split("\n");
				const idx = locateTaskLine(lines, task.filePath, {
					taskId: id,
					description: task.description,
					lineStart: task.lineStart,
				});
				if (idx === -1) return null;
				const next = insertCardLink(lines[idx]!, noteName);
				if (next === null || next === lines[idx]) return null; // не задача / ссылка уже есть
				lines[idx] = next;
				return lines.join("\n");
			});
		} catch {
			// best effort — см. комментарий в openOrCreate, шаг 3
		}
	}

	/** Свежий 🆔: коллизии проверяем по индексу (resolveDep — все носители). */
	private freshId(): string | null {
		for (let attempt = 0; attempt < 32; attempt++) {
			const id = this.genId();
			if (this.deps.feed.getIndex().resolveDep(id).length === 0) return id;
		}
		return null; // генератор зациклился на занятых id — не пишем
	}
}
