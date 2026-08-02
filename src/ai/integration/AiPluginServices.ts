import type { App } from "obsidian";
import { ESTIMATE_FIELDS, type EstimateField } from "../../core/estimates/provenance";
import type { LongDurationStyle } from "../../core/estimates/format";
import type { Task } from "../../core/model/Task";
import { isActiveScopeId } from "../../core/scope/scope";
import type { VaultAdapter } from "../../adapters/VaultAdapter";
import type { ScopeCatalogService } from "../../services/ScopeCatalogService";
import type { BoardService } from "../../services/BoardService";
import type { ProjectService } from "../../services/ProjectService";
import {
	type EstimateFieldSuggestedEvent,
	feedbackTaskSnapshot,
} from "../../services/EstimateFeedbackService";
import type { EstimateFeedbackService } from "../../services/EstimateFeedbackService";
import type { EstimateMemoryService } from "../../services/EstimateMemoryService";
import type { FieldOwnershipMonitor } from "../../services/FieldOwnershipMonitor";
import {
	AI_FEEDBACK_INSPECTION_LIMIT,
	MetadataServices,
	type AiFeedbackInspection,
	type MetadataFeedbackSummary,
	type MetadataServicesBridge,
} from "../../services/MetadataServices";
import type { TaskMetadataService } from "../../services/TaskMetadataService";
import type { WritebackService } from "../../services/WritebackService";
import { MemoryCredentialStore } from "../auth/MemoryCredentialStore";
import { OpenRouterOAuthConnection } from "../auth/DesktopOpenRouterOAuth";
import { AgentRuntime } from "../core/AgentRuntime";
import { AIError } from "../core/errors";
import { AIViewController, type AIConnectionPort, type AIQueuePort } from "./AIViewController";
import type { AIViewQueueStatus } from "../../views/ai/aiViewModel";
import { DesktopTaskMetadataActions } from "./DesktopTaskMetadataActions";
import { GtdToolPortsAdapter, type PreparedAiMetadataMutation } from "./GtdToolPortsAdapter";
import { InboxTaskAdapter } from "./InboxTaskAdapter";
import { RepositoryProcessingPersistence } from "./ProcessingPersistence";
import {
	InboxProcessor,
	type ProcessInboxRequest,
	type ProcessInboxSummary,
} from "../processing/InboxProcessor";
import {
	DEFAULT_PROCESSING_STALE_AFTER_MS,
	DurableQueueCoordinator,
} from "../processing/DurableQueueCoordinator";
import { QuestionService } from "../processing/QuestionService";
import type { ProviderPrivacyPolicy } from "../providers/AIProviderPort";
import { OpenRouterProvider } from "../providers/OpenRouterProvider";
import { RunRepository } from "../storage/RunRepository";
import { SessionRepository } from "../storage/SessionRepository";
import { createGtdToolRegistry } from "../tools/gtdTools";
import type { ToolExecutionContext } from "../tools/ToolRegistry";

export interface DesktopAiServicesOptions {
	app: App;
	vault: VaultAdapter;
	dispatcher: WritebackService;
	scopes: ScopeCatalogService;
	projects: ProjectService;
	boards: BoardService;
	allTasks(): readonly Task[];
	inboxFile(): string;
	ensureInbox(path: string): Promise<void>;
	enabled(): boolean;
	privacyPolicy(): ProviderPrivacyPolicy | null;
	credentialStorage(): "memory-only" | null;
	durationLongStyle(): LongDurationStyle | null;
	openTask(task: Task): Promise<void>;
	openAiView(): Promise<void>;
	now?: () => Date;
	createId?: () => string;
	metadataServices?: MetadataServicesBridge;
}

/** @deprecated Use `DesktopAiServicesOptions`. */
export type AiPluginServicesOptions = DesktopAiServicesOptions;

export {
	AI_FEEDBACK_INSPECTION_LIMIT,
	type AiFeedbackInspection,
	type AiFeedbackInspectionEvent,
	type AiFeedbackInspectionField,
} from "../../services/MetadataServices";

/**
 * Composition root for the desktop AI slice. Keeping it outside `main.ts`
 * makes the credential/provider boundary and every synced repository visible
 * in one place, while commands and views receive only narrow service facades.
 */
export class DesktopAiServices {
	readonly credentials = new MemoryCredentialStore();
	readonly sessions: SessionRepository;
	readonly runs: RunRepository;
	readonly history: EstimateFeedbackService;
	readonly memory: EstimateMemoryService;
	readonly processor: InboxProcessor;
	readonly queue: DurableQueueCoordinator;
	readonly questions: QuestionService;
	readonly view: AIViewController;
	readonly metadata: TaskMetadataService;
	readonly ownership: FieldOwnershipMonitor;
	readonly metadataServices: MetadataServicesBridge;

	private readonly now: () => Date;
	private readonly createId: () => string;
	private readonly processingControllers = new Set<AbortController>();

	constructor(private readonly options: DesktopAiServicesOptions) {
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? (() => crypto.randomUUID());

		this.sessions = new SessionRepository(options.vault);
		this.runs = new RunRepository(options.vault);
		this.metadataServices =
			options.metadataServices ??
			new MetadataServices({
				vault: options.vault,
				dispatcher: options.dispatcher,
				scopes: options.scopes,
				allTasks: options.allTasks,
				durationLongStyle: options.durationLongStyle,
				now: this.now,
				createId: this.createId,
			});
		this.history = this.metadataServices.history;
		this.memory = this.metadataServices.memory;
		this.ownership = this.metadataServices.ownership;
		this.metadata = this.metadataServices.taskMetadata;

		const rawConnection = new OpenRouterOAuthConnection(this.credentials);
		const connection: AIConnectionPort = {
			isConnected: () => rawConnection.isConnected(),
			connect: async (signal) => {
				this.requireConfiguration();
				await rawConnection.connect(signal);
			},
			disconnect: (signal) => rawConnection.disconnect(signal),
		};
		const provider = new OpenRouterProvider({
			getApiKey: () => this.credentials.get(),
			privacyPolicy: () => this.requireConfiguration(),
			now: this.now,
		});
		const runtime = new AgentRuntime(provider);

		const taskPort = new InboxTaskAdapter({
			allTasks: options.allTasks,
			inboxFile: options.inboxFile,
			dispatcher: options.dispatcher,
			expectAiPatch: (taskId, patch) => this.ownership.expectAiPatch(taskId, patch),
		});
		const persistence = new RepositoryProcessingPersistence(this.sessions, this.runs);
		this.processor = new InboxProcessor({
			runtime,
			tasks: taskPort,
			scopes: async () => options.scopes.current(),
			persistence,
			history: this.history,
			examples: this.memory,
			now: this.now,
			createId: this.createId,
		});

		const guardedProcessor = {
			process: (request?: ProcessInboxRequest) => this.process(request),
		};
		this.questions = new QuestionService({
			history: this.history,
			findTask: (taskId) => this.findTask(taskId),
			now: this.now,
			createId: this.createId,
		});
		const tools = createGtdToolRegistry(
			new GtdToolPortsAdapter({
				app: options.app,
				vault: options.vault,
				dispatcher: options.dispatcher,
				allTasks: options.allTasks,
				inboxFile: options.inboxFile,
				ensureInbox: options.ensureInbox,
				isActiveScope: (scopeId) => isActiveScopeId(options.scopes.current(), scopeId),
				assertAiPatchAllowed: async (taskId, patch) => {
					await this.reconcileOwnership();
					const provenance = await this.history.provenanceForTask(
						taskId,
						this.now().toISOString(),
					);
					const locked = ESTIMATE_FIELDS.filter(
						(field) =>
							Object.prototype.hasOwnProperty.call(patch, field) &&
							(provenance.fields[field].locked ||
								provenance.fields[field].owner === "user"),
					);
					if (locked.length > 0) {
						throw new Error(`task-metadata-locked:${locked.join(",")}`);
					}
				},
				expectAiPatch: (taskId, patch) => this.ownership.expectAiPatch(taskId, patch),
				prepareAiMetadataMutation: (task, patch, context) =>
					this.prepareChatMetadataMutation(task, patch, context),
				scopeCatalog: () => options.scopes.current(),
				projects: options.projects,
				boards: options.boards,
				currentRun: async () => {
					const latest = (await this.runs.list()).at(-1);
					return latest === undefined ? { found: false } : { found: true, run: latest };
				},
			}),
			this.createId,
		);
		this.queue = new DurableQueueCoordinator({
			runs: this.runs,
			processor: guardedProcessor,
			findTask: (taskId) => this.findTask(taskId),
			now: this.now,
		});
		const queueViewPort: AIQueuePort = {
			status: () => this.queueStatus(),
		};
		this.view = new AIViewController({
			runtime,
			sessions: this.sessions,
			tools,
			connection,
			questions: this.questions,
			queue: queueViewPort,
			cancelInboxProcessing: () => {
				this.cancelProcessing();
			},
			openTask: async (taskId) => {
				const task = this.findTask(taskId);
				if (task === null) throw new Error("task-not-found");
				await options.openTask(task);
			},
			taskLink: (taskId) => {
				const task = this.findTask(taskId);
				return task === null
					? null
					: { id: taskId, label: task.description.slice(0, 80) || taskId };
			},
			now: this.now,
			createId: this.createId,
		});
		this.metadataServices.attachAiActions(
			new DesktopTaskMetadataActions({
				dispatcher: options.dispatcher,
				history: this.history,
				processor: guardedProcessor,
				scopes: () => options.scopes.current(),
				openSession: (sessionId) => this.openSession(sessionId),
				now: this.now,
			}),
		);
	}

	observeTasks(): void {
		this.metadataServices.observeTasks();
	}

	/**
	 * Reconcile edits made while the plugin was closed or on another device.
	 * Existing values without AI history are conservatively user-owned.
	 */
	reconcileOwnership(): Promise<void> {
		return this.metadataServices.reconcileOwnership();
	}

	async process(request: ProcessInboxRequest = {}): Promise<ProcessInboxSummary> {
		const controller = new AbortController();
		const externalSignal = request.signal;
		const forwardExternalAbort = (): void => controller.abort();
		this.processingControllers.add(controller);
		if (externalSignal?.aborted) {
			controller.abort();
		} else {
			externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
		}
		try {
			await this.requireProviderReady();
			await this.reconcileOwnership();
			return await this.processor.process({ ...request, signal: controller.signal });
		} finally {
			externalSignal?.removeEventListener("abort", forwardExternalAbort);
			this.processingControllers.delete(controller);
			await this.refreshViewSafely();
		}
	}

	/**
	 * Explicit command path for one task. Persisted question answers constrain
	 * only their linked, still-AI-owned fields and never start this work alone.
	 */
	async reprocessTask(task: Task): Promise<ProcessInboxSummary> {
		const context =
			task.taskId === null ? null : await this.questions.reprocessContext(task.taskId);
		return this.process({
			taskKeys: [task.key],
			...(context === null ? {} : context),
		});
	}

	/** Aborts every active or locally queued inbox-processing invocation. */
	cancelProcessing(): number {
		let cancelled = 0;
		for (const controller of this.processingControllers) {
			if (controller.signal.aborted) continue;
			controller.abort();
			cancelled += 1;
		}
		return cancelled;
	}

	async retryWaiting(): Promise<ProcessInboxSummary[]> {
		try {
			await this.requireProviderReady();
			await this.reconcileOwnership();
			return await this.queue.retryEligible();
		} finally {
			await this.refreshViewSafely();
		}
	}

	/** Durable queue inspection for the embedded view; it never contacts OpenRouter. */
	async queueStatus(): Promise<AIViewQueueStatus> {
		const runs = await this.runs.list();
		const staleBefore = this.now().getTime() - DEFAULT_PROCESSING_STALE_AFTER_MS;
		const activeProcessing = runs.filter(
			(run) => run.state === "processing" && Date.parse(run.updatedAt) > staleBefore,
		);
		const waiting = runs
			.filter(
				(run) =>
					run.state === "queued" ||
					(run.state === "processing" && Date.parse(run.updatedAt) <= staleBefore) ||
					run.state === "rate_limited" ||
					run.state === "retry_waiting",
			)
			.sort((left, right) => {
				const leftAt = left.nextEligibleAt ?? left.updatedAt;
				const rightAt = right.nextEligibleAt ?? right.updatedAt;
				return Date.parse(leftAt) - Date.parse(rightAt) || left.id.localeCompare(right.id);
			});
		const selected = waiting[0];
		return {
			waitingCount: waiting.length,
			processingCount: activeProcessing.length,
			state:
				selected?.state === "rate_limited"
					? "rate-limited"
					: selected?.state === "retry_waiting"
						? "retry-waiting"
						: selected === undefined
							? activeProcessing.length > 0
								? "processing"
								: "idle"
							: "queued",
			nextEligibleAt: selected?.nextEligibleAt ?? null,
			errorCode: selected?.error?.code ?? null,
		};
	}

	async openSession(sessionId: string): Promise<void> {
		await this.view.selectSession(sessionId);
		await this.options.openAiView();
	}

	async openLastRun(): Promise<boolean> {
		const runs = await this.runs.list();
		const latest = runs.at(-1);
		if (!latest) return false;
		await this.openSession(latest.sessionId);
		return true;
	}

	feedbackSummary(): Promise<MetadataFeedbackSummary> {
		return this.metadataServices.feedbackSummary();
	}

	/**
	 * Returns a bounded, display-only view of recent learning events. Arbitrary
	 * task/question text, paths, provider metadata, and run/session identifiers
	 * never cross this boundary. Identifier-like values are allowlisted and
	 * credential-shaped strings are redacted before Settings can render them.
	 */
	feedbackInspection(
		requestedLimit: number = AI_FEEDBACK_INSPECTION_LIMIT,
	): Promise<AiFeedbackInspection> {
		return this.metadataServices.feedbackInspection(requestedLimit);
	}

	exportFeedback(): Promise<string> {
		return this.metadataServices.exportFeedback();
	}

	clearFeedbackConfirmed(): Promise<number> {
		return this.metadataServices.clearFeedbackConfirmed();
	}

	async dispose(): Promise<void> {
		this.cancelProcessing();
		this.metadataServices.attachAiActions(null);
		await this.credentials.clear();
	}

	private requireConfiguration(): ProviderPrivacyPolicy {
		const privacy = this.options.privacyPolicy();
		if (
			!this.options.enabled() ||
			this.options.credentialStorage() !== "memory-only" ||
			privacy === null
		) {
			throw configurationError();
		}
		return privacy;
	}

	private findTask(taskId: string): Task | null {
		return this.options.allTasks().find((task) => task.taskId === taskId) ?? null;
	}

	private async refreshViewSafely(): Promise<void> {
		const view = (this as { view?: AIViewController }).view;
		if (view === undefined) return;
		try {
			await view.refresh();
		} catch (error: unknown) {
			console.warn("GTD Flow: AI view refresh failed", errorName(error));
		}
	}

	private async requireProviderReady(): Promise<ProviderPrivacyPolicy> {
		const privacy = this.requireConfiguration();
		if ((await this.credentials.get()) === null) throw authenticationError();
		return privacy;
	}

	private async prepareChatMetadataMutation(
		task: Task,
		patch: AiMetadataPatch,
		context: ToolExecutionContext | undefined,
	): Promise<PreparedAiMetadataMutation> {
		if (task.taskId === null) throw new Error("ai-tool-task-id-required");
		if (
			context === undefined ||
			context.sessionId.trim() === "" ||
			context.actualModel.trim() === ""
		) {
			throw new Error("ai-tool-context-required");
		}
		const appliedFields = metadataPatchFields(patch);
		if (appliedFields.length === 0) throw new Error("ai-tool-metadata-patch-empty");
		const createdAt = this.now().toISOString();
		const events = appliedFields.map((field): EstimateFieldSuggestedEvent => ({
			schemaVersion: 1,
			id: safeId(`${this.createId()}_${field}`),
			kind: "estimate-field-suggested",
			taskId: task.taskId!,
			createdAt,
			runId: null,
			sessionId: context.sessionId,
			field,
			value: patch[field] ?? null,
			taskSnapshot: feedbackTaskSnapshot(task),
			confidence: 0,
			actualModel: context.actualModel,
			provider: "openrouter",
			promptVersion: "chat-tools-v1",
			schemaVersionId: "chat-tool-metadata-v1",
			retrievedExampleIds: [],
		}));
		const prepared: EstimateFieldSuggestedEvent[] = [];
		try {
			for (const event of events) {
				await this.history.prepareMutation(event, [
					{
						field: event.field,
						previousValue: taskFieldValue(task, event.field),
						intendedValue: event.value,
					},
				]);
				prepared.push(event);
			}
		} catch (error: unknown) {
			try {
				await settlePreparedEvents(prepared, (event) =>
					this.history.cancelPrepared(event.id),
				);
			} catch {
				// Unchanged Markdown lets startup recovery cancel the remaining
				// prepared records; preserve the original prepare failure.
			}
			throw error;
		}
		return {
			commit: async () => {
				await settlePreparedEvents(events, (event) =>
					this.history.commitPrepared(event.id),
				);
			},
			cancel: async () => {
				await settlePreparedEvents(events, (event) =>
					this.history.cancelPrepared(event.id),
				);
			},
		};
	}
}

/** @deprecated Use `DesktopAiServices`; retained for the existing desktop entrypoint. */
export class AiPluginServices extends DesktopAiServices {}

type AiMetadataPatch = Partial<Record<EstimateField, number | string | null>>;

function metadataPatchFields(patch: AiMetadataPatch): EstimateField[] {
	return ESTIMATE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

async function settlePreparedEvents<T>(
	events: readonly T[],
	action: (event: T) => Promise<unknown>,
): Promise<void> {
	let firstError: unknown;
	for (const event of events) {
		try {
			await action(event);
		} catch (error: unknown) {
			firstError ??= error;
		}
	}
	if (firstError !== undefined) throw firstError;
}

function taskFieldValue(task: Task, field: EstimateField): number | string | null {
	switch (field) {
		case "duration":
			return task.durationMinutes;
		case "cognitive":
			return task.cognitiveIntensity;
		case "emotional":
			return task.emotionalIntensity;
		case "physical":
			return task.physicalIntensity;
		case "scope":
			return task.scopeId;
	}
}

function safeId(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
	return /^[A-Za-z0-9]/u.test(normalized) ? normalized : `id_${normalized}`;
}

function configurationError(): AIError {
	return new AIError({
		code: "configuration",
		retryable: false,
		retryAfterMs: null,
		statusCode: null,
	});
}

function authenticationError(): AIError {
	return new AIError({
		code: "authentication",
		retryable: false,
		retryAfterMs: null,
		statusCode: null,
	});
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "UnknownError";
}
