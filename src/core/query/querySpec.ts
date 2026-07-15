/**
 * Типизированные спецификации запросов и конфиг входящих (ТЗ §1, §2).
 * QuerySpec сериализуем в JSON — пригоден для мемоизации (epoch, today, specHash).
 */
import type { IsoDate, Task } from "../model/Task";
import type { CalendarField } from "../model/projections";

export type QuerySpec =
	| { kind: "inbox" }
	| { kind: "tickler" }
	| { kind: "active" }
	| { kind: "all-templates" }
	| { kind: "project-members"; path: string }
	| {
			kind: "calendar-range";
			fromIso: IsoDate;
			toIso: IsoDate; // включительно
			placement: readonly CalendarField[];
	  };

/** Биты настроек, нужные inbox-запросу §1. Предикаты инжектируются,
 *  чтобы ядро не знало о формате настроек (projectStrategy и т.п.).
 *  inboxSources здесь БОЛЬШЕ НЕТ: с фидбек-раунда 2 источники захвата —
 *  только цели записи (quick-add, spawn), а не force-include запроса. */
export interface InboxConfig {
	hasBoardTag: (t: Task) => boolean;
	hasDue: (t: Task) => boolean;
}

export function defaultHasBoardTag(t: Task): boolean {
	// container === "board" — задача живёт в файле gtd-board (§1): она уже
	// разобрана по колонке status-доски и не должна попадать во входящие,
	// как и hasProject выводится из container === "project".
	return t.container === "board" || t.tags.some((tag) => tag.startsWith("#kanban/"));
}

export function defaultHasDue(t: Task): boolean {
	return t.due !== null;
}

/**
 * Параметр _inboxSources игнорируется и оставлен только ради совместимости
 * вызовов видов/фабрик (Inbox.svelte, queryStore передают settings.inboxSources):
 * формула входящих упрощена — «задача с датой — уже разобрана», force-include
 * источников захвата упразднён.
 */
export function defaultInboxConfig(_inboxSources?: readonly string[]): InboxConfig {
	return { hasBoardTag: defaultHasBoardTag, hasDue: defaultHasDue };
}
