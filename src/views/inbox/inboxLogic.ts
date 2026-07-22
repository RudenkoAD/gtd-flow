/**
 * Локальный фильтр шапки входящих: подстрока без учёта регистра
 * по описанию и тегам. Сортировку даёт QueryEngine — здесь только сужение.
 * Плюс быстрый ввод новой задачи (санитация + append) — обе логики чистые,
 * без obsidian, тестируются в node.
 */
import type { IsoDate, Task } from "../../core/model/Task";
import { appendLine } from "../calendar/calendarLogic";
import { quickCaptureLineNl } from "../common/taskActions";

export function filterTasks(tasks: readonly Task[], query: string): readonly Task[] {
	const q = query.trim().toLowerCase();
	if (q === "") return tasks;
	return tasks.filter(
		(t) =>
			t.description.toLowerCase().includes(q) ||
			t.tags.some((tag) => tag.toLowerCase().includes(q)),
	);
}

/** Структурный порт записи для быстрого ввода во входящие; совместим с VaultAdapter. */
export interface InboxWritePort {
	ensureFile(path: string): Promise<void>;
	processFile(path: string, transform: (content: string) => string | null): Promise<boolean>;
	/** Создание/правка frontmatter файла входящих (gtd-inbox: true) — для ensureCaptureFile. */
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<unknown>;
}

/**
 * Быстрый ввод во «Входящих»: та же санитация, что у палитры
 * (taskActions.quickCaptureLine → единый формат `- [ ] <текст>`) плюс
 * распознавание русских дат (quickCaptureLineNl: «завтра в 15 …» → 📅 +время),
 * затем append строки в конец файла. `today` (IsoDate) включает NLP; null/пропуск —
 * старое поведение без дат. Пустой/невалидный ввод → null: вызывающий ничего не
 * пишет и не чистит поле. Возврат — трансформ для VaultAdapter.processFile.
 */
export function inboxCaptureTransform(
	text: string,
	today: IsoDate | null = null,
): ((content: string) => string) | null {
	const line = quickCaptureLineNl(text, today);
	if (line === null) return null;
	return (content) => appendLine(content, line);
}
