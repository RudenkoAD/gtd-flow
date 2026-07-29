import type { AgentMessage } from "../core/messages";
import type { AtomicFilePort } from "./AtomicFilePort";
import { GTD_FLOW_FOLDER, SyncedStorageError } from "./AtomicFilePort";
import {
	RecordIdSchema,
	SessionHeaderV1Schema,
	SessionMessageV1Schema,
	SessionRecordV1Schema,
	type SessionHeaderV1,
	type SessionMessageV1,
} from "./storageSchemas";

const SESSIONS_FOLDER = `${GTD_FLOW_FOLDER}/ai/sessions`;

export interface LoadedSession {
	header: SessionHeaderV1;
	messages: SessionMessageV1[];
}

export class SessionRepository {
	constructor(private readonly files: AtomicFilePort) {}

	async create(header: SessionHeaderV1): Promise<void> {
		const parsed = SessionHeaderV1Schema.parse(header);
		if (
			(await this.files.read(sessionHeaderPath(parsed.id))) !== null ||
			(await this.files.read(legacySessionPath(parsed.id))) !== null ||
			(await this.files.list(sessionMessagesFolder(parsed.id))).length > 0
		)
			throw new SyncedStorageError("conflict");
		try {
			await this.files.writeNew(sessionHeaderPath(parsed.id), `${JSON.stringify(parsed)}\n`);
		} catch (error: unknown) {
			if ((await this.files.read(sessionHeaderPath(parsed.id))) !== null) {
				throw new SyncedStorageError("conflict");
			}
			throw error;
		}
	}

	async load(sessionId: string): Promise<LoadedSession> {
		const id = RecordIdSchema.parse(sessionId);
		const [headerContent, legacyContent, paths] = await Promise.all([
			this.files.read(sessionHeaderPath(id)),
			this.files.read(legacySessionPath(id)),
			this.files.list(sessionMessagesFolder(id)),
		]);
		const shardedHeader = parseHeader(headerContent, id);
		const legacy = legacyContent === null ? null : parseSessionFile(legacyContent, id);
		const header = shardedHeader ?? legacy?.header;
		if (!header) throw new SyncedStorageError("not-found");
		if (shardedHeader && legacy && !sameHeader(shardedHeader, legacy.header)) {
			throw new SyncedStorageError("invalid-record");
		}
		if (
			paths.some(
				(path) =>
					!path.startsWith(`${sessionMessagesFolder(id)}/`) || !path.endsWith(".json"),
			)
		) {
			throw new SyncedStorageError("invalid-record");
		}
		const shardedMessages = await Promise.all(
			paths.map(async (path) => {
				const record = parseMessage(await this.files.read(path), id);
				if (path !== messagePath(id, record.message.id)) {
					throw new SyncedStorageError("invalid-record");
				}
				return record;
			}),
		);
		return assembleSession(header, [...(legacy?.messages ?? []), ...shardedMessages]);
	}

	async list(): Promise<LoadedSession[]> {
		const paths = await this.files.list(SESSIONS_FOLDER);
		const ids = new Set<string>();
		for (const path of paths) {
			const legacy = /^\.gtd-flow\/ai\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]*)\.jsonl$/u.exec(
				path,
			);
			const header =
				/^\.gtd-flow\/ai\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]*)\/header\.json$/u.exec(path);
			if (legacy?.[1]) ids.add(legacy[1]);
			if (header?.[1]) ids.add(header[1]);
		}
		const sessions = await Promise.all(
			[...ids].sort().map((id) => this.load(RecordIdSchema.parse(id))),
		);
		return sessions.sort(
			(left, right) =>
				Date.parse(right.header.updatedAt) - Date.parse(left.header.updatedAt) ||
				left.header.id.localeCompare(right.header.id),
		);
	}

	async appendMessage(
		sessionId: string,
		message: AgentMessage,
		updatedAt: string,
	): Promise<void> {
		const id = RecordIdSchema.parse(sessionId);
		// Validate the current immutable stream before adding another shard. A
		// malformed header/message or a synced ID conflict must never be extended.
		await this.load(id);
		const record: SessionMessageV1 = SessionMessageV1Schema.parse({
			kind: "message",
			schemaVersion: 1,
			sessionId: id,
			// Shards are ordered by immutable timestamps and IDs at read time. A
			// process-local sequence would reintroduce a shared-file RMW race.
			sequence: 0,
			recordedAt: updatedAt,
			message,
		});
		assertValidShardedMessage(record);
		try {
			await this.files.writeNew(messagePath(id, message.id), `${JSON.stringify(record)}\n`);
		} catch (error: unknown) {
			// Re-delivery of the same immutable message is idempotent. Verify it is
			// actually the same record; a conflicting reuse of an ID fails closed.
			const rawExisting = await this.files.read(messagePath(id, message.id));
			if (rawExisting === null) throw error;
			const existing = parseMessage(rawExisting, id);
			if (JSON.stringify(existing) === JSON.stringify(record)) return;
			throw new SyncedStorageError("conflict");
		}
	}
}

function legacySessionPath(id: string): string {
	return `${SESSIONS_FOLDER}/${RecordIdSchema.parse(id)}.jsonl`;
}

function sessionHeaderPath(id: string): string {
	return `${SESSIONS_FOLDER}/${RecordIdSchema.parse(id)}/header.json`;
}

function sessionMessagesFolder(id: string): string {
	return `${SESSIONS_FOLDER}/${RecordIdSchema.parse(id)}/messages`;
}

function messagePath(sessionId: string, messageId: string): string {
	return `${sessionMessagesFolder(sessionId)}/${RecordIdSchema.parse(messageId)}.json`;
}

function parseHeader(content: string | null, expectedSessionId: string): SessionHeaderV1 | null {
	if (content === null) return null;
	try {
		const header = SessionHeaderV1Schema.parse(JSON.parse(content));
		if (header.id !== expectedSessionId) throw new Error("wrong-session");
		return header;
	} catch {
		throw new SyncedStorageError("invalid-record");
	}
}

function parseMessage(content: string | null, expectedSessionId: string): SessionMessageV1 {
	if (content === null) throw new SyncedStorageError("invalid-record");
	try {
		const record = SessionMessageV1Schema.parse(JSON.parse(content));
		if (record.sessionId !== expectedSessionId) throw new Error("wrong-session");
		assertValidShardedMessage(record);
		return record;
	} catch {
		throw new SyncedStorageError("invalid-record");
	}
}

function assertValidShardedMessage(record: SessionMessageV1): void {
	// Legacy JSONL messages predate recordedAt and response provenance, so they
	// remain readable. Every new immutable shard must retain both.
	if (record.recordedAt === undefined) throw new SyncedStorageError("invalid-record");
	if (
		record.message.role === "assistant" &&
		(record.message.provider === undefined || record.message.model === undefined)
	) {
		throw new SyncedStorageError("invalid-record");
	}
}

function parseSessionFile(content: string, expectedSessionId: string): LoadedSession {
	const records = content
		.split(/\r?\n/u)
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return SessionRecordV1Schema.parse(JSON.parse(line));
			} catch {
				throw new SyncedStorageError("invalid-record");
			}
		});
	const headers = records.filter((record) => record.kind === "session");
	const header = headers[0];
	if (
		!header ||
		header.id !== expectedSessionId ||
		headers.some((item) => item.id !== expectedSessionId || !sameHeader(header, item))
	) {
		throw new SyncedStorageError("invalid-record");
	}
	const byMessageId = new Map<string, SessionMessageV1>();
	for (const record of records) {
		if (record.kind !== "message") continue;
		if (record.sessionId !== expectedSessionId) throw new SyncedStorageError("invalid-record");
		const current = byMessageId.get(record.message.id);
		if (current !== undefined && !sameImmutableMessage(current, record)) {
			throw new SyncedStorageError("invalid-record");
		}
		if (!current || compareMessages(record, current) < 0)
			byMessageId.set(record.message.id, record);
	}
	return assembleSession(header, [...byMessageId.values()]);
}

function assembleSession(header: SessionHeaderV1, input: SessionMessageV1[]): LoadedSession {
	const byMessageId = new Map<string, SessionMessageV1>();
	for (const record of input) {
		const current = byMessageId.get(record.message.id);
		if (current !== undefined && !sameImmutableMessage(current, record)) {
			throw new SyncedStorageError("invalid-record");
		}
		if (!current || compareMessages(record, current) < 0)
			byMessageId.set(record.message.id, record);
	}
	const messages = [...byMessageId.values()].sort(compareMessages);
	const updatedAt = messages.reduce((current, record) => {
		const recordedAt = record.recordedAt ?? record.message.createdAt;
		return Date.parse(recordedAt) > Date.parse(current) ? recordedAt : current;
	}, header.updatedAt);
	return { header: { ...header, updatedAt }, messages };
}

function compareMessages(left: SessionMessageV1, right: SessionMessageV1): number {
	const byTime = Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt);
	if (byTime !== 0) return byTime;
	// Independent append shards cannot allocate a shared sequence counter. For
	// simultaneous timestamps retain a stable conversational ordering instead.
	const byRole = roleOrder(left.message.role) - roleOrder(right.message.role);
	if (byRole !== 0) return byRole;
	return left.message.id.localeCompare(right.message.id);
}

function roleOrder(role: AgentMessage["role"]): number {
	return role === "system" ? 0 : role === "user" ? 1 : role === "assistant" ? 2 : 3;
}

function sameHeader(left: SessionHeaderV1, right: SessionHeaderV1): boolean {
	return (
		left.id === right.id &&
		left.sessionKind === right.sessionKind &&
		left.createdAt === right.createdAt
	);
}

function sameImmutableMessage(left: SessionMessageV1, right: SessionMessageV1): boolean {
	return (
		left.sessionId === right.sessionId &&
		JSON.stringify(left.message) === JSON.stringify(right.message)
	);
}
