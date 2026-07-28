/**
 * Разбор и запись YAML-frontmatter файлов vault'а вне Obsidian (MCP-сервер).
 *
 * Obsidian вычисляет frontmatter своим кэшем метаданных; здесь его нет, поэтому
 * блок «--- … ---» в начале файла парсится/сериализуется библиотекой `yaml`.
 * Читатель fail-open: битый YAML не роняет полный скан vault'а. Писатель же
 * fail-closed: присутствующий, но неразбираемый frontmatter НЕЛЬЗЯ путать с
 * отсутствующим — иначе обычная MCP-операция могла бы стереть метаданные.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { frontmatterBlock } from "../core/frontmatter/containerFrontmatter";

export interface SplitFrontmatter {
	/** Состояние блока. invalid означает, что байты надо сохранить без изменений. */
	state: "absent" | "valid" | "invalid";
	/** Разобранный объект frontmatter либо null (нет блока / не объект / битый YAML). */
	data: Record<string, unknown> | null;
	/** Тело заметки после закрывающего «---» — дословно. */
	body: string;
	/** Причина invalid без содержимого заметки (безопасна для диагностик). */
	error: string | null;
}

/** Писатель встретил существующий frontmatter, который нельзя безопасно изменить. */
export class InvalidFrontmatterError extends Error {
	constructor(message: string) {
		super(`invalid YAML frontmatter: ${message}`);
		this.name = "InvalidFrontmatterError";
	}
}

export function splitFrontmatter(content: string): SplitFrontmatter {
	const block = frontmatterBlock(content);
	if (block === null) return { state: "absent", data: null, body: content, error: null };
	if (block === "unterminated") {
		return {
			state: "invalid",
			data: null,
			body: content,
			error: "opening delimiter has no closing delimiter",
		};
	}
	try {
		const parsed: unknown = parseYaml(block.yaml);
		// Пустой YAML-документ валиден и эквивалентен пустому объекту frontmatter.
		if (parsed === null) return { state: "valid", data: {}, body: block.body, error: null };
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				state: "valid",
				data: parsed as Record<string, unknown>,
				body: block.body,
				error: null,
			};
		}
		return {
			state: "invalid",
			data: null,
			body: block.body,
			error: "frontmatter must be a YAML mapping",
		};
	} catch (e) {
		// Скан продолжает работать, но applyFrontmatter откажется переписывать блок.
		return {
			state: "invalid",
			data: null,
			body: block.body,
			error: e instanceof Error ? e.message : "YAML parser failed",
		};
	}
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
	const split = splitFrontmatter(content);
	if (split.state === "invalid")
		throw new InvalidFrontmatterError(split.error ?? "unknown error");
	const fm = split.data ?? {};
	fn(fm);
	const yamlText = stringifyYaml(fm);
	const trimmed = yamlText.endsWith("\n") ? yamlText.slice(0, -1) : yamlText;
	return `---\n${trimmed}\n---\n${split.body}`;
}
