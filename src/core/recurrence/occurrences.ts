/**
 * Разворот повторяющегося правила в конкретные даты вхождений внутри диапазона
 * (ТЗ §события). Чистая функция поверх nextOccurrence — та же date-семантика
 * (клампинг, until включительно), никакого состояния/курсора. Единственный
 * потребитель — рендер виртуальных вхождений событий в календаре.
 */
import type { IsoDate } from "../model/Task";
import { addDays, compare } from "./dateMath";
import type { Rule } from "./grammar";
import { nextOccurrence, snapWeekAnchor } from "./nextOccurrence";

/** Предохранитель от неограниченного разворота (широкий диапазон / плотное правило). */
export const DEFAULT_OCCURRENCE_CAP = 500;

/**
 * Фолбэк-якорь фазы для интервальных правил с n>1 БЕЗ собственного якоря
 * (ни rule.from, ни базовой даты серии): weekly с byDay (чётность недель),
 * daily и weekly без byDay (фаза шага в днях). Разворот вхождений — вид: фаза
 * ОБЯЗАНА быть стабильной (не зависеть от начала видимого диапазона),
 * иначе серия «прыгала» бы при листании календаря и выглядела
 * ежедневной/еженедельной. Привязываемся к фиксированному понедельнику эпохи —
 * фаза глобально детерминирована и задокументирована (конкретный день произволен;
 * новые серии из UI получают явный 'from', см. eventSeries.withSeriesAnchor).
 */
const WEEK_PARITY_EPOCH: IsoDate = "1970-01-05"; // понедельник

/** Эффективный якорь для разворота: явный from/base серии, иначе — для
 *  интервальных правил с n>1 (weekly с byDay, daily, weekly без byDay)
 *  стабильный эпоха-фолбэк (не даёт фазе зависеть от диапазона).
 *  Итог для weekly с byDay проходит через ту же нормализацию фазы, что и ядро
 *  (snapWeekAnchor): якорь → неделя первого вхождения. Для эпоха-фолбэка снап
 *  внутри той же недели (понедельник → первый день byDay) фазу не меняет —
 *  нормализация здесь ради единообразия с nextOccurrence/isOccurrence. */
function effectiveAnchor(rule: Rule, anchor: IsoDate | undefined): IsoDate | undefined {
	let anc: IsoDate | undefined;
	if (rule.from !== undefined) anc = rule.from;
	else if (anchor !== undefined) anc = anchor;
	else if ((rule.freq === "weekly" || rule.freq === "daily") && rule.n > 1) {
		// daily n>1 и weekly n>1 (с byDay и без): без якоря фаза зависела бы от
		// fromIso−1 — тот же эпоха-фолбэк держит её детерминированной
		anc = WEEK_PARITY_EPOCH;
	} else return undefined;
	if (rule.freq === "weekly" && rule.byDay.length > 0) return snapWeekAnchor(anc, rule.byDay);
	return anc;
}

/**
 * Все даты вхождений правила в [fromIso, toIso] включительно, по возрастанию.
 *
 * Стартуем от fromIso−1 и идём nextOccurrence (строго «после») — первая дата
 * попадает ровно на fromIso, если она вхождение. until обрабатывается самим
 * nextOccurrence (за границей — null). cap ограничивает длину результата:
 * достигнув потолка, обрываемся (диапазон видимого календаря заведомо мал,
 * потолок — защита от вырожденных вызовов).
 *
 * eventTime/eventTimeEnd правила на разворот НЕ влияют — это date-уровень;
 * время вхождения читается из самого rule на стороне рендера.
 *
 * exclude — даты-исключения серии (🚫): вхождение на такой дате пропускается
 * (перенос/отмена одного занятия). Исключённые в потолок cap не засчитываются,
 * но верхняя граница toIso завершает разворот в любом случае.
 *
 * anchor — базовая дата серии для чётности недель weekly-правил с n>1 (если у
 * серии она есть). Приоритет: rule.from → anchor → стабильный эпоха-фолбэк
 * (effectiveAnchor); фаза недель детерминирована и не зависит от fromIso.
 */
export function expandOccurrences(
	rule: Rule,
	fromIso: IsoDate,
	toIso: IsoDate,
	cap: number = DEFAULT_OCCURRENCE_CAP,
	exclude?: ReadonlySet<IsoDate>,
	anchor?: IsoDate,
): IsoDate[] {
	const out: IsoDate[] = [];
	if (compare(fromIso, toIso) > 0 || cap <= 0) return out;
	// Правила «от выполнения» (§every!) по календарю не разворачиваются: серии
	// событий с every! запрещены, а если такое правило попало в файл руками —
	// отдаём пусто (nextOccurrence для него и так вернул бы null, здесь — явно и
	// без работы effectiveAnchor).
	if (rule.fromCompletion) return out;
	const anc = effectiveAnchor(rule, anchor);
	let cur = nextOccurrence(rule, addDays(fromIso, -1), anc); // первое вхождение ≥ fromIso
	while (cur !== null && compare(cur, toIso) <= 0 && out.length < cap) {
		if (exclude === undefined || !exclude.has(cur)) out.push(cur);
		cur = nextOccurrence(rule, cur, anc);
	}
	return out;
}
