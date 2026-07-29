import type { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultAdapter } from "../../adapters/VaultAdapter";
import { ESTIMATE_FIELDS } from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import { parseTaskLine } from "../../core/parser/parseTaskLine";
import type { BoardService } from "../../services/BoardService";
import type { ProjectService } from "../../services/ProjectService";
import { ScopeCatalogService } from "../../services/ScopeCatalogService";
import { WritebackService } from "../../services/WritebackService";
import { FakeFeed } from "../../stores/testSupport";
import { AiPluginServices } from "./AiPluginServices";

const INBOX = "GTD/Inbox.md";
const TASK_ID = "task-1";
const TEST_CREDENTIAL = "integration-only-openrouter-secret";
const SELECTED_MODEL = "free/integration-model";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AiPluginServices production composition", () => {
	it("durably retries a 429 through the real provider path and preserves AI ownership after restart", async () => {
		const vault = new ObsidianMemoryVault({
			[INBOX]: `- [ ] Prepare quarterly review 🆔 ${TASK_ID}\n`,
		});
		const app = createApp(vault);
		const clock = new MutableClock("2026-07-29T08:00:00.000Z");
		const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> =
			[];
		let responseNumber = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init === undefined) throw new Error("missing-request-init");
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			requests.push({ url: String(input), init, body });
			responseNumber += 1;
			if (responseNumber === 1) {
				return new Response(null, {
					status: 429,
					headers: { "retry-after": "1" },
				});
			}
			return completionResponse({
				tasks: [
					{
						taskId: TASK_ID,
						durationMinutes: 90,
						intensity: { cognitive: 4, emotional: 2, physical: 1 },
						scopeId: "work",
						confidence: {
							duration: 0.9,
							cognitive: 0.8,
							emotional: 0.7,
							physical: 0.8,
							scope: 0.95,
						},
						questions: [],
					},
				],
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const first = await createComposition(app, vault, clock);
		await first.services.credentials.set(TEST_CREDENTIAL);

		const initial = await first.services.process();

		expect(initial).toMatchObject({
			state: "rate_limited",
			applied: 0,
			actualModel: null,
			nextEligibleAt: "2026-07-29T08:00:01.000Z",
		});
		expect(initial.runId).not.toBeNull();
		const parentRunId = initial.runId!;
		await expect(first.services.runs.get(parentRunId)).resolves.toMatchObject({
			state: "rate_limited",
			attempt: 1,
			nextEligibleAt: "2026-07-29T08:00:01.000Z",
			actualModel: null,
			error: {
				code: "rate-limited",
				statusCode: 429,
				retryable: true,
				retryAfterMs: 1_000,
			},
		});
		await expect(first.services.queueStatus()).resolves.toEqual({
			waitingCount: 1,
			processingCount: 0,
			state: "rate-limited",
			nextEligibleAt: "2026-07-29T08:00:01.000Z",
			errorCode: "rate-limited",
		});

		clock.advance(2_000);
		await first.services.retryWaiting();

		const runs = await first.services.runs.list();
		expect(runs).toHaveLength(2);
		expect(runs.find((run) => run.id === parentRunId)).toMatchObject({
			state: "superseded",
			attempt: 1,
		});
		const child = runs.find((run) => run.retryOfRunId === parentRunId);
		expect(child).toMatchObject({
			state: "completed",
			attempt: 2,
			actualModel: SELECTED_MODEL,
			error: null,
			nextEligibleAt: null,
		});
		await expect(first.services.queueStatus()).resolves.toEqual({
			waitingCount: 0,
			processingCount: 0,
			state: "idle",
			nextEligibleAt: null,
			errorCode: null,
		});

		const liveTask = readInboxTasks(vault)[0]!;
		expect(liveTask).toMatchObject({
			taskId: TASK_ID,
			durationMinutes: 90,
			cognitiveIntensity: 4,
			emotionalIntensity: 2,
			physicalIntensity: 1,
			scopeId: "work",
		});
		expect(vault.data.get(INBOX)).toBe(
			`- [ ] Prepare quarterly review 🆔 ${TASK_ID} ⏱ 90m 🧠 4 💓 2 💪 1 🧭 work\n`,
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const request of requests) {
			expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
			expect(request.body).toMatchObject({
				model: "openrouter/free",
				stream: false,
				provider: { require_parameters: true },
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "inbox-processing-v1",
						strict: true,
					},
				},
			});
			expect(requestHeader(request.init.headers, "authorization")).toBe(
				`Bearer ${TEST_CREDENTIAL}`,
			);
		}

		const childSession = await first.services.sessions.load(child!.sessionId);
		expect(childSession.header.sessionKind).toBe("inbox-processing");
		expect(childSession.messages.map((record) => record.message.role).sort()).toEqual([
			"assistant",
			"user",
		]);
		expect(
			childSession.messages.find((record) => record.message.role === "assistant")?.message,
		).toMatchObject({
			provider: "openrouter",
			model: SELECTED_MODEL,
			createdAt: "2026-07-29T08:00:02.000Z",
		});
		const feedback = await first.services.history.readAll();
		expect(feedback.invalidPaths).toEqual([]);
		expect(feedback.events).toHaveLength(1);
		expect(feedback.events[0]).toMatchObject({
			kind: "estimate-suggested",
			taskId: TASK_ID,
			runId: child!.id,
			sessionId: child!.sessionId,
			actualModel: SELECTED_MODEL,
			provider: "openrouter",
			promptVersion: "inbox-estimator-v1",
			schemaVersionId: "inbox-processing-v1",
			appliedFields: ESTIMATE_FIELDS,
		});
		await expect(first.services.history.outboxHealth()).resolves.toEqual({
			pending: 0,
			conflicts: 0,
			invalidRecords: 0,
		});
		expect(serializedVault(vault)).not.toContain(TEST_CREDENTIAL);

		const requestsBeforeRestart = fetchMock.mock.calls.length;
		const restarted = await createComposition(app, vault, clock);
		expect(await restarted.services.credentials.get()).toBeNull();
		await restarted.services.reconcileOwnership();

		expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeRestart);
		const provenance = await restarted.services.history.provenanceForTask(
			TASK_ID,
			clock.now().toISOString(),
		);
		for (const field of ESTIMATE_FIELDS) {
			expect(provenance.fields[field]).toMatchObject({
				owner: "ai",
				locked: false,
				lastPredictionEventId: feedback.events[0]!.id,
			});
		}
		await expect(restarted.services.history.readAll()).resolves.toMatchObject({
			invalidPaths: [],
			events: feedback.events,
		});
		expect(serializedVault(vault)).not.toContain(TEST_CREDENTIAL);
	});

	it("disconnect aborts active inbox processing before clearing the memory credential", async () => {
		const vault = new ObsidianMemoryVault({
			[INBOX]: `- [ ] Prepare quarterly review 🆔 ${TASK_ID}\n`,
		});
		const app = createApp(vault);
		const clock = new MutableClock("2026-07-29T08:00:00.000Z");
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						requestSignal = init?.signal ?? undefined;
						const rejectAborted = (): void => {
							reject(new DOMException("Aborted", "AbortError"));
						};
						if (requestSignal?.aborted) rejectAborted();
						else
							requestSignal?.addEventListener("abort", rejectAborted, { once: true });
					}),
			),
		);
		const { services } = await createComposition(app, vault, clock);
		await services.credentials.set(TEST_CREDENTIAL);

		const processing = services.process();
		await vi.waitFor(() => expect(requestSignal).toBeDefined());
		await services.view.disconnect();

		expect(requestSignal?.aborted).toBe(true);
		expect(await services.credentials.get()).toBeNull();
		await expect(processing).resolves.toMatchObject({ state: "cancelled" });
	});
});

interface MemoryFile {
	path: string;
	extension: string;
}

class ObsidianMemoryVault {
	readonly data = new Map<string, string>();
	private readonly folders = new Set<string>();

	constructor(files: Readonly<Record<string, string>>) {
		for (const [path, content] of Object.entries(files)) {
			this.data.set(path, content);
			this.addParentFolders(path);
		}
	}

	getFileByPath(path: string): MemoryFile | null {
		return this.data.has(path) ? memoryFile(path) : null;
	}

	getAbstractFileByPath(path: string): MemoryFile | { path: string } | null {
		return this.getFileByPath(path) ?? (this.folders.has(path) ? { path } : null);
	}

	getFiles(): MemoryFile[] {
		return [...this.data.keys()].sort().map(memoryFile);
	}

	getMarkdownFiles(): MemoryFile[] {
		return this.getFiles().filter((target) => target.extension === "md");
	}

	async cachedRead(target: MemoryFile): Promise<string> {
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		return content;
	}

	async read(target: MemoryFile): Promise<string> {
		return this.cachedRead(target);
	}

	async process(target: MemoryFile, transform: (content: string) => string): Promise<void> {
		const content = this.data.get(target.path);
		if (content === undefined) throw new Error(`vault-file-not-found:${target.path}`);
		this.data.set(target.path, transform(content));
	}

	async createFolder(path: string): Promise<void> {
		this.addFolder(path);
	}

	async create(path: string, content: string): Promise<MemoryFile> {
		if (this.data.has(path)) throw new Error(`vault-file-exists:${path}`);
		this.addParentFolders(path);
		this.data.set(path, content);
		return memoryFile(path);
	}

	async delete(target: MemoryFile): Promise<void> {
		this.data.delete(target.path);
	}

	private addParentFolders(path: string): void {
		const parts = path.split("/");
		parts.pop();
		for (let length = 1; length <= parts.length; length++) {
			this.folders.add(parts.slice(0, length).join("/"));
		}
	}

	private addFolder(path: string): void {
		const parts = path.split("/");
		for (let length = 1; length <= parts.length; length++) {
			this.folders.add(parts.slice(0, length).join("/"));
		}
	}
}

class MutableClock {
	private currentMs: number;

	constructor(iso: string) {
		this.currentMs = Date.parse(iso);
	}

	now = (): Date => new Date(this.currentMs);

	advance(ms: number): void {
		this.currentMs += ms;
	}
}

async function createComposition(
	app: App,
	memoryVault: ObsidianMemoryVault,
	clock: MutableClock,
): Promise<{ services: AiPluginServices }> {
	const vault = new VaultAdapter(app);
	const tasks = (): Task[] => readInboxTasks(memoryVault);
	const scopes = new ScopeCatalogService(vault, {
		countTasksWithScope: (scopeId) => tasks().filter((task) => task.scopeId === scopeId).length,
	});
	const loaded = await scopes.load();
	if (!loaded.exists) {
		await scopes.initialize([
			{ id: "work", name: "Work", order: 0, archived: false },
			{ id: "life", name: "Life", order: 1, archived: false },
		]);
	}
	const feed = new FakeFeed();
	feed.replaceFile(INBOX, tasks());
	let writeId = 0;
	const dispatcher = new WritebackService({
		write: vault,
		feed,
		autoInjectId: true,
		genId: () => `write-${++writeId}`,
	});
	let id = 0;
	const services = new AiPluginServices({
		app,
		vault,
		dispatcher,
		scopes,
		projects: {} as ProjectService,
		boards: {} as BoardService,
		allTasks: tasks,
		inboxFile: () => INBOX,
		ensureInbox: (path) => vault.ensureFile(path),
		enabled: () => true,
		privacyPolicy: () => "account-policy",
		credentialStorage: () => "memory-only",
		durationLongStyle: () => "whole-days",
		openTask: async () => undefined,
		openAiView: async () => undefined,
		now: clock.now,
		createId: () => `id-${++id}`,
	});
	return { services };
}

function createApp(vault: ObsidianMemoryVault): App {
	return {
		vault,
		fileManager: {
			processFrontMatter: async () => {
				throw new Error("unexpected-frontmatter-write");
			},
		},
	} as unknown as App;
}

function readInboxTasks(vault: ObsidianMemoryVault): Task[] {
	const content = vault.data.get(INBOX);
	if (content === undefined) return [];
	const tasks: Task[] = [];
	for (const [lineStart, rawLine] of content.split("\n").entries()) {
		const task = parseTaskLine(rawLine, {
			filePath: INBOX,
			lineStart,
			parentLine: null,
			heading: null,
			container: "inbox",
			projectActive: true,
		});
		if (task !== null) tasks.push(task);
	}
	return tasks;
}

function completionResponse(result: unknown): Response {
	return new Response(
		JSON.stringify({
			id: "response-success",
			model: SELECTED_MODEL,
			choices: [
				{
					message: { role: "assistant", content: JSON.stringify(result) },
					finish_reason: "stop",
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function requestHeader(headers: HeadersInit | undefined, name: string): string | null {
	return new Headers(headers).get(name);
}

function memoryFile(path: string): MemoryFile {
	return { path, extension: path.split(".").pop() ?? "" };
}

function serializedVault(vault: ObsidianMemoryVault): string {
	return JSON.stringify(
		[...vault.data.entries()].sort(([left], [right]) => left.localeCompare(right)),
	);
}
