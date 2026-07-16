/**
 * Вычислитель запросов (ТЗ §1, §2): чистая функция (spec, ctx) → Task[].
 * Формулы inbox/tickler — дословно из §1; предикаты переиспользуются из gtdState.
 */
import type { IsoDate, Priority, Task } from "../model/Task";
import {
	isActive,
	isArchived,
	isCancelled,
	isDetail,
	isDone,
	isEvent,
	isTemplate,
	ready,
	type ResolveDep,
} from "../model/gtdState";
import { taskToCalendarEvent } from "../model/projections";
import type { InboxConfig, QuerySpec } from "./querySpec";

export interface QueryContext {
	tasks: Iterable<Task>;
	today: IsoDate;
	resolveDep: ResolveDep;
	settingsBits: InboxConfig;
}

/**
 * §1, упрощено в фидбек-раунде 2 (решение пользователя: «задача с датой —
 * уже разобрана», force-include источников захвата упразднён; inboxSources
 * остались только целями записи quick-add/spawn):
 *
 * inbox := active && !hasBoardTag && !hasDue
 *       && (container === "project" ? (projectActive && ready)
 *           : container === "plain"  ? includePlain
 *           : true)                          // container "inbox" — всегда
 * где hasDue = t.due !== null, includePlain — настройка скоупа входящих.
 *
 * !hasBoardTag — итог живой верификации раунда 1: карточка, перетащенная
 * на доску прямо из Inbox.md, обязана уйти из входящих, иначе разбор
 * входящих не «опустошает» их — доверие к инбоксу ломается.
 *
 * СКОУП ВХОДЯЩИХ (фидбек-раунд по реальному vault): на хранилище с сотнями
 * чек-листов в обычных заметках формула «активная задача из любого файла»
 * затапливала входящие. По умолчанию (includePlain === false) задачи обычных
 * файлов (container "plain") во входящие НЕ попадают — остаются только захват
 * (container "inbox") и готовые задачи проектов. includePlain === true
 * возвращает старое поведение «всё хранилище». Календарь/отложенные/доски
 * настройка не затрагивает — меняется только членство во входящих.
 */
export function isInInbox(t: Task, ctx: QueryContext): boolean {
	if (!isActive(t, ctx.today)) return false;
	const bits = ctx.settingsBits;
	if (bits.hasBoardTag(t) || bits.hasDue(t)) return false;
	if (t.container === "project") return t.projectActive && ready(t, ctx.today, ctx.resolveDep);
	// Обычные заметки: во входящие только с явного разрешения (скоуп входящих).
	if (t.container === "plain") return bits.includePlain;
	// container "inbox" — файл захвата, всегда во входящих (если активна и не разобрана).
	return true;
}

/**
 * §1: in tickler := !done && !cancelled && start > today (строго: start == today — не тикль).
 * TEMPLATE/DETAIL/EVENT исключены: по цепочке §1 они выше TICKLER и видны только в своих видах.
 * ARCHIVED тоже исключён — архив полностью инертен и не протекает ни в один запрос.
 */
export function isInTickler(t: Task, today: IsoDate): boolean {
	if (isTemplate(t) || isDetail(t) || isEvent(t) || isArchived(t)) return false;
	return !isDone(t) && !isCancelled(t) && t.start !== null && t.start > today;
}

export function evaluate(spec: QuerySpec, ctx: QueryContext): Task[] {
	switch (spec.kind) {
		case "inbox": {
			const out = collect(ctx.tasks, (t) => isInInbox(t, ctx));
			out.sort(cmpInbox);
			return out;
		}
		case "tickler": {
			const out = collect(ctx.tasks, (t) => isInTickler(t, ctx.today));
			out.sort(cmpTickler);
			return out;
		}
		case "active": {
			const out = collect(ctx.tasks, (t) => isActive(t, ctx.today));
			out.sort(cmpLocation);
			return out;
		}
		case "all-templates": {
			const out = collect(ctx.tasks, (t) => isTemplate(t));
			out.sort(cmpLocation);
			return out;
		}
		case "project-members": {
			// Членство = задачи файла проекта (byFile, §7) — без фильтра по состоянию:
			// вид проекта показывает и done, и blocked.
			const out = collect(ctx.tasks, (t) => t.filePath === spec.path);
			out.sort(cmpLocation);
			return out;
		}
		case "calendar-range": {
			const placed: { t: Task; date: IsoDate }[] = [];
			for (const t of ctx.tasks) {
				// EVENT-шаблоны рендерятся ОТДЕЛЬНО как виртуальные вхождения (expandOccurrences),
				// сама строка события в календарь-диапазон как задача не протекает.
				// ARCHIVED исключён здесь же: архив полностью инертен — зачёркнутая
				// заархивированная задача с датой больше не мелькает в календаре.
				if (isTemplate(t) || isDetail(t) || isEvent(t) || isArchived(t)) continue;
				const ev = taskToCalendarEvent(t, spec.placement);
				if (ev === null) continue;
				if (ev.date < spec.fromIso || ev.date > spec.toIso) continue;
				placed.push({ t, date: ev.date });
			}
			placed.sort((a, b) =>
				a.date !== b.date ? (a.date < b.date ? -1 : 1) : cmpLocation(a.t, b.t),
			);
			return placed.map((p) => p.t);
		}
	}
}

// ---------------------------------------------------------------------------
// Сортировки
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<Priority, number> = {
	highest: 0,
	high: 1,
	medium: 2,
	low: 3,
	lowest: 4,
	none: 5,
};

/** Входящие: приоритет по убыванию → created по возрастанию (null — в конец) → файл/строка. */
function cmpInbox(a: Task, b: Task): number {
	const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
	if (pr !== 0) return pr;
	const cr = cmpNullableIsoAsc(a.created, b.created);
	if (cr !== 0) return cr;
	return cmpLocation(a, b);
}

/** Отложенные: по start по возрастанию → файл/строка. */
function cmpTickler(a: Task, b: Task): number {
	const st = cmpNullableIsoAsc(a.start, b.start);
	if (st !== 0) return st;
	return cmpLocation(a, b);
}

function cmpNullableIsoAsc(a: IsoDate | null, b: IsoDate | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a < b ? -1 : 1;
}

/** Детерминированный тай-брейк: IsoDate и пути сравниваются лексикографически. */
function cmpLocation(a: Task, b: Task): number {
	if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
	return a.lineStart - b.lineStart;
}

function collect(tasks: Iterable<Task>, pred: (t: Task) => boolean): Task[] {
	const out: Task[] = [];
	for (const t of tasks) if (pred(t)) out.push(t);
	return out;
}
