/**
 * Машинные коды ошибок → человеческий русский текст для Notice.
 *
 * Сервисы намеренно бросают короткие стабильные коды (`scope-is-referenced:3`,
 * `task-metadata-locked:duration`), но пользователю в уведомление до сих пор
 * улетал `String(error)` — то есть «Error: scope-is-referenced:3». Перевод
 * делаем ровно на границе UI: коды остаются машинными, сообщение — читаемым.
 */
const FIELD_NAMES: Readonly<Record<string, string>> = {
	duration: "длительность",
	cognitive: "когнитивная нагрузка",
	emotional: "эмоциональная нагрузка",
	physical: "физическая нагрузка",
	scope: "scope",
};

type Describe = (detail: string) => string;

const MESSAGES: Readonly<Record<string, string | Describe>> = {
	"scope-is-referenced": (detail) =>
		detail === ""
			? "на этот scope ещё ссылаются задачи"
			: `на этот scope ещё ссылаются задачи (${detail})`,
	"scope-not-found": "scope не найден",
	"scope-not-active": "scope архивирован или не существует",
	"scope-name-already-exists": "scope с таким именем уже есть",
	"scope-catalog-not-loaded": "каталог scope ещё не загружен",
	"scope-catalog-invalid":
		"каталог scope повреждён — изменения заблокированы; используйте команду «Пересоздать каталог scope…»",
	"scope-catalog-changed": "каталог scope изменился на другом устройстве, повторите",
	"scope-catalog-already-initialized": "каталог scope уже создан",
	"scope-order-must-contain-every-scope-once": "порядок scope задан неверно",
	"task-metadata-locked": (detail) =>
		`эти поля вы изменили вручную, AI их не перезаписывает: ${fieldList(detail)}`,
	"inbox-file-unavailable": (detail) =>
		detail === "" ? "файл входящих недоступен" : `файл входящих недоступен: ${detail}`,
	"task-not-found": "задача не найдена",
	"vault-file-not-found": (detail) =>
		detail === "" ? "файл не найден" : `файл не найден: ${detail}`,
	"vault-file-exists": (detail) =>
		detail === "" ? "файл уже существует" : `файл уже существует: ${detail}`,
};

function fieldList(detail: string): string {
	return detail
		.split(",")
		.map((field) => FIELD_NAMES[field.trim()] ?? field.trim())
		.filter((field) => field !== "")
		.join(", ");
}

/** Человекочитаемая причина для Notice; незнакомый код возвращаем как есть. */
export function describeError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const trimmed = raw.replace(/^Error:\s*/u, "").trim();
	const separator = trimmed.indexOf(":");
	const code = separator === -1 ? trimmed : trimmed.slice(0, separator);
	const detail = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
	const message = MESSAGES[code];
	if (message === undefined) return trimmed === "" ? String(error) : trimmed;
	return typeof message === "string" ? message : message(detail);
}
