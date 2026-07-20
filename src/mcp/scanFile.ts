/**
 * Скан пунктов списка markdown-файла в SnapshotListItem[] вне Obsidian.
 *
 * IndexerService принимает snapshot.listItems, спроецированные из кэша метаданных
 * Obsidian (ListItemCache/HeadingCache). У MCP-сервера кэша нет — восстанавливаем
 * ту же проекцию из сырого текста: строки-пункты списка с номером строки, символом
 * статуса задачи, строкой-родителем (по отступу) и ближайшим заголовком сверху.
 *
 * Пропускаем frontmatter (блок «--- … ---» в начале) и огороженные блоки кода
 * (``` / ~~~) — «- [ ]» внутри них не задача (так же ведёт себя кэш Obsidian).
 * Финальная проекция и вычисление заголовка делегированы snapshotHelpers, чтобы
 * семантика совпала с адаптером плагина буква-в-букву.
 *
 * Паритет с ListItemCache (та же строка ⇒ тот же набор задач в плагине и MCP):
 *
 * 1. Цитаты/коллауты. Obsidian кладёт пункты списка внутри «> …» в ListItemCache,
 *    но конвейер плагина всё равно их отбрасывает: IndexerService передаёт в
 *    parseTaskLine СЫРУЮ строку (с префиксом «> »), а токенизатор HEAD_RE не
 *    матчит «> - [ ]» ⇒ null ⇒ задача не индексируется. Паритет достигается
 *    зеркалированием кэша: скан ТОЖЕ отдаёт такие пункты (позиции — по исходной
 *    строке), а отбрасывает их тот же даунстрим (parseTaskLine), что и в плагине.
 *    Итог на обеих сторонах одинаков: задачи в цитатах/коллаутах НЕ в индексе.
 *
 * 2. Отступные блоки кода. Строка «    - [ ] …» — код, только если она НЕ может
 *    быть продолжением списка (CommonMark): предыдущая непустая строка — не пункт
 *    списка. Настоящие вложенные подзадачи (4+ пробела/таб под родителем) при
 *    этом остаются пунктами — консервативно исключаем только доказуемый код.
 */
import {
	snapshotListItems,
	type HeadingLike,
	type ListItemLike,
} from "../services/snapshotHelpers";
import type { SnapshotListItem } from "../services/types";

/** Пункт списка задачи: маркер «-», «*» или «+», статус в [ ], пробел/конец строки после ']'. */
const TASK_RE = /^[ \t]*[-*+][ \t]+\[(.)\](?=\s|$)/u;
/** Любой пункт списка (в т.ч. нумерованный) — для структуры отступов/родителей. */
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^[ \t]*(```+|~~~+)/;
/** Префикс цитаты/коллаута: повторяющиеся «>» (после каждого — до 3 пробелов
 *  или таб), как их снимает markdown-парсер Obsidian. */
const BLOCKQUOTE_RE = /^((?:[ \t]{0,3}>[ \t]?)+)/;

/** Ширина отступа с раскрытием табов (таб-стоп 4, как в CommonMark). */
function indentWidth(ws: string): number {
	let w = 0;
	for (const ch of ws) w += ch === "\t" ? 4 - (w % 4) : 1;
	return w;
}

export function scanSnapshotListItems(content: string): SnapshotListItem[] {
	const lines = content.split("\n");
	const items: ListItemLike[] = [];
	const headings: HeadingLike[] = [];
	/** Открытые пункты списка выше по дереву — для вычисления родителя по отступу. */
	const stack: { line: number; indent: number }[] = [];
	/** Глубина цитаты, в которой живёт текущий стек (0 — вне цитат): пункт из
	 *  другой глубины не продолжает дерево, а начинает новое. */
	let stackBqDepth = 0;
	/** Предыдущая непустая строка была пунктом списка — отступная строка после
	 *  неё лишь продолжение списка, а не отступный блок кода (CommonMark). */
	let prevNonBlankIsList = false;
	let inFrontmatter = false;
	let inFence = false;
	let fenceMarker = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.replace(/\r$/, "");

		// frontmatter — только в самом начале файла
		if (i === 0 && line.trim() === "---") {
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) {
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}

		// префикс цитаты снимаем ДО остальных проверок: пункт/заголовок/код
		// внутри «> …» распознаются по остатку, позиции — по исходной строке
		const bq = BLOCKQUOTE_RE.exec(line);
		const bqDepth = bq !== null ? (bq[1]!.match(/>/g) ?? []).length : 0;
		const rest = bq !== null ? line.slice(bq[1]!.length) : line;

		// огороженные блоки кода: содержимое игнорируем целиком
		const fence = FENCE_RE.exec(rest);
		if (inFence) {
			if (fence !== null && rest.trim().startsWith(fenceMarker)) inFence = false;
			if (line.trim() !== "") prevNonBlankIsList = false;
			continue;
		}
		if (fence !== null) {
			inFence = true;
			fenceMarker = fence[1]!;
			prevNonBlankIsList = false;
			continue;
		}

		// заголовок обрывает текущее дерево списка; в HeadingCache идут только
		// заголовки верхнего уровня (внутри цитат кэш-заголовок здесь не нужен:
		// потребитель nearestHeadingAbove зеркалит поведение адаптера плагина)
		if (HEADING_RE.test(rest)) {
			if (bqDepth === 0) {
				headings.push({
					position: { start: { line: i }, end: { line: i } },
					heading: rest.replace(/^#{1,6}\s+/, "").trim(),
				});
			}
			stack.length = 0;
			prevNonBlankIsList = false;
			continue;
		}

		const lm = LIST_RE.exec(rest);
		if (lm !== null) {
			// отступный блок кода (вне цитат): 4+ ширины отступа И предыдущая
			// непустая строка — не пункт списка ⇒ это не продолжение списка,
			// Obsidian такой пункт в кэш не кладёт. Вложенные подзадачи под
			// родителем сюда не попадают (prevNonBlankIsList === true).
			if (bqDepth === 0 && indentWidth(lm[1]!) >= 4 && !prevNonBlankIsList) {
				prevNonBlankIsList = false;
				continue;
			}
			// смена глубины цитаты — новое дерево, чужие родители не наследуются
			if (bqDepth !== stackBqDepth) {
				stack.length = 0;
				stackBqDepth = bqDepth;
			}
			const indent = lm[1]!.length;
			while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
			const parent = stack.length > 0 ? stack[stack.length - 1]!.line : -1;
			stack.push({ line: i, indent });
			const tm = TASK_RE.exec(rest);
			items.push({
				position: { start: { line: i }, end: { line: i } },
				task: tm !== null ? tm[1]! : undefined,
				parent,
			});
			prevNonBlankIsList = true;
			continue;
		}

		// не-пункт и не продолжение (без отступа) либо пустая строка — обрыв дерева.
		// Отступ родителя точнее не нужен: parentLine — подсказка, а не идентичность.
		if (rest.trim() === "" || !/^[ \t]/.test(rest)) stack.length = 0;
		if (line.trim() !== "") prevNonBlankIsList = false;
	}

	return snapshotListItems(items, headings);
}
