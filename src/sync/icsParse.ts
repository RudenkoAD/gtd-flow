/**
 * Разбор iCal-ленты (ICS) и развёртка вхождений в окно календаря (§внешние
 * календари). Единственный потребитель библиотеки **ical.js** в кодовой базе:
 * она умеет RRULE-серии, EXDATE, RECURRENCE-ID-переопределения, таймзоны и
 * all-day — переизобретать это в нашей грамматике повторов было бы неверно
 * (та заточена под ручной ввод, а не под чужой стандарт RFC 5545).
 *
 * Модуль живёт в src/sync (НЕ в src/core — там запрещены внешние зависимости и
 * obsidian; см. scripts/check-core-purity.mjs). Импортирует только ical.js и
 * чистое ядро-парсер (эмодзи-поля) — ни obsidian, ни DOM: тестируется в node.
 *
 * Выход — плоский список «строк-зеркал» (MirrorOccurrence): по одной на КАЖДЫЙ
 * покрытый календарный день. Многодневные вхождения раскладываются на all-day
 * строки по дням (решение §). Времена вхождений конвертируются в ЛОКАЛЬНОЕ время
 * устройства (toJSDate), даты all-day берутся ЛИТЕРАЛЬНО из полей (без сдвига
 * таймзоной). Идентичность вхождения (recurrenceKey) — таймзоно-канонична
 * (RECURRENCE-ID/DTSTART источника), поэтому одинакова на всех устройствах.
 */
import ICAL from "ical.js";
import type { IsoDate } from "../core/model/Task";
import { ALL_FIELD_EMOJI } from "../core/parser/emoji";

/**
 * Окно развёртки вхождений (решение §): 14 дней назад и 92 дня вперёд от
 * «сегодня». Прошлое короткое — недавние события ещё полезны в агенде/просрочке;
 * будущее ~3 месяца — обозримый горизонт планирования без раздувания файла.
 */
export const MIRROR_WINDOW_PAST_DAYS = 14;
export const MIRROR_WINDOW_FUTURE_DAYS = 92;

/**
 * Explicit limits for an untrusted ICS feed.  These are deliberately kept in
 * the parser (rather than only at the HTTP boundary): callers such as tests,
 * future importers, and the MCP server get the same protection.
 */
export interface IcsParseBudget {
	/** Maximum UTF-8 response size accepted from one feed. */
	maxResponseBytes: number;
	/**
	 * Maximum physical RFC 5545 lines before handing input to ical.js.  This
	 * caps parser object allocation even when the feed contains few VEVENTs.
	 */
	maxPhysicalLines: number;
	/**
	 * Maximum unfolded UTF-16 code units in a single content line.  This is the
	 * meaningful per-property cap: a DESCRIPTION longer than this is refused,
	 * everything shorter must survive folding (see the two limits below).
	 */
	maxUnfoldedLineChars: number;
	/** Maximum folded physical lines that may continue one content line. */
	maxFoldedLinesPerContentLine: number;
	/**
	 * Upper bound for the cumulative string-copy work that ical.js performs
	 * while concatenating one folded content line.
	 */
	maxUnfoldingWorkChars: number;
	/** Maximum `=` parameter separators before a content line's value. */
	maxParametersPerContentLine: number;
	/** Maximum unquoted comma separators among parameter values on one line. */
	maxParameterValueDelimitersPerContentLine: number;
	/**
	 * Upper bound for parameter-scanner work (`parameters × line length`) in
	 * ical.js.  Its parameter parser repeatedly scans the remaining line.
	 */
	maxParameterWorkChars: number;
	/** Maximum comma/semicolon delimiters in one property value. */
	maxValueDelimitersPerContentLine: number;
	/** Maximum nested BEGIN/END component depth. */
	maxComponentDepth: number;
	/** Maximum BEGIN components, including VTIMEZONE children and VALARMs. */
	maxComponents: number;
	/** Maximum number of VEVENT components before grouping/expansion. */
	maxVevents: number;
	/** Maximum VTIMEZONE components in one untrusted feed. */
	maxVtimezones: number;
	/** Maximum STANDARD/DAYLIGHT observances in one VTIMEZONE. */
	maxTimezoneObservancesPerZone: number;
	/** Maximum explicit RDATE transition values in one timezone observance. */
	maxTimezoneRdateValuesPerObservance: number;
	/** Maximum possible RRULE transitions expanded for one timezone observance. */
	maxTimezoneRruleTransitionsPerObservance: number;
	/** Maximum iterator.next() calls for one recurring series. */
	maxIteratorStepsPerSeries: number;
	/** Wall-clock budget for parsing and expansion of one feed. */
	maxElapsedMs: number;
	/** Maximum emitted day rows from one series (or one non-recurring event). */
	maxSeriesRows: number;
	/** Maximum emitted day rows from the entire feed. */
	maxTotalRows: number;
}

/** Conservative production defaults: enough for normal work calendars, finite under hostile input. */
export const DEFAULT_ICS_PARSE_BUDGET: Readonly<IcsParseBudget> = {
	maxResponseBytes: 5 * 1024 * 1024,
	maxPhysicalLines: 60_000,
	maxUnfoldedLineChars: 64 * 1024,
	// Свёрнутые строки и работа развёртки должны пропускать ЛЮБОЕ свойство длиной
	// до maxUnfoldedLineChars — иначе они, а не заявленный потолок строки, молча
	// становятся настоящим лимитом. При фолдинге по 73–75 символов 64 КБ дают ~900
	// продолжений и ~29 млн скопированных символов по квадратичной оценке ниже.
	// Прежние 128/512 КБ обрезали ОДНО свойство на ~8.7 КБ: приглашение Outlook/Teams
	// с HTML-подвалом в DESCRIPTION (зеркалом не используемым!) навсегда роняло всю
	// подписку — пользователь видел только сырую английскую ошибку в настройках.
	maxFoldedLinesPerContentLine: 1_024,
	maxUnfoldingWorkChars: 32 * 1024 * 1024,
	maxParametersPerContentLine: 64,
	maxParameterValueDelimitersPerContentLine: 256,
	maxParameterWorkChars: 512 * 1024,
	maxValueDelimitersPerContentLine: 10_000,
	maxComponentDepth: 16,
	maxComponents: 12_000,
	maxVevents: 5_000,
	maxVtimezones: 16,
	maxTimezoneObservancesPerZone: 32,
	maxTimezoneRdateValuesPerObservance: 256,
	maxTimezoneRruleTransitionsPerObservance: 1_024,
	maxIteratorStepsPerSeries: 25_000,
	maxElapsedMs: 1_500,
	maxSeriesRows: 15_000,
	maxTotalRows: 30_000,
};

export interface ParseIcsOptions {
	/** Override individual limits in focused tests or a future caller with a stricter policy. */
	budget?: Partial<IcsParseBudget>;
	/** Injectable monotonic-enough clock used only for enforcing the elapsed-time budget. */
	nowMs?: () => number;
}

/** A visible, actionable failure instead of a partial/truncated mirror. */
export class IcsBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IcsBudgetError";
	}
}

/**
 * Превышен бюджет ОДНОЙ серии (шаги итератора / строки одной серии), а не ленты.
 * Такое роняло весь фид: одно экзотическое событие (например floating-серия
 * `FREQ=HOURLY` из 2020 года) уносило с собой и обычные встречи, и пользователь
 * видел «календарь перестал синхронизироваться». Серию пропускаем, остальные
 * разбираем; фатальны только общефидовые лимиты (maxTotalRows, maxElapsedMs,
 * размер, синтаксис).
 */
export class IcsSeriesBudgetError extends IcsBudgetError {
	constructor(message: string) {
		super(message);
		this.name = "IcsSeriesBudgetError";
	}
}

/** Одна строка файла-зеркала: одно вхождение на один календарный день. */
export interface MirrorOccurrence {
	/** UID события из ленты (идентичность серии/одиночного). */
	uid: string;
	/**
	 * Таймзоно-каноничная идентичность ЭТОГО вхождения внутри серии: строка
	 * RECURRENCE-ID (или DTSTART одиночного) в форме источника. Стабильна между
	 * устройствами и таймзонами — база детерминированного 🆔 (mirrorBuilder).
	 * У перенесённого через RECURRENCE-ID вхождения остаётся ИСХОДНАЯ дата — 🆔
	 * не «прыгает» при переносе занятия в источнике.
	 */
	recurrenceKey: string;
	/** Локальная календарная дата (YYYY-MM-DD), которую покрывает эта строка. */
	date: IsoDate;
	/** true — строка «Весь день» (без времени); false — со временем начала/конца. */
	allDay: boolean;
	/** "HH:mm" локального начала; null для all-day. */
	startTime: string | null;
	/** "HH:mm" локального конца — только если строго позже начала в тот же день; иначе null. */
	endTime: string | null;
	/** Название (SUMMARY); пустое допустимо. Эмодзи-поля вычищены (см. cleanText). */
	title: string;
	/** Место (LOCATION) или null. */
	location: string | null;
	/** 0-based индекс покрытого дня в многодневном вхождении; >0 только у многодневных. */
	dayIndex: number;
	/** Всего покрытых дней (1 у однодневного). Хвост-суффикс 🆔 для многодневных. */
	dayCount: number;
}

/** Границы окна развёртки (локальные Date) — вычисляет вызыватель (SyncService). */
export interface MirrorWindow {
	start: Date;
	end: Date;
}

/** Окно [сегодня−14д; сегодня+92д] от переданного «сейчас» (локальные полуночи). */
export function mirrorWindow(now: Date): MirrorWindow {
	const start = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate() - MIRROR_WINDOW_PAST_DAYS,
	);
	const end = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate() + MIRROR_WINDOW_FUTURE_DAYS,
	);
	return { start, end };
}

// ---------------------------------------------------------------------------
// Локальные утилиты дат (без obsidian; UTC-арифметика — устойчива к DST)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Локальная календарная дата JS-Date → "YYYY-MM-DD". */
function localIso(d: Date): IsoDate {
	return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Локальное время JS-Date → "HH:mm". */
function localHm(d: Date): string {
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Литеральные поля (y, 1-based m, d) → "YYYY-MM-DD" (для all-day, без таймзоны). */
function isoFromYmd(y: number, m: number, d: number): IsoDate {
	return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** UTC-миллисекунды полуночи ISO-даты (для арифметики дней без влияния DST). */
function utcMs(iso: IsoDate): number {
	return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function addDaysIso(iso: IsoDate, n: number): IsoDate {
	const d = new Date(utcMs(iso) + n * 86400000);
	return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Число дней между ISO-датами (b − a); ISO лексикографика == хронология. */
function daysBetween(a: IsoDate, b: IsoDate): number {
	return Math.round((utcMs(b) - utcMs(a)) / 86400000);
}

function resolvedBudget(overrides: Partial<IcsParseBudget> | undefined): IcsParseBudget {
	const value = <K extends keyof IcsParseBudget>(key: K): IcsParseBudget[K] => {
		const candidate = overrides?.[key];
		return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
			? Math.floor(candidate)
			: DEFAULT_ICS_PARSE_BUDGET[key];
	};
	return {
		maxResponseBytes: value("maxResponseBytes"),
		maxPhysicalLines: value("maxPhysicalLines"),
		maxUnfoldedLineChars: value("maxUnfoldedLineChars"),
		maxFoldedLinesPerContentLine: value("maxFoldedLinesPerContentLine"),
		maxUnfoldingWorkChars: value("maxUnfoldingWorkChars"),
		maxParametersPerContentLine: value("maxParametersPerContentLine"),
		maxParameterValueDelimitersPerContentLine: value(
			"maxParameterValueDelimitersPerContentLine",
		),
		maxParameterWorkChars: value("maxParameterWorkChars"),
		maxValueDelimitersPerContentLine: value("maxValueDelimitersPerContentLine"),
		maxComponentDepth: value("maxComponentDepth"),
		maxComponents: value("maxComponents"),
		maxVevents: value("maxVevents"),
		maxVtimezones: value("maxVtimezones"),
		maxTimezoneObservancesPerZone: value("maxTimezoneObservancesPerZone"),
		maxTimezoneRdateValuesPerObservance: value("maxTimezoneRdateValuesPerObservance"),
		maxTimezoneRruleTransitionsPerObservance: value("maxTimezoneRruleTransitionsPerObservance"),
		maxIteratorStepsPerSeries: value("maxIteratorStepsPerSeries"),
		maxElapsedMs: value("maxElapsedMs"),
		maxSeriesRows: value("maxSeriesRows"),
		maxTotalRows: value("maxTotalRows"),
	};
}

function utf8Bytes(text: string): number {
	// TextEncoder is available in Obsidian's Electron and Node.  The fallback is
	// conservative (every UTF-16 code unit may occupy at most two UTF-8 bytes).
	return typeof TextEncoder === "undefined"
		? text.length * 2
		: new TextEncoder().encode(text).byteLength;
}

function assertElapsedAt(budget: IcsParseBudget, startedAtMs: number, nowMs: () => number): void {
	if (nowMs() - startedAtMs > budget.maxElapsedMs) {
		throw new IcsBudgetError(`ICS exceeds the ${budget.maxElapsedMs}ms parsing time budget`);
	}
}

/** Only this much of a content line is needed to recognise BEGIN/END. */
const PREFLIGHT_PREFIX_CHARS = 128;

/**
 * Reject parser-hostile *syntax* before calling synchronous `ICAL.parse`.
 *
 * ical.js is intentionally synchronous and its public parser offers no
 * cancellation hook.  In particular, it repeatedly concatenates folded
 * lines and repeatedly scans parameter-heavy lines.  A deadline checked
 * after `ICAL.parse` therefore cannot protect the UI from those two shapes.
 *
 * This scanner is deliberately small, allocation-free (apart from a bounded
 * prefix), and linear in the already byte-capped source.  Its limits bound
 * every known multiplicative loop in ical.js before that library receives the
 * string.  It validates only resource shape, not calendar semantics; ical.js
 * remains the RFC-aware authority for valid input.
 */
function preflightIcs(
	source: string,
	budget: IcsParseBudget,
	startedAtMs: number,
	nowMs: () => number,
): void {
	let physicalLines = 0;
	let components = 0;
	let vevents = 0;
	let componentDepth = 0;
	let physicalLineHasContent = false;

	let logicalOpen = false;
	let logicalLength = 0;
	let foldedLines = 0;
	let unfoldingWork = 0;
	let parameterSeparators = 0;
	let parameterValueDelimiters = 0;
	let valueDelimiters = 0;
	let sawValueDelimiter = false;
	let quotedParameter = false;
	let prefix = "";

	const beginLogicalLine = () => {
		logicalOpen = true;
		logicalLength = 0;
		foldedLines = 0;
		unfoldingWork = 0;
		parameterSeparators = 0;
		parameterValueDelimiters = 0;
		valueDelimiters = 0;
		sawValueDelimiter = false;
		quotedParameter = false;
		prefix = "";
	};

	const finishLogicalLine = () => {
		if (!logicalOpen) return;
		if (parameterSeparators * logicalLength > budget.maxParameterWorkChars) {
			throw new IcsBudgetError(
				`ICS content line exceeds the ${budget.maxParameterWorkChars}-character parameter-work budget`,
			);
		}

		const componentLine = prefix.toLowerCase();
		if (componentLine.startsWith("begin:")) {
			components++;
			if (components > budget.maxComponents) {
				throw new IcsBudgetError(
					`ICS feed exceeds the ${budget.maxComponents}-component budget`,
				);
			}
			componentDepth++;
			if (componentDepth > budget.maxComponentDepth) {
				throw new IcsBudgetError(
					`ICS feed exceeds the ${budget.maxComponentDepth}-level component-depth budget`,
				);
			}
			if (componentLine === "begin:vevent") {
				vevents++;
				if (vevents > budget.maxVevents) {
					throw new IcsBudgetError(
						`ICS feed exceeds the ${budget.maxVevents}-VEVENT budget`,
					);
				}
			}
		} else if (componentLine.startsWith("end:")) {
			if (componentDepth === 0) {
				throw new IcsBudgetError(
					"ICS has an END component without a matching BEGIN component",
				);
			}
			componentDepth--;
		}
		logicalOpen = false;
	};

	const appendContentCharacter = (character: string) => {
		logicalLength++;
		if (logicalLength > budget.maxUnfoldedLineChars) {
			throw new IcsBudgetError(
				`ICS content line exceeds the ${budget.maxUnfoldedLineChars}-character unfolded-line budget`,
			);
		}
		if (prefix.length < PREFLIGHT_PREFIX_CHARS) prefix += character;

		if (!sawValueDelimiter) {
			if (character === '"') {
				quotedParameter = !quotedParameter;
			} else if (!quotedParameter && character === ":") {
				sawValueDelimiter = true;
			} else if (!quotedParameter && character === ",") {
				// ical.js parses known multi-value parameters such as
				// MEMBER="a","b" into arrays before it ever sees the property
				// value.  Those commas are outside the content-value branch below,
				// so cap them separately.  Quoted commas remain ordinary parameter
				// text, as required by RFC 5545.
				parameterValueDelimiters++;
				if (parameterValueDelimiters > budget.maxParameterValueDelimitersPerContentLine) {
					throw new IcsBudgetError(
						`ICS content line exceeds the ${budget.maxParameterValueDelimitersPerContentLine}-parameter-value budget`,
					);
				}
			} else if (!quotedParameter && character === "=") {
				parameterSeparators++;
				if (parameterSeparators > budget.maxParametersPerContentLine) {
					throw new IcsBudgetError(
						`ICS content line exceeds the ${budget.maxParametersPerContentLine}-parameter budget`,
					);
				}
			}
		} else if (character === "," || character === ";") {
			valueDelimiters++;
			if (valueDelimiters > budget.maxValueDelimitersPerContentLine) {
				throw new IcsBudgetError(
					`ICS content line exceeds the ${budget.maxValueDelimitersPerContentLine}-value-delimiter budget`,
				);
			}
		}
	};

	const finishPhysicalLine = () => {
		physicalLines++;
		if (physicalLines > budget.maxPhysicalLines) {
			throw new IcsBudgetError(
				`ICS feed exceeds the ${budget.maxPhysicalLines}-physical-line budget`,
			);
		}
		// A blank physical line terminates the preceding logical line.  A
		// non-continuation line is handled when its first character arrives.
		if (!physicalLineHasContent) finishLogicalLine();
		physicalLineHasContent = false;
	};

	for (let index = 0; index < source.length; index++) {
		// This also means the preflight itself is interruptible between small,
		// fixed chunks rather than only after a complete multi-megabyte line.
		if ((index & 0x1fff) === 0) assertElapsedAt(budget, startedAtMs, nowMs);
		const character = source.charAt(index);
		if (character === "\n") {
			finishPhysicalLine();
			continue;
		}
		// ICAL._eachLine strips CR only in CRLF input; mirror that behaviour.
		if (character === "\r" && source.charAt(index + 1) === "\n") continue;

		if (!physicalLineHasContent) {
			physicalLineHasContent = true;
			if (character === " " || character === "\t") {
				if (!logicalOpen) {
					throw new IcsBudgetError(
						"ICS starts a folded content line without a preceding content line",
					);
				}
				foldedLines++;
				if (foldedLines > budget.maxFoldedLinesPerContentLine) {
					throw new IcsBudgetError(
						`ICS content line exceeds the ${budget.maxFoldedLinesPerContentLine}-folded-line budget`,
					);
				}
				// ical.js does `line += physicalSlice` for every continuation.  The
				// accumulated-prefix sum is a conservative bound on that copy work:
				// it grows as L²/(2×foldWidth) in the content-line length L, while a
				// real engine concatenates ropes.  Keep the budget calibrated against
				// maxUnfoldedLineChars, not against a "typical" line — the per-line
				// character cap is the limit users can reason about.
				unfoldingWork += logicalLength;
				if (unfoldingWork > budget.maxUnfoldingWorkChars) {
					throw new IcsBudgetError(
						`ICS content line exceeds the ${budget.maxUnfoldingWorkChars}-character unfolding-work budget`,
					);
				}
				continue;
			}
			finishLogicalLine();
			beginLogicalLine();
		}
		appendContentCharacter(character);
	}

	if (physicalLineHasContent) finishPhysicalLine();
	finishLogicalLine();
	assertElapsedAt(budget, startedAtMs, nowMs);
}

interface ExpansionLimits {
	budget: IcsParseBudget;
	startedAtMs: number;
	nowMs: () => number;
	out: MirrorOccurrence[];
}

function assertElapsed(limits: ExpansionLimits): void {
	assertElapsedAt(limits.budget, limits.startedAtMs, limits.nowMs);
}

function reserveRow(limits: ExpansionLimits, seriesRows: number): void {
	assertElapsed(limits);
	if (seriesRows >= limits.budget.maxSeriesRows) {
		throw new IcsSeriesBudgetError(
			`ICS series exceeds the ${limits.budget.maxSeriesRows}-row output budget`,
		);
	}
	if (limits.out.length >= limits.budget.maxTotalRows) {
		throw new IcsBudgetError(
			`ICS feed exceeds the ${limits.budget.maxTotalRows}-row output budget`,
		);
	}
}

/**
 * Санитайз текста поля из ленты: убрать эмодзи-поля (иначе распарсились бы как
 * 📅/📍/🆔 в строке-зеркале и сломали бы формат), схлопнуть любые пробелы (вкл.
 * NBSP/переводы строк) в один и обрезать края. Пустая строка допустима.
 */
function cleanText(raw: string): string {
	let s = raw;
	for (const e of ALL_FIELD_EMOJI) if (s.includes(e)) s = s.split(e).join(" ");
	return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Развёртка
// ---------------------------------------------------------------------------

/** Минимальный структурный тип ICAL.Time, используемый развёрткой. */
type ICALTimeLike = InstanceType<typeof ICAL.Time>;

/**
 * Первый и последний ПОКРЫТЫЙ календарный день вхождения [start, end) и признак
 * all-day. DTEND в ICS — ИСКЛЮЧИТЕЛЬНЫЙ конец (у all-day — день ПОСЛЕ последнего).
 * Для all-day дни берутся из литеральных полей (таймзоно-независимо); для
 * временных — из локальных JS-дат (конвертация таймзоны уже произошла).
 */
function coveredSpan(
	start: ICALTimeLike,
	end: ICALTimeLike | null,
): {
	firstIso: IsoDate;
	lastIso: IsoDate;
	allDay: boolean;
} {
	if (start.isDate) {
		const firstIso = isoFromYmd(start.year, start.month, start.day);
		const endExclIso =
			end !== null && end.isDate
				? isoFromYmd(end.year, end.month, end.day)
				: addDaysIso(firstIso, 1);
		// исключительный конец → последний покрытый день = endExcl − 1; вырожденный/
		// отсутствующий конец → один день
		const lastIso = endExclIso <= firstIso ? firstIso : addDaysIso(endExclIso, -1);
		return { firstIso, lastIso, allDay: true };
	}
	const sj = start.toJSDate();
	const ej = end !== null ? end.toJSDate() : sj;
	const firstIso = localIso(sj);
	if (ej.getTime() <= sj.getTime()) return { firstIso, lastIso: firstIso, allDay: false };
	// исключительный конец: последний ЗАДЕТЫЙ день = день (конец − 1мс)
	const lastIso = localIso(new Date(ej.getTime() - 1));
	return { firstIso, lastIso: lastIso < firstIso ? firstIso : lastIso, allDay: false };
}

/**
 * Развернуть одно вхождение [start, end) в строки-зеркала по дням, СРАЗУ обрезая
 * по окну [startIso, endIso] (чтобы не аллоцировать тысячи внеоконных дней у
 * многолетних all-day событий). dayIndex/dayCount считаются от ИСТИННОГО первого
 * дня вхождения (стабильны независимо от окна) — суффикс дня в 🆔 не дрейфует.
 *
 * Многодневное ТАЙМИРОВАННОЕ вхождение (напр. ночное 23:00–01:00) раскладывается с
 * временем на крайних сутках: первый день `HH:mm–23:59`, последний `00:00–HH:mm`,
 * промежуточные — «Весь день». Многодневное all-day — «Весь день» по всем дням.
 *
 * Возвращает ЧИСЛО добавленных строк (для per-series output budget).
 */
function emitOccurrence(
	start: ICALTimeLike,
	end: ICALTimeLike | null,
	uid: string,
	recurrenceKey: string,
	summary: string,
	location: string,
	startIso: IsoDate,
	endIso: IsoDate,
	out: MirrorOccurrence[],
	limits: ExpansionLimits,
	seriesRowsBefore: number,
): number {
	const { firstIso, lastIso, allDay } = coveredSpan(start, end);
	const dayCount = daysBetween(firstIso, lastIso) + 1;
	const multi = dayCount > 1;
	const title = cleanText(summary);
	const loc = location === "" ? null : cleanText(location);
	const locOrNull = loc === "" ? null : loc;

	const emitFrom = firstIso < startIso ? startIso : firstIso;
	const emitTo = lastIso > endIso ? endIso : lastIso;
	if (emitFrom > emitTo) return 0; // вхождение целиком вне окна

	// Локальные времена начала/конца вхождения (null у all-day).
	const startHm = allDay ? null : localHm(start.toJSDate());
	const endHm = allDay || end === null ? null : localHm(end.toJSDate());

	let rows = 0;
	for (let d = emitFrom; d <= emitTo; d = addDaysIso(d, 1)) {
		reserveRow(limits, seriesRowsBefore + rows);
		let rowAllDay: boolean;
		let startTime: string | null;
		let endTime: string | null;
		if (allDay) {
			// all-day (в т.ч. многодневное all-day) — «Весь день» по каждому дню
			rowAllDay = true;
			startTime = null;
			endTime = null;
		} else if (!multi) {
			// однодневное таймированное — время начала + опц. конец (строго позже, тот же день)
			rowAllDay = false;
			startTime = startHm;
			endTime = endHm !== null && startHm !== null && endHm > startHm ? endHm : null;
		} else if (d === firstIso) {
			// первый день многодневного таймированного — со временем начала до конца суток.
			// (Если истинный первый день обрезан окном, сюда не попадём — это будут «промежуточные».)
			rowAllDay = false;
			startTime = startHm;
			endTime = startHm !== null && startHm < "23:59" ? "23:59" : null;
		} else if (d === lastIso) {
			// последний день многодневного таймированного — с полуночи до времени конца
			rowAllDay = false;
			startTime = "00:00";
			endTime = endHm !== null && endHm > "00:00" ? endHm : null;
		} else {
			// промежуточные сутки многодневного таймированного — «Весь день»
			rowAllDay = true;
			startTime = null;
			endTime = null;
		}
		out.push({
			uid,
			recurrenceKey,
			date: d,
			allDay: rowAllDay,
			startTime,
			endTime,
			title,
			location: locOrNull,
			dayIndex: daysBetween(firstIso, d),
			dayCount,
		});
		rows++;
	}
	return rows;
}

/** Строковое значение свойства компонента (SUMMARY/LOCATION), "" при отсутствии. */
function firstString(comp: InstanceType<typeof ICAL.Component>, name: string): string {
	const v = comp.getFirstPropertyValue(name);
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Компонент отменён (`STATUS:CANCELLED`). Именно так Google Calendar в «секретном
 * адресе iCal» отдаёт удалённую встречу и отменённое вхождение серии (отдельным
 * VEVENT с RECURRENCE-ID). Без проверки отменённая планёрка оставалась в
 * календаре, агенде и виджетах бессрочно — зеркало ведь только дополняется.
 */
function isCancelled(comp: InstanceType<typeof ICAL.Component>): boolean {
	return firstString(comp, "status").trim().toUpperCase() === "CANCELLED";
}

/** Значение getter'а ICAL.Event (summary/location) → строка, "" при отсутствии. */
function eventString(v: unknown): string {
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

type IcalRecurLike = {
	count?: number | null;
	freq?: string;
	until?: unknown | null;
	parts?: Record<string, unknown>;
};

function icalValueYear(value: unknown): number | null {
	if (value === null || typeof value !== "object" || !("year" in value)) return null;
	const year = (value as { year?: unknown }).year;
	return typeof year === "number" && Number.isFinite(year) ? year : null;
}

/**
 * Find the latest source year which could make ical.js expand a named zone.
 * This reads only parsed ICAL fields — it deliberately never calls toJSDate
 * or utcOffset, because either would expand VTIMEZONE RRULEs.
 */
function latestTimezoneReferenceYear(
	vevents: InstanceType<typeof ICAL.Component>[],
	tzid: string,
	fallbackYear: number,
): number {
	let latestYear = fallbackYear;
	for (const vevent of vevents) {
		for (const propertyName of ["dtstart", "dtend", "recurrence-id", "rdate", "exdate"]) {
			for (const property of vevent.getAllProperties(propertyName)) {
				if (property.getParameter("tzid") !== tzid) continue;
				for (const value of property.getValues()) {
					const year = icalValueYear(value);
					if (year !== null) latestYear = Math.max(latestYear, year);
				}
			}
		}
	}
	return latestYear;
}

/**
 * VTIMEZONE RRULEs are evaluated lazily by ical.js on the first timezone
 * conversion.  Its expansion is synchronous and has no cancellation hook,
 * so applying the normal VEVENT iterator budget afterwards is too late.  The
 * common RFC 5545 shape (one or two YEARLY STANDARD/DAYLIGHT rules plus a few
 * historical RDATEs) stays supported; unusual high-cardinality timezone
 * definitions fail closed before any offset calculation can happen.
 */
function validateVtimezones(
	vcal: InstanceType<typeof ICAL.Component>,
	vevents: InstanceType<typeof ICAL.Component>[],
	window: MirrorWindow,
	budget: IcsParseBudget,
): InstanceType<typeof ICAL.Component>[] {
	const vtimezones = vcal.getAllSubcomponents("vtimezone");
	if (vtimezones.length > budget.maxVtimezones) {
		throw new IcsBudgetError(`ICS feed exceeds the ${budget.maxVtimezones}-VTIMEZONE budget`);
	}

	const fallbackYear = Math.max(window.end.getFullYear(), new Date().getFullYear());
	for (const vtimezone of vtimezones) {
		const tzid = firstString(vtimezone, "tzid");
		// ical.js expands five extra years beyond the requested year.  Include
		// that margin in our estimate, including for an explicit far-future
		// DTSTART/RDATE, so an out-of-window event cannot trigger an unbounded
		// lazy expansion later.
		const referenceYear = latestTimezoneReferenceYear(vevents, tzid, fallbackYear) + 5;
		const observances = vtimezone
			.getAllSubcomponents()
			.filter((component) => component.name === "standard" || component.name === "daylight");
		if (observances.length > budget.maxTimezoneObservancesPerZone) {
			throw new IcsBudgetError(
				`ICS VTIMEZONE exceeds the ${budget.maxTimezoneObservancesPerZone}-observance budget`,
			);
		}

		for (const observance of observances) {
			let rdateValues = 0;
			for (const rdate of observance.getAllProperties("rdate")) {
				rdateValues += rdate.getValues().length;
				if (rdateValues > budget.maxTimezoneRdateValuesPerObservance) {
					throw new IcsBudgetError(
						`ICS VTIMEZONE exceeds the ${budget.maxTimezoneRdateValuesPerObservance}-RDATE budget`,
					);
				}
			}

			const rrules = observance.getAllProperties("rrule");
			if (rrules.length > 1) {
				throw new IcsBudgetError("ICS VTIMEZONE has more than one RRULE in one observance");
			}
			if (rrules.length === 0) continue;

			const rule = rrules[0]!.getFirstValue() as IcalRecurLike | null;
			if (rule === null || rule.freq !== "YEARLY") {
				throw new IcsBudgetError("ICS VTIMEZONE RRULE must use FREQ=YEARLY");
			}
			const startYear = icalValueYear(observance.getFirstPropertyValue("dtstart"));
			if (startYear === null) {
				throw new IcsBudgetError("ICS VTIMEZONE RRULE has no valid DTSTART");
			}

			let candidatesPerYear = 1;
			for (const values of Object.values(rule.parts ?? {})) {
				const count = Array.isArray(values) ? values.length : 1;
				candidatesPerYear *= count;
				if (candidatesPerYear > budget.maxTimezoneRruleTransitionsPerObservance) break;
			}
			const untilYear = icalValueYear(rule.until);
			const lastYear =
				untilYear === null ? referenceYear : Math.min(referenceYear, untilYear);
			const yearsToExpand = Math.max(0, lastYear - startYear + 1);
			const countLimit =
				typeof rule.count === "number" ? Math.max(0, Math.floor(rule.count)) : Infinity;
			const possibleTransitions = Math.min(candidatesPerYear * yearsToExpand, countLimit);
			if (possibleTransitions > budget.maxTimezoneRruleTransitionsPerObservance) {
				throw new IcsBudgetError(
					`ICS VTIMEZONE RRULE exceeds the ${budget.maxTimezoneRruleTransitionsPerObservance}-transition budget`,
				);
			}
		}
	}

	return vtimezones;
}

/**
 * Build a safe seed close to the mirror window for an unbounded RRULE.
 *
 * ICAL.Event.iterator(seed) still uses the event's EXDATE and related
 * RECURRENCE-ID components.  We only seed a simple fixed-period sub-day rule
 * at an *actual* recurrence instant.  Calendar rules (BYDAY/BYMONTH), finite
 * COUNT/UNTIL rules, and RDATE mixes retain normal iteration because their
 * historical state determines whether an occurrence exists.
 */
function recurrenceSeed(
	ev: InstanceType<typeof ICAL.Event>,
	windowStart: Date,
): ICALTimeLike | undefined {
	const rules = ev.component.getAllProperties("rrule");
	if (rules.length !== 1 || ev.component.hasProperty("rdate")) return undefined;
	const rule = rules[0]!.getFirstValue() as {
		count?: number | null;
		until?: unknown | null;
		freq?: string;
		interval?: number;
		parts?: Record<string, unknown>;
	} | null;
	if (
		rule === null ||
		rule.count != null ||
		rule.until != null ||
		ev.startDate.isDate ||
		// A JS epoch duration is an exact recurrence offset only for UTC.  Floating
		// schedules are wall-clock local time; named zones also change their offset
		// over DST.  Starting ical.js from an epoch-derived Time in either case can
		// skip/shift valid occurrences, so keep its canonical iterator path.
		ev.startDate.zone.tzid !== "UTC"
	)
		return undefined;
	if (rule.parts !== undefined && Object.keys(rule.parts).length > 0) return undefined;
	const unitMs =
		rule.freq === "SECONDLY"
			? 1000
			: rule.freq === "MINUTELY"
				? 60_000
				: rule.freq === "HOURLY"
					? 3_600_000
					: null;
	if (unitMs === null) return undefined;
	const periodMs = unitMs * Math.max(1, rule.interval ?? 1);
	const durationMs = Math.max(0, ev.duration.toSeconds() * 1000);
	const earliestMs = windowStart.getTime() - durationMs;
	const eventStartMs = ev.startDate.toJSDate().getTime();
	if (eventStartMs >= earliestMs) return undefined;
	const steps = Math.ceil((earliestMs - eventStartMs) / periodMs);
	const seedInstant = new Date(eventStartMs + steps * periodMs);
	return ICAL.Time.fromJSDate(seedInstant, true);
}

/** Развёртка повторяющейся серии через итератор ical.js (учитывает EXDATE/RDATE/
 *  RECURRENCE-ID-переопределения через relateException). */
function expandRecurring(
	ev: InstanceType<typeof ICAL.Event>,
	uid: string,
	startIso: IsoDate,
	endIso: IsoDate,
	windowStart: Date,
	windowEnd: Date,
	out: MirrorOccurrence[],
	limits: ExpansionLimits,
): void {
	const iterator = ev.iterator(recurrenceSeed(ev, windowStart));
	const windowEndMs = windowEnd.getTime();
	let next: ICALTimeLike | null;
	let emitted = 0;
	let steps = 0;
	while ((next = iterator.next())) {
		assertElapsed(limits);
		steps++;
		if (steps > limits.budget.maxIteratorStepsPerSeries) {
			throw new IcsSeriesBudgetError(
				`ICS series exceeds the ${limits.budget.maxIteratorStepsPerSeries}-step recurrence budget`,
			);
		}
		// вхождения идут по возрастанию начала: как только начало ушло за конец окна — стоп
		if (next.toJSDate().getTime() > windowEndMs) break;
		let det;
		try {
			det = ev.getOccurrenceDetails(next);
		} catch {
			continue; // битое переопределение — пропускаем вхождение, серию не роняем
		}
		// Отменённое ВХОЖДЕНИЕ приходит переопределением (RECURRENCE-ID +
		// STATUS:CANCELLED) — его компонент лежит в det.item.
		if (isCancelled(det.item.component)) continue;
		// Output cap is spent only by rows in the mirror window.  EXDATE and
		// RECURRENCE-ID are still resolved through ICAL.Event itself.
		emitted += emitOccurrence(
			det.startDate,
			det.endDate,
			uid,
			det.recurrenceId.toString(),
			// summary/location берём из переопределённого item (RECURRENCE-ID может их менять)
			eventString(det.item.summary),
			eventString(det.item.location),
			startIso,
			endIso,
			out,
			limits,
			emitted,
		);
	}
}

/** Синтетический UID для VEVENT без UID (битая лента) — из summary+dtstart. */
function synthUid(comp: InstanceType<typeof ICAL.Component>): string {
	return `synthetic:${firstString(comp, "summary")}:${firstString(comp, "dtstart")}`;
}

/**
 * Разобрать ICS-ленту и развернуть вхождения в окне. Бросает при неразбираемом
 * ICS (вызыватель ловит и пишет в статус подписки). Отдельные битые VEVENT/
 * серии пропускаются, не роняя разбор остальных.
 */
export function parseIcs(
	text: string,
	window: MirrorWindow,
	options: ParseIcsOptions = {},
): MirrorOccurrence[] {
	const budget = resolvedBudget(options.budget);
	const nowMs = options.nowMs ?? Date.now;
	const startedAtMs = nowMs();
	if (utf8Bytes(text) > budget.maxResponseBytes) {
		throw new IcsBudgetError(
			`ICS response exceeds the ${budget.maxResponseBytes}-byte size budget`,
		);
	}
	// Keep the same BOM normalization for the preflight and the RFC parser.  A
	// BOM is tolerated for real-world Outlook feeds but must not hide the first
	// BEGIN line from the structural limits.
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	preflightIcs(source, budget, startedAtMs, nowMs);
	let jcal: unknown;
	try {
		// Ведущий BOM (U+FEFF) валит ICAL.parse («BEGIN:VCALENDAR» не в начале) — снимаем.
		// UTF-8-ленты с BOM встречаются (Outlook и пр.); RFC 5545 его не запрещает.
		jcal = ICAL.parse(source);
	} catch {
		throw new Error("не удалось разобрать ICS (неверный формат ленты)");
	}
	const vcal = new ICAL.Component(jcal as ConstructorParameters<typeof ICAL.Component>[0]);
	const vevents = vcal.getAllSubcomponents("vevent");
	if (vevents.length > budget.maxVevents) {
		throw new IcsBudgetError(`ICS feed exceeds the ${budget.maxVevents}-VEVENT budget`);
	}
	// Do this before registering or converting any named zone.  ical.js expands
	// VTIMEZONE RRULEs lazily during the first offset lookup, where a deadline
	// cannot interrupt its synchronous iterator.
	const vtimezones = validateVtimezones(vcal, vevents, window, budget);
	const limits: ExpansionLimits = { budget, startedAtMs, nowMs, out: [] };
	assertElapsed(limits);

	// Регистрируем VTIMEZONE ленты в общий сервис — иначе зонированные времена не
	// сконвертируются (ical.js несёт только UTC). has() делает повтор идемпотентным.
	for (const vtz of vtimezones) {
		assertElapsed(limits);
		try {
			const tz = new ICAL.Timezone(vtz);
			if (tz.tzid !== "" && !ICAL.TimezoneService.has(tz.tzid))
				ICAL.TimezoneService.register(vtz);
		} catch {
			/* битый VTIMEZONE — пропускаем, зонированные времена лягут как UTC/floating */
		}
	}

	// Группировка VEVENT по UID: мастер (без RECURRENCE-ID) + переопределения.
	const groups = new Map<
		string,
		{
			master: InstanceType<typeof ICAL.Component> | null;
			exceptions: InstanceType<typeof ICAL.Component>[];
		}
	>();
	for (const ve of vevents) {
		assertElapsed(limits);
		const uidRaw = firstString(ve, "uid");
		const uid = uidRaw !== "" ? uidRaw : synthUid(ve);
		let g = groups.get(uid);
		if (g === undefined) {
			g = { master: null, exceptions: [] };
			groups.set(uid, g);
		}
		if (ve.hasProperty("recurrence-id")) {
			g.exceptions.push(ve);
		} else if (g.master === null) {
			g.master = ve;
		}
		// иначе — второй VEVENT с тем же UID и БЕЗ RECURRENCE-ID (дубль-мастер, битая
		// лента): ДРОП. Не разворачиваем его отдельным вхождением — одинаковые
		// UID+DTSTART дали бы коллизию детерминированного 🆔 в зеркале; и не кладём в
		// exceptions — туда идут только RECURRENCE-ID-переопределения (relateException
		// иначе получил бы компонент без recurrence-id). Минимально-честный выбор:
		// «второй мастер» теряется, корректные серии/переносы не затронуты.
	}

	const startIso = localIso(window.start);
	const endIso = localIso(window.end);
	const out = limits.out;

	for (const [uid, g] of groups) {
		assertElapsed(limits);
		// мастер есть → строим серию/одиночное с привязкой переопределений;
		// мастера нет (сироты-переопределения) → каждое как одиночное событие
		const primaries = g.master !== null ? [g.master] : g.exceptions;
		for (const masterComp of primaries) {
			let ev: InstanceType<typeof ICAL.Event>;
			try {
				ev = new ICAL.Event(masterComp);
			} catch {
				continue;
			}
			if (g.master !== null) {
				for (const ex of g.exceptions) {
					try {
						ev.relateException(ex);
					} catch {
						/* несвязуемое переопределение — игнор */
					}
				}
			}
			// Метка выхода для отката: строки ЭТОЙ серии, добавленные до срыва её
			// собственного бюджета, из зеркала снимаются — оборванная на середине
			// серия выглядела бы как «встречи вдруг закончились» и была бы хуже
			// честного пропуска.
			const rowsBeforeSeries = out.length;
			try {
				// Отменённый МАСТЕР гасит серию целиком (у одиночного — своё событие).
				if (isCancelled(masterComp)) continue;
				if (ev.isRecurring()) {
					expandRecurring(
						ev,
						uid,
						startIso,
						endIso,
						window.start,
						window.end,
						out,
						limits,
					);
				} else if (!isCancelled(masterComp)) {
					emitOccurrence(
						ev.startDate,
						ev.endDate,
						uid,
						ev.startDate.toString(),
						firstString(masterComp, "summary"),
						firstString(masterComp, "location"),
						startIso,
						endIso,
						out,
						limits,
						0,
					);
				}
			} catch (e) {
				// Бюджет ОДНОЙ серии — не повод терять весь календарь: серию
				// пропускаем целиком (с откатом её уже добавленных строк).
				// Общефидовые лимиты по-прежнему фатальны — частичное зеркало
				// хуже честной ошибки.
				if (e instanceof IcsSeriesBudgetError) {
					out.length = rowsBeforeSeries;
					continue;
				}
				if (e instanceof IcsBudgetError) throw e;
				/* одна серия/событие упала — остальные разбираем */
			}
		}
	}
	return out;
}
