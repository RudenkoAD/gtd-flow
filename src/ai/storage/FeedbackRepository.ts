import type { AtomicFilePort } from "./AtomicFilePort";
import { GTD_FLOW_FOLDER, SyncedStorageError, readJsonFile, serializeJson } from "./AtomicFilePort";
import { FeedbackEventV1Schema, RecordIdSchema, type FeedbackEventV1 } from "./storageSchemas";

const FEEDBACK_FOLDER = `${GTD_FLOW_FOLDER}/ai/feedback`;

/** Immutable feedback events avoid cross-device append conflicts. */
export class FeedbackRepository {
	constructor(private readonly files: AtomicFilePort) {}

	async create(event: FeedbackEventV1): Promise<void> {
		const parsed = FeedbackEventV1Schema.parse(event);
		const path = feedbackPath(parsed.id);
		try {
			await this.files.writeNew(path, serializeJson(parsed));
		} catch (error: unknown) {
			if ((await this.files.read(path)) !== null) {
				throw new SyncedStorageError("conflict");
			}
			throw error;
		}
	}

	async get(id: string): Promise<FeedbackEventV1> {
		const data = await readJsonFile(this.files, feedbackPath(id));
		if (data === null) throw new SyncedStorageError("not-found");
		return FeedbackEventV1Schema.parse(data);
	}

	async list(): Promise<FeedbackEventV1[]> {
		const paths = await this.files.list(FEEDBACK_FOLDER);
		if (
			paths.some((path) => !path.startsWith(`${FEEDBACK_FOLDER}/`) || !path.endsWith(".json"))
		) {
			throw new SyncedStorageError("invalid-record");
		}
		const events = await Promise.all(
			paths.map(async (path) => {
				const data = await readJsonFile(this.files, path);
				if (data === null) throw new SyncedStorageError("invalid-record");
				const event = FeedbackEventV1Schema.parse(data);
				if (path !== feedbackPath(event.id)) {
					throw new SyncedStorageError("invalid-record");
				}
				return event;
			}),
		);
		return events.sort(
			(left, right) =>
				Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
				left.id.localeCompare(right.id),
		);
	}
}

function feedbackPath(id: string): string {
	return `${FEEDBACK_FOLDER}/${RecordIdSchema.parse(id)}.json`;
}
