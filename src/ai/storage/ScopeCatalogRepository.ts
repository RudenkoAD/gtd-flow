import type { AtomicFilePort } from "./AtomicFilePort";
import { GTD_FLOW_FOLDER, readJsonFile, serializeJson } from "./AtomicFilePort";
import { ScopeCatalogV1Schema, type ScopeCatalogV1 } from "./storageSchemas";

const SCOPE_PATH = `${GTD_FLOW_FOLDER}/config/scopes.json`;

export class ScopeCatalogRepository {
	constructor(private readonly files: AtomicFilePort) {}

	async load(): Promise<ScopeCatalogV1> {
		const data = await readJsonFile(this.files, SCOPE_PATH);
		if (data === null) return { schemaVersion: 1, scopes: [] };
		return ScopeCatalogV1Schema.parse(data);
	}

	async save(catalog: ScopeCatalogV1): Promise<void> {
		const parsed = ScopeCatalogV1Schema.parse(catalog);
		await this.files.writeAtomic(SCOPE_PATH, serializeJson(parsed));
	}

	async activeScopeIds(): Promise<Set<string>> {
		const catalog = await this.load();
		return new Set(catalog.scopes.filter((scope) => !scope.archived).map((scope) => scope.id));
	}

	async hasActiveScopes(): Promise<boolean> {
		return (await this.activeScopeIds()).size > 0;
	}
}
