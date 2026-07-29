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
import type { Intent } from "../core/intents/Intent";
import {
	isDurationMinutes,
	isIntensityLevel,
	type DurationMinutes,
	type IntensityLevel,
	type Priority,
	type Task,
} from "../core/model/Task";
import { isScopeId, scopeById } from "../core/scope/scope";
import { parseDatePayload } from "../core/parser/parseTaskLine";
import {
	setDurationMinutes,
	setField,
	setIntensity,
	setScopeId,
	setValueField,
} from "../core/parser/serializeTaskLine";
import { evaluate, type QueryContext } from "../core/query/QueryEngine";
import { defaultInboxConfig } from "../core/query/querySpec";
import { isParseError, parseRule } from "../core/recurrence/grammar";
import { expandOccurrences } from "../core/recurrence/occurrences";
import type { EventWriteResult } from "../views/calendar/eventSeries";
import {
	buildSingleOccurrenceLine,
	createEventSeries,
	withSeriesAnchor,
} from "../views/calendar/eventSeries";
import { ensureCaptureFile, quickCaptureLine } from "../views/common/taskActions";
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
		if (!TIME_RE.test(timeEnd))
			throw new Error(`invalid end time '${timeEnd}' — expected HH:mm`);
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

function queryContext(session: GtdSession): QueryContext {
	const index = session.feed.getIndex();
	return {
		tasks: session.allTasks,
		today: session.today,
		resolveDep: (id) => index.resolveDep(id),
		settingsBits: defaultInboxConfig(
			session.settings.inboxIncludePlain,
			session.settings.inboxFile,
		),
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
function taskJson(t: Task): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: t.taskId ?? t.key,
		description: t.description,
		status: t.statusChar,
		done: isDone(t) || isCancelled(t),
		file: t.filePath,
		line: t.lineStart + 1, // 1-based для человека/агента
		container: t.container,
		// Stable MCP task contract. Keep null rather than omitting: callers can
		// distinguish an unprocessed/cleared field from an older server response.
		duration_minutes: t.durationMinutes,
		cognitive_intensity: t.cognitiveIntensity,
		emotional_intensity: t.emotionalIntensity,
		physical_intensity: t.physicalIntensity,
		scope: t.scopeId,
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

interface MetadataPatch {
	durationMinutes?: DurationMinutes | null;
	cognitiveIntensity?: IntensityLevel | null;
	emotionalIntensity?: IntensityLevel | null;
	physicalIntensity?: IntensityLevel | null;
	scopeId?: string | null;
}

/** Read filters may use archived scopes; writes must select an active one. */
function assertKnownScope(session: GtdSession, scopeId: string): void {
	if (!isScopeId(scopeId) || scopeById(session.scopeCatalog, scopeId) === null) {
		throw new Error(`unknown scope '${scopeId}'`);
	}
}

function assertActiveScope(session: GtdSession, scopeId: string): string {
	assertKnownScope(session, scopeId);
	if (scopeById(session.scopeCatalog, scopeId)?.archived) {
		throw new Error(`scope '${scopeId}' is archived and cannot be assigned`);
	}
	return scopeId;
}

function metadataPatchFromArgs(
	session: GtdSession,
	args: Pick<
		UpdateTaskArgs,
		| "duration_minutes"
		| "cognitive_intensity"
		| "emotional_intensity"
		| "physical_intensity"
		| "scope"
	>,
): MetadataPatch {
	const patch: MetadataPatch = {};
	if (args.duration_minutes !== undefined) {
		if (args.duration_minutes !== null && !isDurationMinutes(args.duration_minutes)) {
			throw new Error(
				"duration_minutes must use five-minute increments below 24h and whole-day increments from 24h",
			);
		}
		patch.durationMinutes = args.duration_minutes;
	}
	for (const [input, output] of [
		["cognitive_intensity", "cognitiveIntensity"],
		["emotional_intensity", "emotionalIntensity"],
		["physical_intensity", "physicalIntensity"],
	] as const) {
		const value = args[input];
		if (value === undefined) continue;
		if (value !== null && !isIntensityLevel(value)) {
			throw new Error(`${input} must be an integer from 0 to 5`);
		}
		patch[output] = value;
	}
	if (args.scope !== undefined) {
		patch.scopeId = args.scope === null ? null : assertActiveScope(session, args.scope);
	}
	return patch;
}

function applyMetadataToNewLine(session: GtdSession, line: string, args: AddTaskArgs): string {
	const patch = metadataPatchFromArgs(session, args);
	let next = line;
	if (patch.durationMinutes !== undefined) next = setDurationMinutes(next, patch.durationMinutes);
	if (patch.cognitiveIntensity !== undefined)
		next = setIntensity(next, "cognitiveIntensity", patch.cognitiveIntensity);
	if (patch.emotionalIntensity !== undefined)
		next = setIntensity(next, "emotionalIntensity", patch.emotionalIntensity);
	if (patch.physicalIntensity !== undefined)
		next = setIntensity(next, "physicalIntensity", patch.physicalIntensity);
	if (patch.scopeId !== undefined) next = setScopeId(next, patch.scopeId);
	return next;
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
	return {
		today: session.today,
		inbox: evaluate({ kind: "inbox" }, queryContext(session)).length,
		tickler: evaluate({ kind: "tickler" }, queryContext(session)).length,
		boards: session.boards.discoverBoards().boards.length,
		projects: session.projects.discoverProjects().length,
		events: session.allTasks.filter((task) => task.container === "events").length,
		scopes: session.scopeCatalog.scopes.map((scope) => ({
			id: scope.id,
			name: scope.name,
			archived: scope.archived,
			task_count: session.allTasks.filter((task) => task.scopeId === scope.id).length,
		})),
		unscoped_task_count: session.allTasks.filter((task) => task.scopeId === null).length,
	};
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

export interface ListTasksArgs {
	/** Canonical scope ID filter. */
	scope?: string;
	view?: "inbox" | "tickler" | "board" | "project" | "all";
	board?: string;
	project?: string;
	include_done?: boolean;
}

export function listTasks(session: GtdSession, args: ListTasksArgs): Record<string, unknown> {
	if (args.scope !== undefined) assertKnownScope(session, args.scope);
	const view = args.view ?? "all";
	const includeDone = args.include_done ?? false;
	const keepDone = (t: Task): boolean => includeDone || !(isDone(t) || isCancelled(t));

	let rows: Record<string, unknown>[];
	switch (view) {
		case "inbox":
			rows = evaluate({ kind: "inbox" }, queryContext(session)).map((t) => taskJson(t));
			break;
		case "tickler":
			rows = evaluate({ kind: "tickler" }, queryContext(session)).map((t) => taskJson(t));
			break;
		case "board": {
			if (args.board !== undefined && args.board !== "") {
				const board = findBoard(session, args.board);
				const model = session.boards.boardModel(board.path, board.def);
				rows = [];
				for (const col of model.columns) {
					for (const t of col.tasks) {
						if (!keepDone(t)) continue;
						rows.push({ ...taskJson(t), column: col.name, columnId: col.id });
					}
				}
			} else {
				rows = session.allTasks
					.filter(
						(t) =>
							keepDone(t) &&
							(t.container === "board" ||
								t.tags.some((tag) => tag.startsWith("#kanban/"))),
					)
					.map((t) => taskJson(t));
			}
			break;
		}
		case "project": {
			if (args.project !== undefined && args.project !== "") {
				const path = findProjectPath(session, args.project);
				rows = session.feed
					.getIndex()
					.fileTasks(path)
					.filter(keepDone)
					.map((t) => taskJson(t));
			} else {
				rows = session.allTasks
					.filter((t) => keepDone(t) && t.container === "project")
					.map((t) => taskJson(t));
			}
			break;
		}
		case "all":
			rows = session.allTasks
				.filter((t) => keepDone(t) && t.container !== "events" && t.container !== "archive")
				.map((t) => taskJson(t));
			break;
	}
	if (args.scope !== undefined) rows = rows.filter((task) => task.scope === args.scope);
	return { view, scope: args.scope ?? null, count: rows.length, tasks: rows };
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

export interface AddTaskArgs {
	text: string;
	duration_minutes?: number | null;
	cognitive_intensity?: number | null;
	emotional_intensity?: number | null;
	physical_intensity?: number | null;
	scope?: string | null;
	due?: string;
	scheduled?: string;
	start?: string;
}

export async function addTask(
	session: GtdSession,
	args: AddTaskArgs,
): Promise<Record<string, unknown>> {
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
	line = applyMetadataToNewLine(session, line, args);

	const target = session.settings.inboxFile;
	if (!(await ensureCaptureFile(session.vault, target))) {
		throw new Error(`could not prepare inbox file '${target}'`);
	}
	const ok = await session.vault.processFile(target, (content) => appendLine(content, line!));
	if (!ok) throw new Error(`could not write to '${target}'`);
	return { ok: true, file: target, line };
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
	/** 📍 место: строка задаёт (пустая/пробельная — снимает), null снимает поле.
	 *  Применяется интентом ядра 'set-location' (📍 вырезано из content-key —
	 *  ключ задачи стабилен). */
	location?: string | null;
	duration_minutes?: number | null;
	cognitive_intensity?: number | null;
	emotional_intensity?: number | null;
	physical_intensity?: number | null;
	scope?: string | null;
}

export async function updateTask(
	session: GtdSession,
	args: UpdateTaskArgs,
): Promise<Record<string, unknown>> {
	const key = resolveTaskKey(session, args.id);

	// Все правки собираются в ОДИН пакет и применяются одной записью
	// (WritebackService.dispatchMany): строка локализуется один раз, трансформы
	// сворачиваются последовательно внутри единого processFile. Внешняя правка
	// файла между отдельными dispatch'ами больше не даёт частичного применения,
	// а прежний якорь-🆔 для id-less комбинаций с text (a6392b2) не нужен:
	// content-key меняется только ПОСЛЕ единственной записи. Семантика
	// всё-или-ничего: сбой любой операции ⇒ файл не тронут, все ops — failed.
	const ops: { op: string; intent: Intent & { key: string } }[] = [];

	// Порядок: текст → даты → приоритет → место → статус (стабильные имена ops).
	if (args.text !== undefined) {
		ops.push({ op: "text", intent: { type: "set-text", key, text: args.text } });
	}
	for (const field of ["due", "scheduled", "start"] as const) {
		if (!(field in args)) continue;
		const raw = args[field];
		if (raw === undefined) continue;
		if (raw === null) {
			ops.push({
				op: `${field}:clear`,
				intent: { type: "set-date", key, field, date: null },
			});
		} else {
			const dt = parseDateTime(raw);
			ops.push({
				op: field,
				intent: {
					type: "set-date",
					key,
					field,
					date: dt.date,
					time: dt.time,
					timeEnd: dt.timeEnd,
				},
			});
		}
	}
	if (args.priority !== undefined) {
		const priority = assertPriority(args.priority);
		ops.push({ op: "priority", intent: { type: "set-priority", key, priority } });
	}
	if (args.location !== undefined) {
		// null и пустая/пробельная строка — снять 📍 (нормализует resolveIntent);
		// имена операций зеркалят даты: 'location' — задать, 'location:clear' — снять
		const loc = args.location;
		if (loc === null || loc.trim() === "") {
			ops.push({
				op: "location:clear",
				intent: { type: "set-location", key, location: null },
			});
		} else {
			ops.push({ op: "location", intent: { type: "set-location", key, location: loc } });
		}
	}
	const metadata = metadataPatchFromArgs(session, args);
	if (Object.keys(metadata).length > 0) {
		ops.push({ op: "metadata", intent: { type: "patch-task-metadata", key, ...metadata } });
	}
	if (args.done !== undefined) {
		ops.push({
			op: "done",
			intent: args.done
				? { type: "set-status", key, statusChar: "x", date: session.today }
				: { type: "set-status", key, statusChar: " " },
		});
	}

	if (ops.length === 0) {
		throw new Error(
			"nothing to update — provide done/text/due/scheduled/start/priority/location/duration_minutes/cognitive_intensity/emotional_intensity/physical_intensity/scope",
		);
	}

	const res = await session.writeback.dispatchMany(ops.map((o) => o.intent));
	if (res.ok) {
		return { ok: true, id: args.id, applied: ops.map((o) => o.op), failed: [] };
	}
	// всё-или-ничего: файл не записан, все операции — failed; виновник (opIndex)
	// несёт исходную причину, остальные — пометку об отменённом пакете
	const culprit = res.opIndex >= 0 ? ops[res.opIndex]?.op : undefined;
	const failed = ops.map((o) => ({
		op: o.op,
		reason:
			o.op === culprit
				? res.reason
				: culprit !== undefined
					? `not applied — atomic batch aborted by '${culprit}': ${res.reason}`
					: res.reason,
	}));
	return { ok: false, id: args.id, applied: [], failed };
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
	const board = findBoard(session, args.board);
	const col = board.def.columns.find((c) => c.id === args.column || c.name === args.column);
	if (col === undefined) {
		const names = board.def.columns.map((c) => `'${c.name}'`).join(", ");
		throw new Error(
			`column '${args.column}' not found on board '${board.def.name}'. Columns: ${names}`,
		);
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
			const exclude = task.excludedDates.length > 0 ? new Set(task.excludedDates) : undefined;
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
	const events = session.allTasks.filter((task) => task.container === "events");
	const occ = expandEvents(events, from, to).map((o) => {
		const row: Record<string, unknown> = {
			date: o.date,
			title: o.title,
			kind: o.kind,
			file: o.task.filePath,
			line: o.task.lineStart + 1,
		};
		if (o.time !== null) row.time = o.time;
		if (o.timeEnd !== null) row.timeEnd = o.timeEnd;
		if (o.location !== null) row.location = o.location;
		if (o.task.taskId !== null) row.seriesId = o.task.taskId;
		if (o.kind === "series") row.recurrence = o.task.recurrence;
		return row;
	});
	return { from, to, count: occ.length, events: occ };
}

// ---------------------------------------------------------------------------
// add_event
// ---------------------------------------------------------------------------

export interface AddEventArgs {
	name: string;
	date?: string;
	time?: string;
	rule?: string;
	location?: string;
}

export async function addEvent(
	session: GtdSession,
	args: AddEventArgs,
): Promise<Record<string, unknown>> {
	const eventsFile = session.settings.eventsFile;
	const location =
		args.location !== undefined && args.location.trim() !== "" ? args.location : null;

	const hasRule = args.rule !== undefined && args.rule.trim() !== "";
	const hasDate = args.date !== undefined && args.date.trim() !== "";
	const hasTime = args.time !== undefined && args.time.trim() !== "";

	// date и rule взаимоисключающи (date — одноразовое, rule — повторяющееся).
	// Раньше при обоих rule молча побеждал, а date игнорировался — теперь явная
	// ошибка вместо двусмысленного тихого поведения.
	if (hasRule && hasDate) {
		throw new Error(
			"'date' and 'rule' are mutually exclusive — pass 'date' for a one-off event or 'rule' for a recurring one, not both",
		);
	}

	let res: EventWriteResult;
	let kind: "series" | "single";
	if (hasRule) {
		let ruleText = args.rule!.trim();
		// time вместе с rule: вплавляем в правило хвостом ' at <time>' (время
		// вхождения серии живёт внутри грамматики). Если в правиле уже есть клауза
		// 'at' — двусмысленно (грамматика тоже отвергла бы дубль), ошибка с понятной
		// подсказкой. \bat\b не цепляет 'at' внутри слов (saturday и пр.).
		if (hasTime) {
			if (/\bat\b/i.test(ruleText)) {
				throw new Error(
					"rule already sets a time via 'at ...' — drop the separate 'time' argument (or remove 'at' from the rule)",
				);
			}
			ruleText = `${ruleText} at ${args.time!.trim()}`;
		}
		const parsedRule = parseRule(ruleText);
		if (isParseError(parsedRule)) {
			throw new Error(`invalid recurrence rule '${ruleText}'`);
		}
		// серии событий с «every!» запрещены — событие не «выполняется» (§every!)
		if (parsedRule.fromCompletion) {
			throw new Error(
				`'every!' (from-completion) rules are for tasks only, not calendar events: '${ruleText}'`,
			);
		}
		// авто-from как в UI: закрепляем фазу недель серии от даты создания (сегодня)
		res = await createEventSeries({
			vault: session.vault,
			eventsFile,
			name: args.name,
			ruleText: withSeriesAnchor(ruleText, session.today),
			location,
		});
		kind = "series";
	} else if (hasDate) {
		const dt = parseDateTime(args.date!);
		let time = dt.time;
		let timeEnd = dt.timeEnd;
		if (hasTime) {
			({ time, timeEnd } = parseTimeSpec(args.time!));
		}
		res = await writeSingleEvent(
			session,
			eventsFile,
			args.name,
			dt.date,
			time,
			timeEnd,
			location,
		);
		kind = "single";
	} else {
		throw new Error("provide either 'rule' (recurring) or 'date' (one-off event)");
	}

	if (!res.ok) throw new Error(`add_event failed: ${res.reason}`);
	return { ok: true, kind, file: eventsFile, name: args.name };
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
	const ok = await session.vault.processFile(eventsFile, (content) =>
		appendLine(content, finalLine),
	);
	return ok ? { ok: true } : { ok: false, reason: "write-failed" };
}

// ---------------------------------------------------------------------------
// list_boards
// ---------------------------------------------------------------------------

export type ListBoardsArgs = Record<string, never>;

export function listBoards(session: GtdSession, _args: ListBoardsArgs): Record<string, unknown> {
	const { boards, errors } = session.boards.discoverBoards();
	const rows = boards.map((b) => {
		const model = session.boards.boardModel(b.path, b.def);
		const columns = model.columns.map((c) => ({
			id: c.id,
			name: c.name,
			count: c.tasks.length,
		}));
		const total = columns.reduce((n, c) => n + c.count, 0);
		return {
			id: b.def.id,
			name: b.def.name,
			path: b.path,
			total,
			columns,
		};
	});
	const result: Record<string, unknown> = {
		count: rows.length,
		boards: rows,
	};
	if (errors.length > 0) result.warnings = errors.map((e) => `${e.path}: ${e.error}`);
	return result;
}

// ---------------------------------------------------------------------------
// Резолверы доски/проекта
// ---------------------------------------------------------------------------

function findBoard(session: GtdSession, board: string): DiscoveredBoard {
	const { boards } = session.boards.discoverBoards();
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

function findProjectPath(session: GtdSession, project: string): string {
	const summaries = session.projects.discoverProjects();
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
		throw new Error(
			`project '${project}' is ambiguous (${matches.length} matches) — use its path`,
		);
	}
	return matches[0]!.path;
}
