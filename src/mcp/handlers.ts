/**
 * Реализация девяти инструментов MCP-сервера поверх GtdSession.
 *
 * Каждый хендлер — чистая асинхронная функция (session, args) → JSON-объект;
 * транспорт и обёртка ответа живут в tools.ts/server.ts, поэтому хендлеры
 * тестируются напрямую. Ошибки бросаются Error'ом с человекочитаемым английским
 * текстом и подсказкой — tools.ts превращает их в isError-ответ.
 *
 * Максимум переиспользования ядра: запросы (QueryEngine.evaluate), захват
 * (taskActions), правки строк (WritebackService intents), события (eventSeries),
 * доски (BoardService) — те же кодовые пути, что в плагине.
 */
import type { DiscoveredBoard } from "../services/BoardService";
import { isCancelled, isDone } from "../core/model/gtdState";
import type { NamespaceDef, NamespaceFilter } from "../core/namespace/namespace";
import {
	ALL_NS,
	DEFAULT_NS,
	eventVisibleInNamespace,
	inNamespace,
	NS_CONVENTION,
	nsCommonTarget,
	nsTargetPath,
	resolveNamespace,
} from "../core/namespace/namespace";
import type { Intent } from "../core/intents/Intent";
import type { Priority, Task } from "../core/model/Task";
import { parseDatePayload } from "../core/parser/parseTaskLine";
import { setField, setValueField } from "../core/parser/serializeTaskLine";
import { evaluate, type QueryContext } from "../core/query/QueryEngine";
import { defaultInboxConfig } from "../core/query/querySpec";
import { isParseError, parseRule } from "../core/recurrence/grammar";
import { expandOccurrences } from "../core/recurrence/occurrences";
import { frontmatterNamespace } from "../services/snapshotHelpers";
import type { EventWriteResult } from "../views/calendar/eventSeries";
import {
	buildSingleOccurrenceLine,
	createEventSeries,
	withSeriesAnchor,
} from "../views/calendar/eventSeries";
import {
	captureTargetInNamespace,
	ensureCaptureFileNs,
	quickCaptureLine,
} from "../views/common/taskActions";
import { fileNsLabel, nsLabel, resolveNamespaceFilter, resolveWriteNamespace } from "./namespaces";
import type { GtdSession } from "./session";

// ---------------------------------------------------------------------------
// Общие помощники
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface DateTimeParts {
	date: string;
	time: string | null;
	timeEnd: string | null;
}

/** «YYYY-MM-DD[ |T]HH:mm[-HH:mm]» → части; календарная валидация тем же гейтом,
 *  что и парсер. Бросает Error с подсказкой на любой мусор. */
function parseDateTime(input: string): DateTimeParts {
	const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]+(.+))?$/.exec(input.trim());
	if (m === null) {
		throw new Error(`invalid date '${input}' — expected YYYY-MM-DD[ HH:mm[-HH:mm]]`);
	}
	const date = m[1]!;
	if (parseDatePayload(date).kind !== "date") {
		throw new Error(`'${date}' is not a valid calendar date`);
	}
	if (m[2] === undefined) return { date, time: null, timeEnd: null };
	const { time, timeEnd } = parseTimeSpec(m[2]);
	return { date, time, timeEnd };
}

/** «HH:mm» или «HH:mm-HH:mm» → время начала и опционального конца. */
function parseTimeSpec(spec: string): { time: string; timeEnd: string | null } {
	const t = spec.trim();
	const dash = t.indexOf("-");
	const time = dash === -1 ? t : t.slice(0, dash);
	const timeEnd = dash === -1 ? null : t.slice(dash + 1);
	if (!TIME_RE.test(time)) throw new Error(`invalid time '${time}' — expected HH:mm`);
	if (timeEnd !== null) {
		if (!TIME_RE.test(timeEnd)) throw new Error(`invalid end time '${timeEnd}' — expected HH:mm`);
		if (timeEnd <= time) throw new Error(`end time '${timeEnd}' must be after start '${time}'`);
	}
	return { time, timeEnd };
}

function assertIsoDate(value: string, what: string): string {
	if (parseDatePayload(value.trim()).kind !== "date") {
		throw new Error(`${what} '${value}' is not a valid YYYY-MM-DD date`);
	}
	return value.trim();
}

function queryContext(session: GtdSession, filter: NamespaceFilter): QueryContext {
	const index = session.feed.getIndex();
	return {
		tasks: session.allTasks,
		today: session.today,
		resolveDep: (id) => index.resolveDep(id),
		settingsBits: defaultInboxConfig(undefined, session.settings.inboxIncludePlain),
		namespace: filter,
	};
}

/**
 * id инструмента → фактический ключ индекса. Принимает 🆔 (приоритетно) и
 * content-key '<file>#<hash>#<n>' (то, что list_tasks вернул в поле id). Дубли
 * 🆔 — fail-closed ошибка (непонятно, чью строку править). Нет совпадений — ошибка.
 */
function resolveTaskKey(session: GtdSession, id: string): string {
	const index = session.feed.getIndex();
	const direct = index.get(id);
	if (direct !== undefined) return direct.key;
	const carriers = index.resolveDep(id);
	if (carriers.length === 1) return carriers[0]!.key;
	if (carriers.length > 1) {
		throw new Error(
			`ambiguous id '${id}': ${carriers.length} tasks carry it — resolve the duplicate first`,
		);
	}
	throw new Error(`no task found for id '${id}'`);
}

/** Компактный JSON задачи: только заполненные поля (null/пустое опускаем). */
function taskJson(t: Task, defs: readonly NamespaceDef[]): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: t.taskId ?? t.key,
		description: t.description,
		status: t.statusChar,
		done: isDone(t) || isCancelled(t),
		file: t.filePath,
		line: t.lineStart + 1, // 1-based для человека/агента
		namespace: fileNsLabel(t.filePath, t.nsOverride, defs),
		container: t.container,
	};
	if (t.due !== null) {
		out.due = t.due;
		if (t.dueTime !== null) out.dueTime = t.dueTime;
		if (t.dueTimeEnd !== null) out.dueTimeEnd = t.dueTimeEnd;
	}
	if (t.scheduled !== null) {
		out.scheduled = t.scheduled;
		if (t.scheduledTime !== null) out.scheduledTime = t.scheduledTime;
	}
	if (t.start !== null) {
		out.start = t.start;
		if (t.startTime !== null) out.startTime = t.startTime;
	}
	if (t.priority !== "none") out.priority = t.priority;
	if (t.tags.length > 0) out.tags = t.tags;
	if (t.location !== null) out.location = t.location;
	if (t.recurrence !== null) out.recurrence = t.recurrence;
	if (t.heading !== null) out.heading = t.heading;
	return out;
}

const PRIORITIES: ReadonlySet<string> = new Set([
	"highest",
	"high",
	"medium",
	"low",
	"lowest",
	"none",
]);

function assertPriority(p: string): Priority {
	if (!PRIORITIES.has(p)) {
		throw new Error(`invalid priority '${p}' — one of highest|high|medium|low|lowest|none`);
	}
	return p as Priority;
}

/** append строки блоком в конец файла (форма — как WritebackService.moveLine/eventSeries). */
function appendLine(content: string, line: string): string {
	return content.trimEnd() !== ""
		? content + (content.endsWith("\n") ? "" : "\n") + line + "\n"
		: line + "\n";
}

// ---------------------------------------------------------------------------
// gtd_overview
// ---------------------------------------------------------------------------

export function gtdOverview(session: GtdSession): Record<string, unknown> {
	const { settings } = session;
	const defs = settings.namespaces;
	// «Общее» + пользовательские пространства в один ряд (root у «Общего» нет)
	const spaceSpecs: { active: string; root: string | null }[] = [
		{ active: DEFAULT_NS, root: null }, // «Общее» — метку даёт nsLabel
		...defs.map((d) => ({ active: d.name, root: d.root })),
	];
	const spaces = spaceSpecs.map((spec) => {
		const filter: NamespaceFilter = { active: spec.active, defs };
		const ctx = queryContext(session, filter);
		const events = session.allTasks.filter(
			(t) =>
				t.container === "events" &&
				resolveNamespace(t.filePath, t.nsOverride ?? null, defs) === spec.active,
		).length;
		return {
			name: nsLabel(spec.active),
			root: spec.root,
			inbox: evaluate({ kind: "inbox" }, ctx).length,
			tickler: evaluate({ kind: "tickler" }, ctx).length,
			boards: session.boards.discoverBoards(filter).boards.length,
			projects: session.projects.discoverProjects(filter).length,
			events,
		};
	});
	return {
		today: session.today,
		activeNamespace: nsLabel(settings.activeNamespace),
		commonRoot: settings.commonRoot,
		spaces,
	};
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

export interface ListTasksArgs {
	namespace?: string;
	view?: "inbox" | "tickler" | "board" | "project" | "all";
	board?: string;
	project?: string;
	include_done?: boolean;
}

export function listTasks(session: GtdSession, args: ListTasksArgs): Record<string, unknown> {
	const filter = resolveNamespaceFilter(args.namespace, session.settings);
	const defs = session.settings.namespaces;
	const view = args.view ?? "all";
	const includeDone = args.include_done ?? false;
	const inNs = (t: Task): boolean => inNamespace(t.filePath, t.nsOverride ?? null, filter);
	const keepDone = (t: Task): boolean => includeDone || !(isDone(t) || isCancelled(t));

	let rows: Record<string, unknown>[];
	switch (view) {
		case "inbox":
			rows = evaluate({ kind: "inbox" }, queryContext(session, filter)).map((t) => taskJson(t, defs));
			break;
		case "tickler":
			rows = evaluate({ kind: "tickler" }, queryContext(session, filter)).map((t) =>
				taskJson(t, defs),
			);
			break;
		case "board": {
			if (args.board !== undefined && args.board !== "") {
				const board = findBoard(session, filter, args.board);
				const model = session.boards.boardModel(board.path, board.def);
				rows = [];
				for (const col of model.columns) {
					for (const t of col.tasks) {
						if (!keepDone(t)) continue;
						rows.push({ ...taskJson(t, defs), column: col.name, columnId: col.id });
					}
				}
			} else {
				rows = session.allTasks
					.filter(
						(t) =>
							inNs(t) &&
							keepDone(t) &&
							(t.container === "board" || t.tags.some((tag) => tag.startsWith("#kanban/"))),
					)
					.map((t) => taskJson(t, defs));
			}
			break;
		}
		case "project": {
			if (args.project !== undefined && args.project !== "") {
				const path = findProjectPath(session, filter, args.project);
				rows = session.feed
					.getIndex()
					.fileTasks(path)
					.filter(keepDone)
					.map((t) => taskJson(t, defs));
			} else {
				rows = session.allTasks
					.filter((t) => inNs(t) && keepDone(t) && t.container === "project")
					.map((t) => taskJson(t, defs));
			}
			break;
		}
		case "all":
			rows = session.allTasks
				.filter(
					(t) =>
						inNs(t) && keepDone(t) && t.container !== "events" && t.container !== "archive",
				)
				.map((t) => taskJson(t, defs));
			break;
	}
	return { view, namespace: nsLabel(filter.active), count: rows.length, tasks: rows };
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

export interface AddTaskArgs {
	text: string;
	namespace?: string;
	due?: string;
	scheduled?: string;
	start?: string;
}

export async function addTask(
	session: GtdSession,
	args: AddTaskArgs,
): Promise<Record<string, unknown>> {
	const filter = resolveWriteNamespace(args.namespace, session.settings);
	const active = filter.active;
	const defs = session.settings.namespaces;

	let line = quickCaptureLine(args.text);
	if (line === null) throw new Error("empty task text");
	// поля-даты дописываются поверх строки захвата теми же сеттерами ядра
	for (const [field, raw] of [
		["due", args.due],
		["scheduled", args.scheduled],
		["start", args.start],
	] as const) {
		if (raw === undefined) continue;
		const dt = parseDateTime(raw);
		line = setField(line, field, dt.date, dt.time, dt.timeEnd);
	}

	const fallback = nsCommonTarget(active, defs, NS_CONVENTION.inbox, session.settings.commonRoot);
	const target = captureTargetInNamespace(session.allTasks, active, defs, fallback);
	if (target === "") {
		throw new Error("no inbox target — set a non-empty commonRoot for the 'Общее' space");
	}
	if (!(await ensureCaptureFileNs(session.vault, target, active, defs))) {
		throw new Error(`could not prepare inbox file '${target}'`);
	}
	const ok = await session.vault.processFile(target, (content) => appendLine(content, line!));
	if (!ok) throw new Error(`could not write to '${target}'`);
	return { ok: true, file: target, namespace: nsLabel(active), line };
}

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

export interface UpdateTaskArgs {
	id: string;
	done?: boolean;
	text?: string;
	due?: string | null;
	scheduled?: string | null;
	start?: string | null;
	priority?: string;
}

export async function updateTask(
	session: GtdSession,
	args: UpdateTaskArgs,
): Promise<Record<string, unknown>> {
	const key = resolveTaskKey(session, args.id);
	const applied: string[] = [];
	const failed: { op: string; reason: string }[] = [];

	const run = async (op: string, factory: () => Intent): Promise<void> => {
		const res = await session.writeback.dispatch(factory());
		if (res.ok) applied.push(op);
		else failed.push({ op, reason: res.reason });
	};

	// Порядок: текст → даты → приоритет → статус. Ленивый 🆔 первой структурной
	// правки запоминается WritebackService и адресует остальные (одна сессия/инстанс).
	if (args.text !== undefined) {
		await run("text", () => ({ type: "set-text", key, text: args.text! }));
	}
	for (const field of ["due", "scheduled", "start"] as const) {
		if (!(field in args)) continue;
		const raw = args[field];
		if (raw === undefined) continue;
		if (raw === null) {
			await run(`${field}:clear`, () => ({ type: "set-date", key, field, date: null }));
		} else {
			const dt = parseDateTime(raw);
			await run(field, () => ({
				type: "set-date",
				key,
				field,
				date: dt.date,
				time: dt.time,
				timeEnd: dt.timeEnd,
			}));
		}
	}
	if (args.priority !== undefined) {
		const priority = assertPriority(args.priority);
		await run("priority", () => ({ type: "set-priority", key, priority }));
	}
	if (args.done !== undefined) {
		await run("done", () =>
			args.done
				? { type: "set-status", key, statusChar: "x", date: session.today }
				: { type: "set-status", key, statusChar: " " },
		);
	}

	if (applied.length === 0 && failed.length === 0) {
		throw new Error("nothing to update — provide done/text/due/scheduled/start/priority");
	}
	return { ok: failed.length === 0, id: args.id, applied, failed };
}

// ---------------------------------------------------------------------------
// delete_task
// ---------------------------------------------------------------------------

export interface DeleteTaskArgs {
	id: string;
	with_children?: boolean;
}

export async function deleteTask(
	session: GtdSession,
	args: DeleteTaskArgs,
): Promise<Record<string, unknown>> {
	const key = resolveTaskKey(session, args.id);
	const withChildren = args.with_children ?? true;
	const res = await session.writeback.dispatch({ type: "delete-line", key, withChildren });
	if (!res.ok) throw new Error(`delete failed: ${res.reason}`);
	return { ok: true, id: args.id, withChildren };
}

// ---------------------------------------------------------------------------
// move_card
// ---------------------------------------------------------------------------

export interface MoveCardArgs {
	board: string;
	id: string;
	column: string;
}

export async function moveCard(
	session: GtdSession,
	args: MoveCardArgs,
): Promise<Record<string, unknown>> {
	// доски ищем по ВСЕМ пространствам: карточка едет на свою доску независимо от
	// активного пространства сервера
	const allFilter: NamespaceFilter = { active: ALL_NS, defs: session.settings.namespaces };
	const board = findBoard(session, allFilter, args.board);
	const col = board.def.columns.find((c) => c.id === args.column || c.name === args.column);
	if (col === undefined) {
		const names = board.def.columns.map((c) => `'${c.name}'`).join(", ");
		throw new Error(`column '${args.column}' not found on board '${board.def.name}'. Columns: ${names}`);
	}
	const key = resolveTaskKey(session, args.id);
	const res = await session.boards.moveCard(
		board.path,
		board.def,
		key,
		col.id,
		Number.MAX_SAFE_INTEGER, // в конец колонки
	);
	if (!res.ok) throw new Error(`move failed: ${res.reason}`);
	return { ok: true, board: board.def.name, column: col.name, id: args.id };
}

// ---------------------------------------------------------------------------
// list_events
// ---------------------------------------------------------------------------

export interface ListEventsArgs {
	from: string;
	to: string;
	namespace?: string;
}

interface Occurrence {
	task: Task;
	kind: "series" | "single";
	date: string;
	title: string;
	time: string | null;
	timeEnd: string | null;
	location: string | null;
}

/** Развернуть строки-события в вхождения диапазона — та же логика, что
 *  expandEventOccurrences календаря (серии через expandOccurrences + 🚫,
 *  одноразовые по 📅), но без зависимости от слоя видов. */
function expandEvents(events: readonly Task[], from: string, to: string): Occurrence[] {
	const out: Occurrence[] = [];
	for (const task of events) {
		if (task.recurrence !== null) {
			const rule = parseRule(task.recurrence);
			if (isParseError(rule)) continue;
			const exclude =
				task.excludedDates.length > 0 ? new Set(task.excludedDates) : undefined;
			for (const date of expandOccurrences(rule, from, to, undefined, exclude)) {
				out.push({
					task,
					kind: "series",
					date,
					title: task.description,
					time: rule.eventTime ?? null,
					timeEnd: rule.eventTimeEnd ?? null,
					location: task.location,
				});
			}
		} else if (task.due !== null && task.due >= from && task.due <= to) {
			out.push({
				task,
				kind: "single",
				date: task.due,
				title: task.description,
				time: task.dueTime,
				timeEnd: task.dueTimeEnd,
				location: task.location,
			});
		}
	}
	out.sort((a, b) => {
		if (a.date !== b.date) return a.date < b.date ? -1 : 1;
		if (a.time !== null || b.time !== null) {
			if (a.time === null) return 1;
			if (b.time === null) return -1;
			if (a.time !== b.time) return a.time < b.time ? -1 : 1;
		}
		return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
	});
	return out;
}

export function listEvents(session: GtdSession, args: ListEventsArgs): Record<string, unknown> {
	const from = assertIsoDate(args.from, "from");
	const to = assertIsoDate(args.to, "to");
	if (from > to) throw new Error(`'from' (${from}) must not be after 'to' (${to})`);
	const filter = resolveNamespaceFilter(args.namespace, session.settings);
	const defs = session.settings.namespaces;
	const events = session.allTasks.filter(
		(t) =>
			t.container === "events" &&
			eventVisibleInNamespace(t.filePath, t.nsOverride ?? null, filter),
	);
	const occ = expandEvents(events, from, to).map((o) => {
		const row: Record<string, unknown> = {
			date: o.date,
			title: o.title,
			kind: o.kind,
			file: o.task.filePath,
			line: o.task.lineStart + 1,
			namespace: fileNsLabel(o.task.filePath, o.task.nsOverride, defs),
		};
		if (o.time !== null) row.time = o.time;
		if (o.timeEnd !== null) row.timeEnd = o.timeEnd;
		if (o.location !== null) row.location = o.location;
		if (o.task.taskId !== null) row.seriesId = o.task.taskId;
		if (o.kind === "series") row.recurrence = o.task.recurrence;
		return row;
	});
	return { from, to, namespace: nsLabel(filter.active), count: occ.length, events: occ };
}

// ---------------------------------------------------------------------------
// add_event
// ---------------------------------------------------------------------------

export interface AddEventArgs {
	name: string;
	namespace?: string;
	date?: string;
	time?: string;
	rule?: string;
	location?: string;
}

export async function addEvent(
	session: GtdSession,
	args: AddEventArgs,
): Promise<Record<string, unknown>> {
	const filter = resolveWriteNamespace(args.namespace, session.settings);
	const active = filter.active;
	const defs = session.settings.namespaces;
	const eventsFile = nsTargetPath(
		active,
		defs,
		NS_CONVENTION.events,
		session.settings.eventsFile,
	);
	const location = args.location !== undefined && args.location.trim() !== "" ? args.location : null;

	let res: EventWriteResult;
	let kind: "series" | "single";
	if (args.rule !== undefined && args.rule.trim() !== "") {
		if (isParseError(parseRule(args.rule))) {
			throw new Error(`invalid recurrence rule '${args.rule}'`);
		}
		// авто-from как в UI: закрепляем фазу недель серии от даты создания (сегодня)
		const ruleText = withSeriesAnchor(args.rule.trim(), session.today);
		res = await createEventSeries({
			vault: session.vault,
			eventsFile,
			name: args.name,
			ruleText,
			location,
		});
		kind = "series";
	} else if (args.date !== undefined && args.date.trim() !== "") {
		const dt = parseDateTime(args.date);
		let time = dt.time;
		let timeEnd = dt.timeEnd;
		if (args.time !== undefined && args.time.trim() !== "") {
			({ time, timeEnd } = parseTimeSpec(args.time));
		}
		res = await writeSingleEvent(session, eventsFile, args.name, dt.date, time, timeEnd, location);
		kind = "single";
	} else {
		throw new Error("provide either 'rule' (recurring) or 'date' (one-off event)");
	}

	if (!res.ok) throw new Error(`add_event failed: ${res.reason}`);
	return { ok: true, kind, file: eventsFile, namespace: nsLabel(active), name: args.name };
}

/**
 * Одноразовое событие с опциональным 📍 — зеркалит createSingleEvent ядра
 * (ensureFile + gtd-events: true СТРОГО до append), но переиспользует чистый
 * билдер строки buildSingleOccurrenceLine и добавляет место setValueField'ом.
 */
async function writeSingleEvent(
	session: GtdSession,
	eventsFile: string,
	name: string,
	date: string,
	time: string | null,
	timeEnd: string | null,
	location: string | null,
): Promise<EventWriteResult> {
	let line = buildSingleOccurrenceLine(name, date, time, timeEnd, null);
	if (line === null) return { ok: false, reason: "empty-name" };
	if (location !== null) {
		try {
			line = setValueField(line, "location", location);
		} catch {
			return { ok: false, reason: "invalid-location" };
		}
	}
	try {
		await session.vault.ensureFile(eventsFile);
		await session.vault.processFrontmatter(eventsFile, (fm) => {
			fm["gtd-events"] = true;
		});
	} catch {
		return { ok: false, reason: "events-file-create-failed" };
	}
	const finalLine = line;
	const ok = await session.vault.processFile(eventsFile, (content) => appendLine(content, finalLine));
	return ok ? { ok: true } : { ok: false, reason: "write-failed" };
}

// ---------------------------------------------------------------------------
// list_boards
// ---------------------------------------------------------------------------

export interface ListBoardsArgs {
	namespace?: string;
}

export function listBoards(session: GtdSession, args: ListBoardsArgs): Record<string, unknown> {
	const filter = resolveNamespaceFilter(args.namespace, session.settings);
	const defs = session.settings.namespaces;
	const { boards, errors } = session.boards.discoverBoards(filter);
	const rows = boards.map((b) => {
		const model = session.boards.boardModel(b.path, b.def);
		const columns = model.columns.map((c) => ({ id: c.id, name: c.name, count: c.tasks.length }));
		const total = columns.reduce((n, c) => n + c.count, 0);
		const nsOverride = frontmatterNamespace(session.vault.readFrontmatterSync(b.path));
		return {
			id: b.def.id,
			name: b.def.name,
			path: b.path,
			namespace: fileNsLabel(b.path, nsOverride, defs),
			total,
			columns,
		};
	});
	const result: Record<string, unknown> = {
		namespace: nsLabel(filter.active),
		count: rows.length,
		boards: rows,
	};
	if (errors.length > 0) result.warnings = errors.map((e) => `${e.path}: ${e.error}`);
	return result;
}

// ---------------------------------------------------------------------------
// Резолверы доски/проекта
// ---------------------------------------------------------------------------

function findBoard(
	session: GtdSession,
	filter: NamespaceFilter,
	board: string,
): DiscoveredBoard {
	const { boards } = session.boards.discoverBoards(filter);
	const matches = boards.filter((b) => b.def.id === board || b.def.name === board);
	if (matches.length === 0) {
		const avail = boards.map((b) => `'${b.def.name}'`).join(", ") || "none";
		throw new Error(`board '${board}' not found. Available: ${avail}`);
	}
	if (matches.length > 1) {
		throw new Error(`board '${board}' is ambiguous (${matches.length} matches) — use its id`);
	}
	return matches[0]!;
}

function findProjectPath(session: GtdSession, filter: NamespaceFilter, project: string): string {
	const summaries = session.projects.discoverProjects(filter);
	const matches = summaries.filter(
		(p) =>
			p.path === project ||
			p.name === project ||
			p.path.endsWith(`/${project}.md`) ||
			p.path === `${project}.md`,
	);
	if (matches.length === 0) {
		const avail = summaries.map((p) => `'${p.name}'`).join(", ") || "none";
		throw new Error(`project '${project}' not found. Available: ${avail}`);
	}
	if (matches.length > 1) {
		throw new Error(`project '${project}' is ambiguous (${matches.length} matches) — use its path`);
	}
	return matches[0]!.path;
}
