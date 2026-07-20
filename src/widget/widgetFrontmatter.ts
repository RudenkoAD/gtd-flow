/**
 * Минимальный читатель YAML-frontmatter для виджет-бандла (без зависимости `yaml`).
 *
 * Бандл ядра исполняется во встраиваемом движке (QuickJS) без node/DOM и без npm-
 * зависимостей: тащить полноценный YAML-парсер сюда нельзя (вес + риск ссылок на
 * process). Виджету от frontmatter нужны ТОЛЬКО скалярные флаги-контейнеры
 * (gtd-events/gtd-inbox/gtd-project/…) и строка gtd-namespace — их достаточно снять
 * построчным разбором `ключ: значение` верхнего уровня. Форма блока и fail-open
 * семантика (нет блока / мусор ⇒ null) совпадают с mcp/frontmatter.splitFrontmatter,
 * но без библиотеки: индексная раскладка (fileContextFromFrontmatter) идентична.
 *
 * Осознанные ограничения (виджету не нужны): вложенные объекты/списки и многострочные
 * скаляры игнорируются (берётся скаляр на той же строке); значения `true`/`false`
 * (без учёта регистра) → boolean, всё прочее — строка (со снятием кавычек). Этого
 * хватает resolveContainer/frontmatterNamespace, которым важны лишь `=== true` и тип
 * строки у gtd-namespace/gtd-card-of/status.
 */

/** frontmatter Obsidian — строго в начале файла: «---\n…\n---» + перевод строки/конец. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Строка `ключ: значение` верхнего уровня (без ведущих пробелов — вложенное пропускаем). */
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_-]*):[ \t]*(.*)$/;

/** Снять окружающие кавычки скалярного значения (одинарные/двойные), иначе trim. */
function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2) {
		const first = v.charAt(0);
		const last = v.charAt(v.length - 1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return v.slice(1, -1);
		}
	}
	return v;
}

/**
 * Разобрать frontmatter-объект из содержимого файла либо null (нет блока / пустой
 * блок). Значения-скаляры: `true`/`false` → boolean, прочее — строка. Комментарии
 * (`# …`) и строки без двоеточия пропускаются; хвостовой inline-комментарий НЕ
 * срезается (Obsidian его тоже не трактует у скаляров — значение дословно до конца
 * строки, что для наших флагов безопасно).
 */
export function parseWidgetFrontmatter(content: string): Record<string, unknown> | null {
	const m = FRONTMATTER_RE.exec(content);
	if (m === null) return null;
	const body = m[1] ?? "";
	const out: Record<string, unknown> = {};
	let found = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		// только верхний уровень: строки с ведущим отступом — часть вложенной структуры
		if (/^[ \t]/.test(line)) continue;
		const km = KEY_RE.exec(line);
		if (km === null) continue;
		const key = km[1]!;
		const valueRaw = km[2] ?? "";
		const lower = valueRaw.trim().toLowerCase();
		let value: unknown;
		if (lower === "true") value = true;
		else if (lower === "false") value = false;
		else if (valueRaw.trim() === "") value = "";
		else value = unquote(valueRaw);
		out[key] = value;
		found = true;
	}
	return found ? out : null;
}
