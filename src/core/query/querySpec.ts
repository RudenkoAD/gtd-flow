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
	/** Файлы/папки захвата — force-include во входящие. */
	inboxSources: string[];
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

export function defaultInboxConfig(inboxSources: string[]): InboxConfig {
	return { inboxSources, hasBoardTag: defaultHasBoardTag, hasDue: defaultHasDue };
}

/** Источник = точный файл либо папка. Папочный префикс — только по границе
 *  сегмента пути: "GTD/In" не матчит "GTD/Inbox.md". */
export function matchesInboxSource(filePath: string, sources: readonly string[]): boolean {
	for (const source of sources) {
		if (source.length === 0) continue;
		if (source.endsWith("/")) {
			if (filePath.startsWith(source)) return true;
		} else if (filePath === source || filePath.startsWith(source + "/")) {
			return true;
		}
	}
	return false;
}
