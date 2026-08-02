/**
 * nlDate — распознавание русских дат/времени в быстром вводе (ТЗ: NLP-ввод дат).
 *
 * ЧИСТОЕ ядро: ноль импортов obsidian/node, ноль Date.now/Intl — «сегодня»
 * приходит параметром `today` (IsoDate). Арифметика дат детерминирована
 * (Date.UTC/getUTC*, как в src/views/common/dates.ts — таймзоны и DST ни при чём),
 * поэтому модуль безопасно входит и в widget-бандл (QuickJS).
 *
 * parseNlDate(text, today) → { title, date, time } | null:
 *  • null — в тексте НЕ найдено ни датного/временного выражения, ни escape-кавычек:
 *    текст не меняется (вызывающий пишет как есть);
 *  • { title, date: IsoDate, time }  — распознано выражение; title — текст без него
 *    (лишние пробелы схлопнуты); time — 'HH:mm' | 'HH:mm-HH:mm' | null;
 *  • { title, date: null, time: null } — сработал ТОЛЬКО escape: пользователь взял
 *    датное слово в кавычки («"завтра"»), кавычки сняты, дата НЕ распознана.
 *
 * Грамматика (регистронезависимо, по целым словам) — см. README «Быстрый ввод
 * понимает даты». КОНСЕРВАТИВНОСТЬ: выражение распознаётся только в НАЧАЛЕ или
 * КОНЦЕ текста (в середине «спланировать завтра поездку» не трогаем); голое число
 * («15») датой не считается — нужен разделитель («15.08») или месяц («15 августа»),
 * а у формы без года месяц пишется двумя цифрами, иначе «обновить до 1.2» и
 * «купить сахара 2.5» съедали бы число как дату (см. matchDmy);
 * если после вырезания title пуст — возвращаем null (не съедаем весь текст).
 */
import type { IsoDate } from "../model/Task";

export interface NlDateResult {
	/** Текст без распознанного выражения (и без escape-кавычек), пробелы схлопнуты. */
	title: string;
	/** Распознанная дата (📅), либо null — если сработал только escape-путь. */
	date: IsoDate | null;
	/** 'HH:mm' | 'HH:mm-HH:mm' | null — время/интервал (только при date !== null). */
	time: string | null;
}

// ---------------------------------------------------------------------------
// Арифметика дат (детерминированная, без Date.now)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function isLeap(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
	if (m === 2) return isLeap(y) ? 29 : 28;
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** IsoDate из компонент (компоненты предполагаются валидными). */
function fmtIso(y: number, m: number, d: number): IsoDate {
	return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Разобрать IsoDate в [y, m, d]; невалидная форма → null. */
function parseIso(iso: string): [number, number, number] | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (m === null) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** today + n дней (n может быть отрицательным). Через Date.UTC — без таймзон/DST. */
function addDays(iso: IsoDate, n: number): IsoDate {
	const p = parseIso(iso);
	if (p === null) return iso;
	const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
	return fmtIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** День недели 0=вс … 6=сб (как dayOfWeekSun0). */
function weekdaySun0(iso: IsoDate): number {
	const p = parseIso(iso);
	if (p === null) return 0;
	return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

// ---------------------------------------------------------------------------
// Словари грамматики
// ---------------------------------------------------------------------------

/** Относительные слова → офсет в днях от today. */
const RELATIVE_DAYS: Record<string, number> = {
	позавчера: -2,
	вчера: -1,
	сегодня: 0,
	завтра: 1,
	послезавтра: 2,
};

/** День недели (именительный/винительный/аббревиатура) → dow 0=вс … 6=сб. */
const WEEKDAYS: Record<string, number> = {
	воскресенье: 0,
	вс: 0,
	понедельник: 1,
	пн: 1,
	вторник: 2,
	вт: 2,
	среда: 3,
	среду: 3,
	ср: 3,
	четверг: 4,
	чт: 4,
	пятница: 5,
	пятницу: 5,
	пт: 5,
	суббота: 6,
	субботу: 6,
	сб: 6,
};

/** Месяц (именительный/родительный) → номер 1..12. */
const MONTHS: Record<string, number> = {
	январь: 1,
	января: 1,
	февраль: 2,
	февраля: 2,
	март: 3,
	марта: 3,
	апрель: 4,
	апреля: 4,
	май: 5,
	мая: 5,
	июнь: 6,
	июня: 6,
	июль: 7,
	июля: 7,
	август: 8,
	августа: 8,
	сентябрь: 9,
	сентября: 9,
	октябрь: 10,
	октября: 10,
	ноябрь: 11,
	ноября: 11,
	декабрь: 12,
	декабря: 12,
};

/** Части суток для 12-часовой формы «в 9 вечера». */
const AM_PERIODS = new Set(["утра", "ночи"]);
const PM_PERIODS = new Set(["дня", "вечера"]);
const PERIODS = new Set([...AM_PERIODS, ...PM_PERIODS]);

const PREP_IN = new Set(["в", "во"]);
const NEXT_MOD = new Set(["следующий", "следующую", "следующее", "следующего"]);
const DAY_UNITS = new Set(["день", "дня", "дней"]);
const WEEK_UNITS = new Set(["неделю", "недели", "недель", "неделя"]);

/** Слова/токены, которые датное выражение вообще МОЖЕТ содержать — для escape:
 *  кавычки снимаем только вокруг «датных» слов, обычный `"молоко"` не трогаем. */
function looksDateish(word: string): boolean {
	if (word === "") return false;
	if (word in RELATIVE_DAYS || word in WEEKDAYS || word in MONTHS) return true;
	if (PERIODS.has(word) || DAY_UNITS.has(word) || WEEK_UNITS.has(word)) return true;
	if (word === "через") return true;
	if (NEXT_MOD.has(word)) return true;
	return matchDmy(word) !== null; // 15.08 / 15.08.2026
}

// ---------------------------------------------------------------------------
// Токенизация ввода
// ---------------------------------------------------------------------------

const DMY_RE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/;

/**
 * «DD.MM[.ГГГГ]» с одной оговоркой: в форме БЕЗ года месяц обязан быть записан
 * двумя цифрами («15.08», «5.08»). Иначе любое «N.M» на краю текста — десятичная
 * дробь («купить сахара 2.5»), номер версии («обновить до 1.2»), пункт главы
 * («прочитать главу 3.4»), сумма счёта («оплатить счёт 12.5») — считалось датой,
 * и число ВЫРЕЗАЛОСЬ из названия: тихая потеря набранного текста, да ещё и с
 * уездом даты в следующий год (nearestFutureDate). Год двусмысленность снимает
 * сам («1.2.2026»), поэтому полной формы ограничение не касается. Тот же дух, что
 * у правила «голое число без разделителя (15) датой не считается».
 */
function matchDmy(word: string): { day: number; month: number; year: number | null } | null {
	const m = DMY_RE.exec(word);
	if (m === null) return null;
	const year = m[3] === undefined ? null : Number(m[3]);
	if (year === null && m[2]!.length < 2) return null;
	return { day: Number(m[1]), month: Number(m[2]), year };
}

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
const NUM_RE = /^\d{1,4}$/;
/** Обёрточная пунктуация, снимаемая по краям токена ТОЛЬКО для сопоставления. */
const WRAP_CHARS = `«»"'()[].,;:!?…`;

interface Tok {
	/** Оригинальная подстрока (для восстановления title). */
	raw: string;
	/** Что показывать в title (для escape-токенов — без снятых кавычек). */
	display: string;
	/** Ключ для сопоставления (lowercase, без обёрточной пунктуации); '' у literal. */
	match: string;
	/** escape-токен: в кавычках вокруг датного слова — датой НЕ считается. */
	literal: boolean;
}

/** Снять по краям обёрточную пунктуацию/кавычки (для сопоставления, не для title). */
function stripWrap(s: string): string {
	let a = 0;
	let b = s.length;
	while (a < b && WRAP_CHARS.includes(s[a]!)) a++;
	while (b > a && WRAP_CHARS.includes(s[b - 1]!)) b--;
	return s.slice(a, b);
}

/** Открывающая/закрывающая кавычка (straight " и ёлочки «»; ' не считаем — апостроф). */
function opensQuote(raw: string): boolean {
	return raw.startsWith('"') || raw.startsWith("«");
}
function closesQuote(raw: string): boolean {
	return raw.endsWith('"') || raw.endsWith("»");
}
/** Снять ровно одну пару обрамляющих кавычек, если они есть. */
function unquote(raw: string): string {
	let s = raw;
	if (s.startsWith('"') || s.startsWith("«")) s = s.slice(1);
	if (s.endsWith('"') || s.endsWith("»")) s = s.slice(0, -1);
	return s;
}

/**
 * Разбить текст на токены по пробелам и разметить escape-кавычки. Кавычная группа
 * (одно- или многотокенная: `"завтра"` либо `"через неделю"`), СОДЕРЖАЩАЯ датное
 * слово, помечается literal (её слова не парсятся как дата), а кавычки снимаются в
 * display. Кавычки вокруг НЕдатного текста (`"молоко"`) остаются нетронутыми.
 */
function tokenize(text: string): { toks: Tok[]; hadEscape: boolean } {
	const rawToks = text.split(/\s+/).filter((s) => s !== "");
	const toks: Tok[] = rawToks.map((raw) => ({
		raw,
		display: raw,
		match: stripWrap(raw).toLowerCase(),
		literal: false,
	}));
	let hadEscape = false;

	// Найти кавычные группы и, если внутри есть датное слово, снять кавычки + literal.
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!;
		if (!opensQuote(t.raw)) continue;
		// одно-токенная группа `"слово"`
		const single = closesQuote(t.raw) && t.raw.length >= 2;
		let end = i;
		if (!single) {
			// многотокенная: ищем токен, закрывающий кавычку
			let j = i + 1;
			while (j < toks.length && !closesQuote(toks[j]!.raw)) j++;
			if (j >= toks.length) continue; // незакрытая кавычка — не escape
			end = j;
		}
		// датное ли хоть одно слово внутри группы (по unquoted-ядру)?
		let dateish = false;
		for (let k = i; k <= end; k++) {
			if (looksDateish(stripWrap(unquote(toks[k]!.raw)).toLowerCase())) {
				dateish = true;
				break;
			}
		}
		if (!dateish) {
			i = end; // обычные кавычки — оставляем как есть
			continue;
		}
		for (let k = i; k <= end; k++) {
			const tk = toks[k]!;
			tk.display = unquote(tk.raw);
			tk.match = "";
			tk.literal = true;
		}
		hadEscape = true;
		i = end;
	}
	return { toks, hadEscape };
}

// ---------------------------------------------------------------------------
// Разбор числовых форм времени/даты
// ---------------------------------------------------------------------------

/** 'HH:mm' → {h,m}; 'HH' → {h,m:0}; иначе null (валидация 0–23 / 0–59). */
function parseHourSpec(word: string): { h: number; m: number; hadMinutes: boolean } | null {
	const hm = HHMM_RE.exec(word);
	if (hm !== null) {
		const h = Number(hm[1]);
		const m = Number(hm[2]);
		if (h > 23 || m > 59) return null;
		return { h, m, hadMinutes: true };
	}
	if (/^\d{1,2}$/.test(word)) {
		const h = Number(word);
		if (h > 23) return null;
		return { h, m: 0, hadMinutes: false };
	}
	return null;
}

function hhmm(h: number, m: number): string {
	return `${pad2(h)}:${pad2(m)}`;
}

/** Ближайшая будущая дата (день/месяц), год по умолчанию → эта/следующие годы. */
function nearestFutureDate(day: number, month: number, today: IsoDate): IsoDate | null {
	const p = parseIso(today);
	if (p === null) return null;
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	// поиск подходящего года: с текущего вперёд (учёт 29.02 в невисокосный год)
	for (let y = p[0]; y <= p[0] + 8; y++) {
		if (day > daysInMonth(y, month)) continue;
		const cand = fmtIso(y, month, day);
		if (cand >= today) return cand; // лексикографика IsoDate == хронология
	}
	return null;
}

// ---------------------------------------------------------------------------
// Сопоставители даты и времени (работают на срезе токенов)
// ---------------------------------------------------------------------------

interface DateMatch {
	end: number;
	date: IsoDate;
}
interface TimeMatch {
	end: number;
	time: string;
}

/** Датное выражение, начинающееся с токена i. Возвращает конец + дату, либо null. */
function matchDate(toks: Tok[], i: number, today: IsoDate): DateMatch | null {
	const t0 = toks[i];
	if (t0 === undefined || t0.literal) return null;
	const w0 = t0.match;

	// относительные: сегодня/завтра/послезавтра/вчера/позавчера
	if (w0 in RELATIVE_DAYS) {
		return { end: i + 1, date: addDays(today, RELATIVE_DAYS[w0]!) };
	}

	// «через N дней/недель» и «через неделю/день»
	if (w0 === "через") {
		const t1 = toks[i + 1];
		if (t1 !== undefined && !t1.literal) {
			if (NUM_RE.test(t1.match)) {
				const n = Number(t1.match);
				const t2 = toks[i + 2];
				if (t2 !== undefined && !t2.literal && n > 0) {
					if (DAY_UNITS.has(t2.match)) return { end: i + 3, date: addDays(today, n) };
					if (WEEK_UNITS.has(t2.match))
						return { end: i + 3, date: addDays(today, 7 * n) };
				}
			} else if (WEEK_UNITS.has(t1.match)) {
				return { end: i + 2, date: addDays(today, 7) };
			} else if (DAY_UNITS.has(t1.match)) {
				return { end: i + 2, date: addDays(today, 1) };
			}
		}
		return null;
	}

	// «в[о] [следующий] <день недели>»
	if (PREP_IN.has(w0)) {
		let j = i + 1;
		let next = false;
		const tj = toks[j];
		if (tj !== undefined && !tj.literal && NEXT_MOD.has(tj.match)) {
			next = true;
			j++;
		}
		const tw = toks[j];
		if (tw !== undefined && !tw.literal && tw.match in WEEKDAYS) {
			const target = WEEKDAYS[tw.match]!;
			const cur = weekdaySun0(today);
			let delta = (target - cur + 7) % 7;
			if (delta === 0) delta = 7; // ближайший БУДУЩИЙ (сегодня → следующая неделя)
			if (next) delta += 7; // «в следующий …» = +7 к ближайшему
			return { end: j + 1, date: addDays(today, delta) };
		}
		return null;
	}

	// «DD месяц» (15 августа)
	if (NUM_RE.test(w0)) {
		const day = Number(w0);
		const t1 = toks[i + 1];
		if (t1 !== undefined && !t1.literal && t1.match in MONTHS) {
			const date = nearestFutureDate(day, MONTHS[t1.match]!, today);
			if (date !== null) return { end: i + 2, date };
		}
		return null;
	}

	// «DD.MM[.YYYY]» (15.08 / 15.08.2026); «1.2»/«3.4»/«12.5» — не дата (см. matchDmy)
	const dmy = matchDmy(w0);
	if (dmy !== null) {
		const { day, month, year } = dmy;
		if (year !== null) {
			if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) {
				return { end: i + 1, date: fmtIso(year, month, day) };
			}
			return null;
		}
		const date = nearestFutureDate(day, month, today);
		if (date !== null) return { end: i + 1, date };
	}

	return null;
}

/** Временное выражение, начинающееся с токена i. Возвращает конец + время, либо null. */
function matchTime(toks: Tok[], i: number): TimeMatch | null {
	const t0 = toks[i];
	if (t0 === undefined || t0.literal) return null;
	const w0 = t0.match;

	// «в 15» / «в 15:30» / «в 9 утра»
	if (PREP_IN.has(w0)) {
		const t1 = toks[i + 1];
		if (t1 === undefined || t1.literal) return null;
		const hs = parseHourSpec(t1.match);
		if (hs === null) return null;
		// часть суток только для голого часа без минут
		if (!hs.hadMinutes) {
			const t2 = toks[i + 2];
			if (t2 !== undefined && !t2.literal && PERIODS.has(t2.match)) {
				let h = hs.h;
				if (AM_PERIODS.has(t2.match)) {
					// «12 ночи» → полночь; «12 утра» → полдень. Коллоквиальная русская
					// семантика: «в 12 утра» подразумевает середину дня, а не 00:00
					// (астрономически спорно, но так говорят). Прочие часы — как есть.
					if (h === 12) h = t2.match === "ночи" ? 0 : 12;
				} else {
					// PM (дня/вечера): 1–11 → +12; «12 дня» — уже полдень (12), не трогаем
					h = h >= 1 && h <= 11 ? h + 12 : h;
				}
				if (h > 23) return null;
				return { end: i + 3, time: hhmm(h, 0) };
			}
		}
		return { end: i + 2, time: hhmm(hs.h, hs.m) };
	}

	// «с 14 до 16» / «с 14:30 до 16:00»
	if (w0 === "с") {
		const t1 = toks[i + 1];
		const t2 = toks[i + 2];
		const t3 = toks[i + 3];
		if (
			t1 === undefined ||
			t1.literal ||
			t2 === undefined ||
			t2.literal ||
			t2.match !== "до" ||
			t3 === undefined ||
			t3.literal
		) {
			return null;
		}
		const a = parseHourSpec(t1.match);
		const b = parseHourSpec(t3.match);
		if (a === null || b === null) return null;
		const start = hhmm(a.h, a.m);
		const end = hhmm(b.h, b.m);
		if (end <= start) return null; // конец строго позже начала (иначе не диапазон)
		return { end: i + 4, time: `${start}-${end}` };
	}

	return null;
}

/**
 * Полное выражение с токена `start`: [дата] [время] | дата | время (соло).
 * Соло-время (без даты) → дата = today (сравнить с текущим временем нельзя —
 * сигнатура чистая, `nowMinutes` не приходит; «сегодня» — детерминированный выбор).
 */
function matchExpr(
	toks: Tok[],
	start: number,
	today: IsoDate,
): { end: number; date: IsoDate; time: string | null } | null {
	const d = matchDate(toks, start, today);
	if (d !== null) {
		const t = matchTime(toks, d.end);
		return t !== null
			? { end: t.end, date: d.date, time: t.time }
			: { end: d.end, date: d.date, time: null };
	}
	const t = matchTime(toks, start);
	if (t !== null) return { end: t.end, date: today, time: t.time };
	return null;
}

// ---------------------------------------------------------------------------
// Сборка title
// ---------------------------------------------------------------------------

/** Склеить display-токены [from, to) в title (пробелы схлопнуты, trim). */
function joinTitle(toks: Tok[], from: number, to: number): string {
	const parts: string[] = [];
	for (let k = from; k < to; k++) parts.push(toks[k]!.display);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Весь текст как title (display-токены), с уже снятыми escape-кавычками. */
function fullTitle(toks: Tok[]): string {
	return joinTitle(toks, 0, toks.length);
}

// ---------------------------------------------------------------------------
// Публичная точка входа
// ---------------------------------------------------------------------------

export function parseNlDate(text: string, today: IsoDate): NlDateResult | null {
	if (typeof text !== "string" || parseIso(today) === null) return null;
	const { toks, hadEscape } = tokenize(text);
	if (toks.length === 0) return null;

	// НАЧАЛО: выражение с токена 0, если после него остаётся непустой title.
	const atStart = matchExpr(toks, 0, today);
	// Выражение покрыло ВЕСЬ ввод (нет описания задачи) → null сразу: «завтра в 15»
	// без текста не должно давать title «завтра»/дату «сегодня» через хвостовой разбор
	// (см. ниже). Ровно как «в 15» без описания уже возвращает null.
	if (atStart !== null && atStart.end === toks.length) return null;
	if (atStart !== null && atStart.end < toks.length) {
		const title = joinTitle(toks, atStart.end, toks.length);
		if (title !== "") return { title, date: atStart.date, time: atStart.time };
	}

	// КОНЕЦ: самое длинное выражение-суффикс (наименьший j), title = префикс [0, j).
	for (let j = 1; j < toks.length; j++) {
		const r = matchExpr(toks, j, today);
		if (r !== null && r.end === toks.length) {
			const title = joinTitle(toks, 0, j);
			if (title !== "") return { title, date: r.date, time: r.time };
			break; // title пуст — весь текст съедать нельзя
		}
	}

	// Только escape (кавычки сняты, дата не распознана) → title без кавычек, date null.
	if (hadEscape) {
		const title = fullTitle(toks);
		if (title !== "") return { title, date: null, time: null };
	}

	return null;
}
