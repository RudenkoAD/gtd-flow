import type { FeedbackStorage } from "./EstimateFeedbackService";

export interface FeedbackFilePort {
	list(pathPrefix: string): Promise<string[]>;
	read(path: string): Promise<string | null>;
	writeAtomic(path: string, content: string): Promise<void>;
	writeNew(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
}

/**
 * Vault-backed persistence for estimate feedback.
 *
 * This adapter belongs to the metadata layer even though the first producer of
 * feedback was the desktop AI feature. Keeping it here lets manual metadata
 * editing and ownership recovery run without loading provider or OAuth code.
 */
export class FeedbackStorageAdapter implements FeedbackStorage {
	constructor(private readonly files: FeedbackFilePort) {}

	list(path: string): Promise<string[]> {
		return this.files.list(path);
	}

	read(path: string): Promise<string | null> {
		return this.files.read(path);
	}

	async writeAtomic(path: string, content: string): Promise<void> {
		await this.files.writeAtomic(path, content);
	}

	async writeNew(path: string, content: string): Promise<void> {
		try {
			await this.files.writeNew(path, content);
		} catch (error: unknown) {
			// Immutable feedback events expose a domain conflict instead of leaking
			// the vault implementation's create-if-absent error.
			if (error instanceof Error && error.message.startsWith("vault-file-exists:")) {
				throw new Error("feedback-event-conflict");
			}
			throw error;
		}
	}

	delete(path: string): Promise<void> {
		return this.files.remove(path);
	}
}
