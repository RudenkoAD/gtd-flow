/**
 * «Открыть в файле» — общий для карточек и chips календаря переход к строке
 * задачи в нативном редакторе.
 */
import { MarkdownView, Notice, TFile, type App } from "obsidian";
import type { Task } from "../../core/model/Task";

export async function openTaskInFile(
	app: App,
	task: Pick<Task, "filePath" | "lineStart">,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(task.filePath);
	if (!(file instanceof TFile)) {
		new Notice(`GTD Flow: файл не найден: ${task.filePath}`);
		return;
	}
	try {
		const leaf = app.workspace.getLeaf(false);
		await leaf.openFile(file);
		// best effort: строка — подсказка на момент парса, а не идентичность
		if (leaf.view instanceof MarkdownView) {
			leaf.view.editor.setCursor({ line: task.lineStart, ch: 0 });
		}
	} catch (error) {
		new Notice(`GTD Flow: не удалось открыть файл: ${String(error)}`);
	}
}
