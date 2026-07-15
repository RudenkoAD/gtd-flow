/**
 * Intent + текущая строка → новая строка (ТЗ §3).
 *
 * Здесь разрешаются ТОЛЬКО однострочные intents — делегирование сеттерам
 * serializeTaskLine (правка одного токена, round-trip без потерь).
 *
 * Многострочные/многофайловые intents возвращают null — их применяют сервисы:
 *   - SpawnInstances, DeleteLine, MoveLine — append/удаление целых строк;
 *   - Reorder, MoveNode, SetProjectStatus — frontmatter, не строки задач;
 *   - AddNode — строка + layout одной транзакцией;
 *   - ConnectEdge/DisconnectEdge/DeleteNode — нужен индекс (текущий список ⛔,
 *     проверка циклов ДО записи) — сервис считает новый список и применяет его
 *     через resolveDependsOnTransform.
 */
import {
	addTag,
	removeTag,
	setDependsOn,
	setField,
	setPriority,
	setStatusChar,
	setValueField,
} from "../parser/serializeTaskLine";
import type { Intent } from "./Intent";

export function resolveLineTransform(intent: Intent, currentLine: string): string | null {
	switch (intent.type) {
		case "set-date":
			return setField(currentLine, intent.field, intent.date);

		case "set-status": {
			let line = setStatusChar(currentLine, intent.statusChar);
			const toDone = intent.statusChar === "x" || intent.statusChar === "X";
			const toCancelled = intent.statusChar === "-";
			// ✅/❌ сопровождают статус; при повторном открытии обе даты снимаются
			if (toDone) {
				if (intent.date !== undefined) line = setField(line, "done", intent.date);
				line = setField(line, "cancelled", null);
			} else if (toCancelled) {
				if (intent.date !== undefined) line = setField(line, "cancelled", intent.date);
				line = setField(line, "done", null);
			} else {
				line = setField(line, "done", null);
				line = setField(line, "cancelled", null);
			}
			return line;
		}

		case "set-priority":
			return setPriority(currentLine, intent.priority);

		case "move-column": {
			// intent.index (ручной порядок) — frontmatter доски, отдельная запись сервиса
			let line = currentLine;
			if (intent.fromTag !== null) line = removeTag(line, intent.fromTag);
			if (intent.toTag !== null) line = addTag(line, intent.toTag);
			if (intent.toStatusChar !== undefined) line = setStatusChar(line, intent.toStatusChar);
			return line;
		}

		case "defer":
			return setField(currentLine, "start", intent.until);

		case "set-id":
			return setValueField(currentLine, "id", intent.taskId);

		case "advance-cursor":
			// сдвиг 🔜 — однострочная правка строки шаблона; поиск строки — по templateId
			return setField(currentLine, "nextSpawn", intent.date);

		case "reorder":
		case "spawn-instances":
		case "delete-line":
		case "add-node":
		case "connect-edge":
		case "disconnect-edge":
		case "delete-node":
		case "move-node":
		case "set-project-status":
		case "move-line":
			return null;

		default: {
			// исчерпывающая проверка: новый Intent обязан быть добавлен сюда осознанно
			const exhaustive: never = intent;
			return exhaustive;
		}
	}
}

/**
 * Однострочная правка ⛔ для графовых intents: сервис (владеющий индексом)
 * сам вычисляет итоговый список зависимостей — после проверки циклов —
 * и применяет его к строке здесь. Пустой список ⇒ поле ⛔ снимается.
 */
export function resolveDependsOnTransform(currentLine: string, dependsOn: string[]): string {
	return setDependsOn(currentLine, dependsOn);
}
