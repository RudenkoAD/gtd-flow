/**
 * Разворот повторяющегося правила в конкретные даты вхождений внутри диапазона
 * (ТЗ §события). Чистая функция поверх nextOccurrence — та же date-семантика
 * (клампинг, until включительно), никакого состояния/курсора. Единственный
 * потребитель — рендер виртуальных вхождений событий в календаре.
 */
import type { IsoDate } from "../model/Task";
import { addDays, compare } from "./dateMath";
import type { Rule } from "./grammar";
import { nextOccurrence } from "./nextOccurrence";

/** Предохранитель от неограниченного разворота (широкий диапазон / плотное правило). */
export const DEFAULT_OCCURRENCE_CAP = 500;

/**
 * Фолбэк-якорь чётности недель для weekly-правил с n>1 и byDay БЕЗ собственного
 * якоря (ни rule.from, ни базовой даты серии). Разворот вхождений — вид: фаза
 * недель ОБЯЗАНА быть стабильной (не зависеть от начала видимого диапазона),
 * иначе серия «прыгала» бы по неделям при листании календаря и выглядела
 * еженедельной. Привязываемся к фиксированному понедельнику эпохи — фаза
 * глобально детерминирована и задокументирована (конкретная неделя произвольна;
 * новые серии из UI получают явный 'from', см. eventSeries.withSeriesAnchor).
 */
const WEEK_PARITY_EPOCH: IsoDate = "1970-01-05"; // понедельник

/** Эффективный якорь для разворота: явный from/base серии, иначе — для weekly
 *  n>1 с byDay стабильный эпоха-фолбэк (не даёт фазе зависеть от диапазона). */
function effectiveAnchor(rule: Rule, anchor: IsoDate | undefined): IsoDate | undefined {
	if (rule.from !== undefined) return rule.from;
	if (anchor !== undefined) return anchor;
	if (rule.freq === "weekly" && rule.byDay.length > 0 && rule.n > 1) return WEEK_PARITY_EPOCH;
	return undefined;
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
	const anc = effectiveAnchor(rule, anchor);
	let cur = nextOccurrence(rule, addDays(fromIso, -1), anc); // первое вхождение ≥ fromIso
	while (cur !== null && compare(cur, toIso) <= 0 && out.length < cap) {
		if (exclude === undefined || !exclude.has(cur)) out.push(cur);
		cur = nextOccurrence(rule, cur, anc);
	}
	return out;
}
