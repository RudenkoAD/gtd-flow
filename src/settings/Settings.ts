/** Модель настроек (ТЗ §9). Персистится через loadData/saveData. */

export type PromoteTo = "origin" | "inbox";
export type CatchUpPolicy = "latest" | "all" | "none";
export type CalendarField = "due" | "scheduled" | "start";

export interface DeferPreset {
	label: string;
	/** Смещение в днях от сегодня. */
	offsetDays: number;
}

export interface GtdFlowSettings {
	/** Файлы/папки, задачи которых force-include во входящие. */
	inboxSources: string[];
	/** Как определяется hasProject вне gtd-project файлов. */
	projectStrategy: "tag" | "folder";
	projectTagPrefix: string;
	/** Приоритет поля для размещения задачи в календаре. */
	calendarPlacement: CalendarField[];
	deferPresets: DeferPreset[];
	firstDayOfWeek: number; // 0=вс … 6=сб
	/** Кастомные символы статуса → GTD-состояние (переопределения). */
	statusMap: Record<string, string>;
	autoInjectId: boolean;
	debounceMs: { fileReindex: number; queryRecompute: number };
	virtualizeThreshold: number;
	promoteTo: PromoteTo;
	recurring: {
		spawnTarget: string;
		catchUp: CatchUpPolicy;
		catchUpCap: number;
	};
	cardsFolder: string;
	cardLinkInLine: boolean;
}

export const DEFAULT_SETTINGS: GtdFlowSettings = {
	inboxSources: ["GTD/Inbox.md"],
	projectStrategy: "tag",
	projectTagPrefix: "#project/",
	calendarPlacement: ["due", "scheduled", "start"],
	deferPresets: [
		{ label: "Завтра", offsetDays: 1 },
		{ label: "+3 дня", offsetDays: 3 },
		{ label: "Через неделю", offsetDays: 7 },
	],
	firstDayOfWeek: 1,
	statusMap: {},
	autoInjectId: true,
	debounceMs: { fileReindex: 150, queryRecompute: 50 },
	virtualizeThreshold: 100,
	promoteTo: "origin",
	recurring: {
		spawnTarget: "GTD/Inbox.md",
		catchUp: "latest",
		catchUpCap: 30,
	},
	cardsFolder: "GTD/Cards",
	cardLinkInLine: true,
};
