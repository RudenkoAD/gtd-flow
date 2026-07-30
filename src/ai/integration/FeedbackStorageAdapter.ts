import type { FeedbackStorage } from "../../services/EstimateFeedbackService";
import type { AtomicFilePort } from "../storage/AtomicFilePort";

/**
 * Порт, через который сервис обучения работает с `.gtd-flow/ai/**`.
 *
 * Раньше запись и удаление шли мимо порта — прямо в `app.vault.create/delete`,
 * а Obsidian не индексирует скрытые (точечные) пути: `getAbstractFileByPath`
 * всегда возвращал null, повторный create по существующему пути падал, а
 * удаление молча ничего не делало. Теперь весь ввод-вывод идёт одной дорогой —
 * через VaultAdapter, который для скрытых путей ходит в `vault.adapter`.
 */
export interface FeedbackFilePort extends AtomicFilePort {
	remove(path: string): Promise<void>;
}

export class FeedbackStorageAdapter implements FeedbackStorage {
	constructor(private readonly files: FeedbackFilePort) {}

	list(path: string): Promise<string[]> {
		return this.files.list(path);
	}

	read(path: string): Promise<string | null> {
		return this.files.read(path);
	}

	writeAtomic(path: string, content: string): Promise<void> {
		return this.files.writeAtomic(path, content);
	}

	async writeNew(path: string, content: string): Promise<void> {
		try {
			await this.files.writeNew(path, content);
		} catch (error: unknown) {
			// событие обучения неизменяемо: занятый путь — это конфликт,
			// а не сбой записи (вызывающий переименует событие и повторит)
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
