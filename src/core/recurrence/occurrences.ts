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
 */
export function expandOccurrences(
	rule: Rule,
	fromIso: IsoDate,
	toIso: IsoDate,
	cap: number = DEFAULT_OCCURRENCE_CAP,
	exclude?: ReadonlySet<IsoDate>,
): IsoDate[] {
	const out: IsoDate[] = [];
	if (compare(fromIso, toIso) > 0 || cap <= 0) return out;
	let cur = nextOccurrence(rule, addDays(fromIso, -1)); // первое вхождение ≥ fromIso
	while (cur !== null && compare(cur, toIso) <= 0 && out.length < cap) {
		if (exclude === undefined || !exclude.has(cur)) out.push(cur);
		cur = nextOccurrence(rule, cur);
	}
	return out;
}
