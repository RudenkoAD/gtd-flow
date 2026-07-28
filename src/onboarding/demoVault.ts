/**
 * Демо-хранилище онбординга: чистые билдеры содержимого демо-файлов + создание
 * их через структурный порт (совместим с VaultAdapter). Ноль импортов obsidian —
 * тестируется в node.
 *
 * Файлы создаются ТОЛЬКО по явному согласию пользователя (приветственный диалог
 * или команда палитры), НИКОГДА автоматически. Паттерн создания — инвариант
 * проекта (см. createEventSeries): `ensureFile → frontmatter-флаг СТРОГО до
 * первой строки-задачи → append строк`. Существующий непустой файл (с телом
 * помимо frontmatter) не перезаписывается — демо идемпотентно и безопасно.
 *
 * Всё содержимое обязано парситься существующим ядром (parseTaskLine /
 * parseBoardFrontmatter / parseRule) — это зафиксировано юнит-тестом.
 */
import type { ContainerKind } from "../core/model/Task";

/** Структурный порт записи; совместим с VaultAdapter (extra-методы допустимы). */
export interface DemoVaultPort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<unknown>;
}

/** Декларативное описание одного демо-файла (чистые данные). */
export interface DemoFileSpec {
	path: string;
	/** Контейнер — для парсинга строк ядром (тест) и семантики файла. */
	container: ContainerKind;
	/** Frontmatter-флаг контейнера + доп. поля (id/name/columns доски, name проекта). */
	frontmatter: Record<string, unknown>;
	/** Строки тела: заголовок(и) и строки задач. */
	bodyLines: string[];
}

export interface DemoVaultReport {
	/** Пути реально созданных/засеянных файлов. */
	created: string[];
	/** Пути пропущенных (уже существовали с телом). */
	skipped: string[];
}

// ---------------------------------------------------------------------------
// Содержимое демо-файлов (чистые константы)
// ---------------------------------------------------------------------------

/** Входящие: несколько задач-подсказок для первого разбора. */
export const DEMO_INBOX: DemoFileSpec = {
	path: "GTD/Входящие.md",
	container: "inbox",
	frontmatter: { "gtd-inbox": true },
	bodyLines: [
		"# Входящие",
		"",
		"- [ ] Разобрать входящие: по каждой задаче решить «сделать / отложить / в проект»",
		"- [ ] Попробовать перетащить задачу в календарь",
		"- [ ] Отметить эту задачу выполненной, когда освоишься",
	],
};

/** Доска: 3 колонки Очередь/В работе/Готово + по задаче в каждой. */
export const DEMO_BOARD: DemoFileSpec = {
	path: "GTD/Доски/Пример.md",
	container: "board",
	frontmatter: {
		"gtd-board": true,
		id: "primer",
		name: "Пример",
		"group-by": "tag",
		columns: [
			{ id: "todo", name: "Очередь", match: "#kanban/primer/todo" },
			{ id: "doing", name: "В работе", match: "#kanban/primer/doing" },
			{ id: "done", name: "Готово", match: "#kanban/primer/done" },
		],
	},
	bodyLines: [
		"# Доска «Пример»",
		"",
		"- [ ] Перетащить карточку в соседнюю колонку #kanban/primer/todo",
		"- [/] Разобраться, как устроены колонки доски #kanban/primer/doing",
		"- [x] Создать демонстрационную доску #kanban/primer/done",
	],
};

/** Проект: 4 задачи с 🆔 и цепочкой ⛔ (a→b→c) плюс независимая d. */
export const DEMO_PROJECT: DemoFileSpec = {
	path: "GTD/Проекты/Пример проекта.md",
	container: "project",
	frontmatter: { "gtd-project": true, name: "Пример проекта" },
	bodyLines: [
		"# Пример проекта",
		"",
		"- [ ] Спланировать работу 🆔 demo-a",
		"- [ ] Закупить материалы 🆔 demo-b ⛔ demo-a",
		"- [ ] Выполнить работу 🆔 demo-c ⛔ demo-b",
		"- [ ] Параллельная независимая задача 🆔 demo-d",
	],
};

/**
 * Регулярные: один недельный шаблон. 🆔 задан сразу и детерминированно
 * (demo-review): спавн-проход строит id копий как <🆔>-YYYYMMDD, и без 🆔 на
 * шаблоне первый же проход упёрся бы в ошибку «нет 🆔». Демо не должно порождать
 * ошибок вообще, поэтому id зашит в контент, а не инжектится лениво на месте.
 */
export const DEMO_RECURRING: DemoFileSpec = {
	path: "GTD/Регулярные.md",
	container: "recurring",
	frontmatter: { "gtd-recurring": true },
	bodyLines: [
		"# Регулярные",
		"",
		"- [ ] Еженедельный обзор 🔁 every week on friday 🆔 demo-review",
	],
};

/** События: одна еженедельная серия с временем. */
export const DEMO_EVENTS: DemoFileSpec = {
	path: "GTD/События.md",
	container: "events",
	frontmatter: { "gtd-events": true },
	bodyLines: ["# События", "", "- [ ] Пример события 🔁 every saturday at 12:00-13:00"],
};

/** Порядок создания (пути детерминированы). */
export const DEMO_FILES: readonly DemoFileSpec[] = [
	DEMO_INBOX,
	DEMO_BOARD,
	DEMO_PROJECT,
	DEMO_RECURRING,
	DEMO_EVENTS,
];

/** Строки-задачи спецификации (для тестов и предпросмотра). */
export function demoTaskLines(spec: DemoFileSpec): string[] {
	return spec.bodyLines.filter((l) => /^- \[.\] /.test(l));
}

// ---------------------------------------------------------------------------
// Создание файлов через порт
// ---------------------------------------------------------------------------

/** Тело файла без ведущего frontmatter-блока, обрезанное — для проверки «пусто». */
function bodyOf(content: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
	return (m === null ? content : content.slice(m[0].length)).trim();
}

/** append тела с отбивкой пустой строкой (frontmatter уже в начале файла). */
function appendBody(content: string, body: string): string {
	const base = content.replace(/\s+$/, "");
	return base === "" ? body : base + "\n\n" + body;
}

/**
 * Засеять один демо-файл. Пробное чтение: файл с непустым телом (помимо
 * frontmatter) не трогаем вовсе (в т.ч. не ставим флаг — чужой файл). Иначе
 * ensureFile → frontmatter-флаг(и) СТРОГО до строк → append тела. Возврат —
 * был ли файл засеян.
 */
async function seedFile(port: DemoVaultPort, spec: DemoFileSpec): Promise<boolean> {
	let existed = false;
	let hasBody = false;
	// processFile на отсутствующем файле не зовёт transform и вернёт false —
	// existed останется false (создадим ниже).
	await port.processFile(spec.path, (content) => {
		existed = true;
		hasBody = bodyOf(content) !== "";
		return null; // только чтение
	});
	if (existed && hasBody) return false;

	await port.ensureFile(spec.path);
	await port.processFrontmatter(spec.path, (fm) => {
		for (const [k, v] of Object.entries(spec.frontmatter)) fm[k] = v;
	});
	const body = spec.bodyLines.join("\n") + "\n";
	await port.processFile(spec.path, (content) => appendBody(content, body));
	return true;
}

/**
 * Создать демо-хранилище: пять файлов-контейнеров (входящие, доска, проект,
 * регулярные, события) по паттерну «ensureFile → флаг → строки», не
 * перезаписывая существующие непустые файлы. Идемпотентно.
 */
export async function createDemoVault(port: DemoVaultPort): Promise<DemoVaultReport> {
	const created: string[] = [];
	const skipped: string[] = [];
	for (const spec of DEMO_FILES) {
		const made = await seedFile(port, spec);
		(made ? created : skipped).push(spec.path);
	}
	return { created, skipped };
}

/** Текст уведомления по итогам создания демо-файлов. */
export function demoVaultNotice(report: DemoVaultReport): string {
	if (report.created.length === 0) {
		return "GTD Flow: демо-файлы уже существуют — ничего не создано";
	}
	const base = `GTD Flow: создано демо-файлов — ${report.created.length}`;
	return report.skipped.length > 0
		? `${base} (пропущено уже существующих: ${report.skipped.length})`
		: base;
}
