/**
 * Разбор и запись YAML-frontmatter файлов vault'а вне Obsidian (MCP-сервер).
 *
 * Obsidian вычисляет frontmatter своим кэшем метаданных; здесь его нет, поэтому
 * блок «--- … ---» в начале файла парсится/сериализуется библиотекой `yaml`.
 * Читатель fail-open: битый YAML трактуется как отсутствие frontmatter (файл
 * остаётся видимым как plain-заметка, а не роняет весь скан). Писатель
 * (applyFrontmatter) зеркалит семантику app.fileManager.processFrontMatter:
 * мутирует объект и переписывает ТОЛЬКО блок frontmatter, тело заметки — дословно.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface SplitFrontmatter {
	/** Разобранный объект frontmatter либо null (нет блока / не объект / битый YAML). */
	data: Record<string, unknown> | null;
	/** Тело заметки после закрывающего «---» — дословно. */
	body: string;
}

/** frontmatter Obsidian — строго в начале файла: «---\n…\n---» + перевод строки/конец. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(content: string): SplitFrontmatter {
	const m = FRONTMATTER_RE.exec(content);
	if (m === null) return { data: null, body: content };
	let data: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = parseYaml(m[1]!);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			data = parsed as Record<string, unknown>;
		}
	} catch {
		// битый YAML — как отсутствие frontmatter (не роняем скан из-за одного файла)
		data = null;
	}
	return { data, body: content.slice(m[0].length) };
}

/**
 * Прочитать frontmatter как объект (или null). Тонкая обёртка над splitFrontmatter
 * для мест, где тело не нужно (определение контейнера, BoardService.readFrontmatter).
 */
export function readFrontmatter(content: string): Record<string, unknown> | null {
	return splitFrontmatter(content).data;
}

/**
 * Применить мутацию к frontmatter и вернуть новое содержимое файла.
 *
 * Зеркалит app.fileManager.processFrontMatter: fn получает ЖИВОЙ объект
 * frontmatter (пустой, если блока не было — тогда он будет создан в начале файла),
 * мутирует его точечно; тело заметки сохраняется дословно. Значение записывается
 * блочным YAML (yaml.stringify) — форма может отличаться от исходной (flow→block),
 * но данные валидны и Obsidian читает их штатно.
 */
export function applyFrontmatter(
	content: string,
	fn: (fm: Record<string, unknown>) => void,
): string {
	const { data, body } = splitFrontmatter(content);
	const fm = data ?? {};
	fn(fm);
	const yamlText = stringifyYaml(fm);
	const trimmed = yamlText.endsWith("\n") ? yamlText.slice(0, -1) : yamlText;
	return `---\n${trimmed}\n---\n${body}`;
}
