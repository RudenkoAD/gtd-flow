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

export function scanSnapshotListItems(content: string): SnapshotListItem[] {
	const lines = content.split("\n");
	const items: ListItemLike[] = [];
	const headings: HeadingLike[] = [];
	/** Открытые пункты списка выше по дереву — для вычисления родителя по отступу. */
	const stack: { line: number; indent: number }[] = [];
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

		// огороженные блоки кода: содержимое игнорируем целиком
		const fence = FENCE_RE.exec(line);
		if (inFence) {
			if (fence !== null && line.trim().startsWith(fenceMarker)) inFence = false;
			continue;
		}
		if (fence !== null) {
			inFence = true;
			fenceMarker = fence[1]!;
			continue;
		}

		// заголовок обрывает текущее дерево списка
		if (HEADING_RE.test(line)) {
			headings.push({
				position: { start: { line: i }, end: { line: i } },
				heading: line.replace(/^#{1,6}\s+/, "").trim(),
			});
			stack.length = 0;
			continue;
		}

		const lm = LIST_RE.exec(line);
		if (lm !== null) {
			const indent = lm[1]!.length;
			while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
			const parent = stack.length > 0 ? stack[stack.length - 1]!.line : -1;
			stack.push({ line: i, indent });
			const tm = TASK_RE.exec(line);
			items.push({
				position: { start: { line: i }, end: { line: i } },
				task: tm !== null ? tm[1]! : undefined,
				parent,
			});
			continue;
		}

		// не-пункт и не продолжение (без отступа) либо пустая строка — обрыв дерева.
		// Отступ родителя точнее не нужен: parentLine — подсказка, а не идентичность.
		if (line.trim() === "" || !/^[ \t]/.test(line)) stack.length = 0;
	}

	return snapshotListItems(items, headings);
}
