/**
 * Заглушка `vault.adapter` поверх той же карты путей, что и фейковый Vault.
 *
 * Настоящий Obsidian НЕ индексирует скрытые (точечные) пути: TFile-API их не
 * видит, а `vault.adapter` — единственная дорога к `.gtd-flow/**`. Фейки в
 * тестах должны воспроизводить обе стороны, иначе регрессия «пишем в дот-папку
 * через TFile» снова станет невидимой.
 */
export interface MemoryListedFiles {
	files: string[];
	folders: string[];
}

export interface MemoryDataAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	list(path: string): Promise<MemoryListedFiles>;
	stat(path: string): Promise<{ type: "file" | "folder" } | null>;
}

export function createMemoryDataAdapter(
	data: Map<string, string>,
	folders: Set<string>,
): MemoryDataAdapter {
	const normalize = (path: string): string => path.replace(/^\/+|\/+$/gu, "");
	return {
		async exists(path) {
			const key = normalize(path);
			return data.has(key) || folders.has(key);
		},
		async read(path) {
			const content = data.get(normalize(path));
			if (content === undefined) throw new Error(`adapter-file-not-found:${path}`);
			return content;
		},
		async write(path, content) {
			data.set(normalize(path), content);
		},
		async mkdir(path) {
			folders.add(normalize(path));
		},
		async remove(path) {
			data.delete(normalize(path));
		},
		async list(path) {
			const prefix = normalize(path);
			const boundary = prefix === "" ? "" : `${prefix}/`;
			const files: string[] = [];
			const nested = new Set<string>();
			for (const key of [...data.keys(), ...folders]) {
				if (!key.startsWith(boundary) || key === prefix) continue;
				const rest = key.slice(boundary.length);
				const slash = rest.indexOf("/");
				if (slash === -1) {
					if (data.has(key)) files.push(key);
					else nested.add(key);
					continue;
				}
				nested.add(`${boundary}${rest.slice(0, slash)}`);
			}
			return { files: files.sort(), folders: [...nested].sort() };
		},
		async stat(path) {
			const key = normalize(path);
			if (data.has(key)) return { type: "file" };
			if (folders.has(key)) return { type: "folder" };
			// папка может существовать только как префикс уже записанных файлов
			const boundary = `${key}/`;
			for (const existing of data.keys()) {
				if (existing.startsWith(boundary)) return { type: "folder" };
			}
			return null;
		},
	};
}
