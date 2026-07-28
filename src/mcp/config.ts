/**
 * Загрузка конфигурации GTD Flow для MCP-сервера.
 *
 * Отсутствующий data.json означает, что плагин ещё не настраивали, и только в
 * этом случае безопасно использовать фабричные пути. Повреждённый/нечитаемый
 * файл нельзя молча подменять defaults: write-инструмент тогда мог бы создать
 * новые задачи в GTD/... вместо пользовательского vault layout.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { normalizeActiveNamespace } from "../core/namespace/namespace";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "../settings/Settings";
import { PersistedSettingsSchema, mergeSettingsWithDiagnostics } from "../settings/mergeSettings";

type JsonObject = Record<string, unknown>;

/** Безопасная для MCP диагностика: содержит путь/поле, но не содержимое заметок
 * или конфигурации. Later a full settings schema can replace parseMcpSettings
 * without changing this fail-closed boundary. */
export class McpConfigError extends Error {
	constructor(message: string) {
		super(`GTD Flow MCP configuration error: ${message}`);
		this.name = "McpConfigError";
	}
}

/** Validate the shared persisted schema at the MCP trust boundary. It remains
 * permissive about absent/unknown fields for legacy/forward compatibility, but
 * every known field must pass the same bounds/path/URL rules as the plugin.
 * Unlike the interactive plugin loader, MCP must never recover an invalid write
 * target to a factory default. */
export function parseMcpSettings(raw: unknown): JsonObject {
	const parsed = PersistedSettingsSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.path.length ? issue.path.join(".") : "data.json";
		throw new McpConfigError(`'${field}' is invalid (${issue?.message ?? "schema mismatch"})`);
	}
	return parsed.data as JsonObject;
}

export async function loadSettings(vaultRoot: string): Promise<GtdFlowSettings> {
	const dataPath = path.join(vaultRoot, ".obsidian", "plugins", "gtd-flow", "data.json");
	let loaded: JsonObject | null = null;
	try {
		const text = await fs.readFile(dataPath, "utf8");
		try {
			loaded = parseMcpSettings(JSON.parse(text));
		} catch (e) {
			if (e instanceof McpConfigError) throw e;
			throw new McpConfigError(
				`cannot parse data.json (${e instanceof Error ? e.message : "invalid JSON"})`,
			);
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			// First run/no plugin installation: no user path exists to preserve.
			loaded = null;
		} else if (e instanceof McpConfigError) {
			throw e;
		} else {
			const code = (e as NodeJS.ErrnoException | undefined)?.code;
			throw new McpConfigError(
				`cannot read data.json${code !== undefined ? ` (${code})` : ""}`,
			);
		}
	}
	const result = mergeSettingsWithDiagnostics(DEFAULT_SETTINGS, loaded);
	if (loaded !== null) {
		// Parsed known fields must merge without any recovery/drop. The one benign
		// diagnostic is a format-version migration for legacy files.
		const recovery = result.diagnostics.filter(
			(message) => !/^settings: migrated v\d+ → v\d+$/.test(message),
		);
		if (recovery.length > 0) {
			const field = recovery[0]?.split(":")[0] || "data.json";
			throw new McpConfigError(`'${field}' cannot be loaded without recovery`);
		}
	}
	const merged = result.settings;
	// Legacy files persisted the display label "Общее" before the stable sentinel
	// existed. Normalizing that selection is safe: it cannot change any folder
	// path, unlike recovering an invalid path-bearing field above.
	merged.activeNamespace = normalizeActiveNamespace(merged.activeNamespace, merged.namespaces);
	return merged;
}
