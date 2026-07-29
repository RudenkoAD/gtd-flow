import type { App } from "obsidian";
import type { FeedbackStorage } from "../../services/EstimateFeedbackService";
import type { AtomicFilePort } from "../storage/AtomicFilePort";

export class FeedbackStorageAdapter implements FeedbackStorage {
	constructor(
		private readonly app: App,
		private readonly files: AtomicFilePort,
	) {}

	list(path: string): Promise<string[]> {
		return this.files.list(path);
	}

	read(path: string): Promise<string | null> {
		return this.files.read(path);
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		await ensureParentFolders(this.app, path);
		await this.files.writeAtomic(path, content);
	}

	async writeNew(path: string, content: string): Promise<void> {
		if ((await this.files.read(path)) !== null) throw new Error("feedback-event-conflict");
		await ensureParentFolders(this.app, path);
		if (this.app.vault.getAbstractFileByPath(path) !== null) {
			throw new Error("feedback-event-conflict");
		}
		await this.app.vault.create(path, content);
	}

	async delete(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file !== null) await this.app.vault.delete(file);
	}
}

async function ensureParentFolders(app: App, path: string): Promise<void> {
	const parts = path.split("/").slice(0, -1);
	let current = "";
	for (const part of parts) {
		current = current === "" ? part : `${current}/${part}`;
		if (app.vault.getAbstractFileByPath(current) === null) {
			await app.vault.createFolder(current).catch(() => undefined);
		}
	}
}
