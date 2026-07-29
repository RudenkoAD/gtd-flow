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
 *  чтобы ядро не знало о формате настроек (projectStrategy и т.п.). */
export interface InboxConfig {
	hasBoardTag: (t: Task) => boolean;
	hasDue: (t: Task) => boolean;
	/** The only configured capture file. Legacy `gtd-inbox` markers elsewhere are
	 * retained for rollback, but cannot create additional runtime inboxes. */
	inboxFile: string;
	/** Скоуп входящих (скалярная настройка, а не Settings в ядре): включать ли
	 *  активные задачи из ОБЫЧНЫХ заметок (container "plain"). false — входящие
	 *  ограничены configured inbox + готовые задачи проектов.
	 *  См. isInInbox в QueryEngine. */
	includePlain: boolean;
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

/** `inboxFile` is the only capture-container path. Keeping an older
 * `gtd-inbox: true` marker is safe for migration rollback, but it no longer
 * makes that file a runtime inbox source. */
export function defaultInboxConfig(includePlain = false, inboxFile = "GTD/Inbox.md"): InboxConfig {
	return { hasBoardTag: defaultHasBoardTag, hasDue: defaultHasDue, inboxFile, includePlain };
}
