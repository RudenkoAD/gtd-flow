/**
 * Svelte-action: Obsidian-подсказка (setTooltip) на элементе. Живёт в НЕ-core
 * слое — импорт obsidian здесь допустим. Реактивна: при смене params обновляет
 * текст/снимает подсказку. Пустой/`null` текст снимает подсказку (setTooltip с
 * "") — тогда работает native `title` элемента (если задан в разметке).
 *
 * Применение (события календаря): при наличии 📍 у события подсказка идёт ПОД
 * элементом (placement: 'bottom') и содержит описание события + строку «📍 <место>»;
 * native `title` в разметке при этом снимается, чтобы не плодить двойных подсказок.
 */
import { setTooltip } from "obsidian";
import type { TooltipPlacement } from "obsidian";

export interface ObsidianTooltipParams {
	/** Текст подсказки; null | "" — снять подсказку. */
	text: string | null;
	/** Сторона относительно элемента; по умолчанию 'bottom'. */
	placement?: TooltipPlacement;
	/** Доп. классы для .tooltip (напр. многострочный режим). */
	classes?: string[];
}

export function obsidianTooltip(node: HTMLElement, params: ObsidianTooltipParams) {
	const apply = (p: ObsidianTooltipParams): void => {
		// setTooltip("") снимает подсказку — не регистрируем пустую
		setTooltip(node, p.text ?? "", {
			placement: p.placement ?? "bottom",
			...(p.classes !== undefined ? { classes: p.classes } : {}),
		});
	};
	apply(params);
	return {
		update(p: ObsidianTooltipParams): void {
			apply(p);
		},
	};
}
