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
import type { IsoDate } from "../model/Task";
import {
	addTag,
	removeTag,
	setDependsOn,
	setDescription,
	setField,
	setPriority,
	setStatusChar,
	setValueField,
} from "../parser/serializeTaskLine";
import type { Intent } from "./Intent";

/**
 * Статус + сопутствующие даты одной правкой: ✅/❌ сопровождают статус,
 * при повторном открытии обе даты снимаются. Общая логика set-status и
 * move-column по статусной колонке — drag на доске ЕСТЬ смена статуса,
 * иначе один и тот же переход писал бы разные данные разными путями UI
 * (снятая с Done карточка тащила бы устаревший ✅ на незакрытой строке).
 */
function applyStatusWithDates(currentLine: string, statusChar: string, date?: IsoDate): string {
	let line = setStatusChar(currentLine, statusChar);
	const toDone = statusChar === "x" || statusChar === "X";
	const toCancelled = statusChar === "-";
	if (toDone) {
		if (date !== undefined) line = setField(line, "done", date);
		line = setField(line, "cancelled", null);
	} else if (toCancelled) {
		if (date !== undefined) line = setField(line, "cancelled", date);
		line = setField(line, "done", null);
	} else {
		line = setField(line, "done", null);
		line = setField(line, "cancelled", null);
	}
	return line;
}

export function resolveLineTransform(intent: Intent, currentLine: string): string | null {
	switch (intent.type) {
		case "set-date": {
			// time/timeEnd: undefined — сохранить время поля, null — снять, строка — установить
			let line = setField(currentLine, intent.field, intent.date, intent.time, intent.timeEnd);
			// «🛫 и 📅 взаимоисключающие»: планирование снимает отложенность разом
			if (intent.clearStart === true && intent.field === "due") line = setField(line, "start", null);
			return line;
		}

		case "set-text":
			return setDescription(currentLine, intent.text);

		case "set-status":
			return applyStatusWithDates(currentLine, intent.statusChar, intent.date);

		case "set-priority":
			return setPriority(currentLine, intent.priority);

		case "move-column": {
			// intent.index (ручной порядок) — frontmatter доски, отдельная запись сервиса
			let line = currentLine;
			if (intent.fromTag !== null) line = removeTag(line, intent.fromTag);
			if (intent.toTag !== null) line = addTag(line, intent.toTag);
			if (intent.toStatusChar !== undefined)
				line = applyStatusWithDates(line, intent.toStatusChar, intent.date);
			return line;
		}

		case "defer": {
			let line = setField(currentLine, "start", intent.until);
			// «🛫 и 📅 взаимоисключающие»: откладывание снимает план разом
			if (intent.clearDue === true) line = setField(line, "due", null);
			return line;
		}

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
