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

/** Потолок ЭМИТНУТЫХ в окно строк одной серии — предохранитель от раздувания
 *  файла на суб-часовых RRULE (MINUTELY/SECONDLY). ВАЖНО: кап на ЧИСЛО строк-в-окне,
 *  а НЕ на шаги итератора. Серия из далёкого прошлого сперва «перематывается» к
 *  началу окна (внеоконные вхождения дают 0 строк и бюджет не тратят) и лишь затем
 *  расходует лимит. Прежний кап на ШАГИ упирался в предел ДО окна и терял вхождения
 *  (FREQ=HOURLY двухлетней давности → 0 строк). Перемотка конечна: итератор
 *  монотонен и серия либо доходит до окна, либо завершается (COUNT/UNTIL). */
const RECUR_EMIT_HARD_CAP = 15000;

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
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - MIRROR_WINDOW_PAST_DAYS);
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + MIRROR_WINDOW_FUTURE_DAYS);
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
function coveredSpan(start: ICALTimeLike, end: ICALTimeLike | null): {
	firstIso: IsoDate;
	lastIso: IsoDate;
	allDay: boolean;
} {
	if (start.isDate) {
		const firstIso = isoFromYmd(start.year, start.month, start.day);
		const endExclIso =
			end !== null && end.isDate ? isoFromYmd(end.year, end.month, end.day) : addDaysIso(firstIso, 1);
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
 * Возвращает ЧИСЛО добавленных строк (для кап-бюджета серии — см. RECUR_EMIT_HARD_CAP).
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

/** Значение getter'а ICAL.Event (summary/location) → строка, "" при отсутствии. */
function eventString(v: unknown): string {
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Развёртка повторяющейся серии через итератор ical.js (учитывает EXDATE/RDATE/
 *  RECURRENCE-ID-переопределения через relateException). */
function expandRecurring(
	ev: InstanceType<typeof ICAL.Event>,
	uid: string,
	startIso: IsoDate,
	endIso: IsoDate,
	windowEnd: Date,
	out: MirrorOccurrence[],
): void {
	const iterator = ev.iterator();
	const windowEndMs = windowEnd.getTime();
	let next: ICALTimeLike | null;
	let emitted = 0;
	while ((next = iterator.next())) {
		// вхождения идут по возрастанию начала: как только начало ушло за конец окна — стоп
		if (next.toJSDate().getTime() > windowEndMs) break;
		let det;
		try {
			det = ev.getOccurrenceDetails(next);
		} catch {
			continue; // битое переопределение — пропускаем вхождение, серию не роняем
		}
		// Кап — на ЧИСЛО ЭМИТНУТЫХ строк, НЕ на шаги: внеоконные вхождения (перемотка
		// от DTSTART к окну) дают 0 строк и лимит не тратят (см. RECUR_EMIT_HARD_CAP).
		// EXDATE и RECURRENCE-ID-переносы учитываются штатно (getOccurrenceDetails на
		// дефолтном итераторе от DTSTART); сеид итератора у окна их бы сломал.
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
		);
		if (emitted > RECUR_EMIT_HARD_CAP) break;
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
export function parseIcs(text: string, window: MirrorWindow): MirrorOccurrence[] {
	let jcal: unknown;
	try {
		// Ведущий BOM (U+FEFF) валит ICAL.parse («BEGIN:VCALENDAR» не в начале) — снимаем.
		// UTF-8-ленты с BOM встречаются (Outlook и пр.); RFC 5545 его не запрещает.
		jcal = ICAL.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch {
		throw new Error("не удалось разобрать ICS (неверный формат ленты)");
	}
	const vcal = new ICAL.Component(jcal as ConstructorParameters<typeof ICAL.Component>[0]);

	// Регистрируем VTIMEZONE ленты в общий сервис — иначе зонированные времена не
	// сконвертируются (ical.js несёт только UTC). has() делает повтор идемпотентным.
	for (const vtz of vcal.getAllSubcomponents("vtimezone")) {
		try {
			const tz = new ICAL.Timezone(vtz);
			if (tz.tzid !== "" && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(vtz);
		} catch {
			/* битый VTIMEZONE — пропускаем, зонированные времена лягут как UTC/floating */
		}
	}

	// Группировка VEVENT по UID: мастер (без RECURRENCE-ID) + переопределения.
	const groups = new Map<string, { master: InstanceType<typeof ICAL.Component> | null; exceptions: InstanceType<typeof ICAL.Component>[] }>();
	for (const ve of vcal.getAllSubcomponents("vevent")) {
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
	const out: MirrorOccurrence[] = [];

	for (const [uid, g] of groups) {
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
			try {
				if (ev.isRecurring()) {
					expandRecurring(ev, uid, startIso, endIso, window.end, out);
				} else {
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
					);
				}
			} catch {
				/* одна серия/событие упала — остальные разбираем */
			}
		}
	}
	return out;
}
