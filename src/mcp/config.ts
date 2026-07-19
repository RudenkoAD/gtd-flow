/**
 * Загрузка конфигурации GTD Flow для MCP-сервера.
 *
 * Читает <vault>/.obsidian/plugins/gtd-flow/data.json (если есть) и сливает с
 * фабричными дефолтами тем же mergeSettings, что и плагин — поэтому namespaces,
 * commonRoot, eventsFile, projectTagPrefix и пр. трактуются идентично. Активное
 * пространство нормализуется (удалённое из namespaces откатывается к «Общему»).
 * Отсутствие/битый data.json ⇒ чистые дефолты (сервер работает и без плагина).
 */
import { promises as fs } from "fs";
import * as path from "path";
import { normalizeActiveNamespace } from "../core/namespace/namespace";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "../settings/Settings";
import { mergeSettings } from "../settings/mergeSettings";

export async function loadSettings(vaultRoot: string): Promise<GtdFlowSettings> {
	const dataPath = path.join(vaultRoot, ".obsidian", "plugins", "gtd-flow", "data.json");
	let loaded: unknown = null;
	try {
		loaded = JSON.parse(await fs.readFile(dataPath, "utf8"));
	} catch {
		// нет плагина / битый json — работаем на дефолтах
		loaded = null;
	}
	const merged = mergeSettings(DEFAULT_SETTINGS, loaded);
	merged.activeNamespace = normalizeActiveNamespace(merged.activeNamespace, merged.namespaces);
	return merged;
}
