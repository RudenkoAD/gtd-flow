<script lang="ts">
	import { onMount } from "svelte";
	import {
		AIViewModel,
		connectionLabel,
		errorLabel,
		workLabel,
		type AIViewState,
		type AIViewPort,
	} from "./aiViewModel";

	let { port }: { port: AIViewPort | null } = $props();

	// The ItemView creates this component once per leaf; a later port replacement
	// requires remounting the leaf, just like the other GTD views' mount props.
	// svelte-ignore state_referenced_locally
	const model = new AIViewModel(port);
	let viewState: AIViewState = $state(model.snapshot);
	let questionAnswers = $state<Record<string, string>>({});

	const activeSession = $derived(
		viewState.sessions.find((session) => session.id === viewState.activeSessionId) ?? null,
	);
	const canSend = $derived(
		viewState.activeSessionId !== null &&
			viewState.draft.trim().length > 0 &&
			viewState.connection === "connected" &&
			viewState.work !== "streaming",
	);
	const canCancel = $derived(
		viewState.activeSessionId !== null && viewState.work === "streaming",
	);
	const status = $derived(workLabel(viewState));
	const queueLabel = $derived.by(() => {
		if (viewState.queue.state === "idle") return null;
		if (viewState.queue.state === "processing") {
			return `Processing inbox runs: ${viewState.queue.processingCount}`;
		}
		const state =
			viewState.queue.state === "rate-limited"
				? "Waiting for free capacity"
				: viewState.queue.state === "retry-waiting"
					? "Waiting to retry"
					: "Queued inbox runs";
		const error = viewState.queue.errorCode === null ? "" : ` (${viewState.queue.errorCode})`;
		const retry =
			viewState.queue.nextEligibleAt === null
				? ""
				: ` · retry after ${viewState.queue.nextEligibleAt}`;
		const active =
			viewState.queue.processingCount === 0
				? ""
				: ` · active ${viewState.queue.processingCount}`;
		return `${state}: ${viewState.queue.waitingCount}${active}${error}${retry}`;
	});

	onMount(() => {
		const unsubscribe = model.subscribe((next) => (viewState = next));
		void model.start();
		return () => {
			unsubscribe();
			model.dispose();
		};
	});

	function setDraft(event: Event): void {
		model.setDraft((event.currentTarget as HTMLTextAreaElement).value);
	}

	function submitMessage(event: SubmitEvent): void {
		event.preventDefault();
		if (canSend) void model.send();
	}

	function composerKeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229) return;
		if (event.key === "Escape" && canCancel) {
			event.preventDefault();
			void model.cancel();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (canSend) void model.send();
		}
	}

	function updateQuestionAnswer(questionId: string, event: Event): void {
		questionAnswers = {
			...questionAnswers,
			[questionId]: (event.currentTarget as HTMLInputElement).value,
		};
	}

	function submitQuestion(questionId: string, event: SubmitEvent): void {
		event.preventDefault();
		const answer = questionAnswers[questionId] ?? "";
		void model.answerQuestion(questionId, answer).then((sent) => {
			if (!sent) return;
			questionAnswers = { ...questionAnswers, [questionId]: "" };
		});
	}
</script>

<div class="gtd-ai" aria-label="GTD AI conversation">
	<header class="gtd-ai-header">
		<div>
			<h2>GTD AI</h2>
			<p class="gtd-ai-status" role="status" aria-live="polite">
				{connectionLabel(viewState)}{status === null ? "" : ` · ${status}`}
			</p>
		</div>
		<div class="gtd-ai-header-actions">
			{#if viewState.actualModel !== null}
				<span class="gtd-ai-model" aria-label={`Actual model: ${viewState.actualModel}`}>
					{viewState.actualModel}
				</span>
			{/if}
			{#if viewState.connection === "connected" || viewState.connection === "connecting"}
				<button
					type="button"
					onclick={() => void model.disconnect()}
					disabled={port === null || viewState.connection === "connecting"}
				>
					Disconnect
				</button>
			{:else}
				<button type="button" onclick={() => void model.connect()} disabled={port === null}>
					Connect
				</button>
			{/if}
		</div>
	</header>

	{#if viewState.error !== null}
		<section class="gtd-ai-error" role="alert" aria-label="AI error">
			<strong>{errorLabel(viewState.error)}</strong>
			{#if viewState.error.retryable}
				<span> This action can be retried.</span>
			{/if}
		</section>
	{/if}

	{#if queueLabel !== null}
		<section class="gtd-ai-queue" aria-label="Waiting inbox processing runs">
			<span role="status">{queueLabel}</span>
			{#if viewState.queue.waitingCount > 0}
				<span> Use the command palette to retry waiting AI jobs.</span>
			{/if}
		</section>
	{/if}

	{#if port === null}
		<section class="gtd-ai-setup" aria-label="AI service unavailable">
			The AI service is not available in this plugin session yet. Connect it after AI services
			are configured.
		</section>
	{/if}

	<div class="gtd-ai-layout">
		<aside class="gtd-ai-sessions" aria-label="Conversation sessions">
			<div class="gtd-ai-section-heading">
				<h3>Sessions</h3>
				<button
					type="button"
					onclick={() => void model.createChat()}
					disabled={port === null || viewState.work === "streaming"}
				>
					New chat
				</button>
			</div>
			{#if viewState.sessions.length === 0}
				<p class="gtd-ai-empty">No conversations yet.</p>
			{:else}
				<nav aria-label="Saved conversations">
					<ul class="gtd-ai-session-list">
						{#each viewState.sessions as session (session.id)}
							<li>
								<button
									type="button"
									class:active={session.id === viewState.activeSessionId}
									aria-current={session.id === viewState.activeSessionId
										? "page"
										: undefined}
									disabled={viewState.work === "streaming"}
									onclick={() => void model.selectSession(session.id)}
								>
									<span>{session.title}</span>
									<small>{session.kind === "chat" ? "Chat" : "Inbox run"}</small>
								</button>
							</li>
						{/each}
					</ul>
				</nav>
			{/if}
		</aside>

		<div class="gtd-ai-chat" role="region" aria-label="Conversation">
			<div class="gtd-ai-messages" aria-live="polite" aria-relevant="additions text">
				{#if activeSession === null}
					<p class="gtd-ai-empty">Start a new chat or select a saved session.</p>
				{:else if viewState.messages.length === 0 && viewState.streaming === null}
					<p class="gtd-ai-empty">Ask GTD AI about tasks, projects, or your vault.</p>
				{/if}
				{#each viewState.messages as message (message.id)}
					<article
						class:assistant={message.role === "assistant"}
						class:user={message.role === "user"}
					>
						<header>
							<strong>{message.role === "assistant" ? "GTD AI" : "You"}</strong>
							{#if message.actualModel !== null}
								<span class="gtd-ai-message-model">{message.actualModel}</span>
							{/if}
						</header>
						<div class="gtd-ai-message-content">{message.content}</div>
						{#if message.taskLinks.length > 0}
							<div class="gtd-ai-task-links" aria-label="Related tasks">
								{#each message.taskLinks as task (task.id)}
									<button
										type="button"
										onclick={() => void model.openTask(task.id)}
									>
										Open task: {task.label}
									</button>
								{/each}
							</div>
						{/if}
					</article>
				{/each}
				{#if viewState.streaming !== null}
					<article
						class="assistant gtd-ai-streaming"
						aria-label="Streaming assistant response"
					>
						<header>
							<strong>GTD AI</strong>
							{#if viewState.streaming.actualModel !== null}
								<span class="gtd-ai-message-model"
									>{viewState.streaming.actualModel}</span
								>
							{/if}
						</header>
						<div class="gtd-ai-message-content">{viewState.streaming.content}</div>
					</article>
				{/if}
			</div>

			<form class="gtd-ai-composer" onsubmit={submitMessage}>
				<label for="gtd-ai-composer">Message</label>
				<textarea
					id="gtd-ai-composer"
					rows="3"
					placeholder="Ask GTD AI…"
					value={viewState.draft}
					disabled={port === null ||
						viewState.activeSessionId === null ||
						viewState.connection !== "connected"}
					oninput={setDraft}
					onkeydown={composerKeydown}></textarea>
				<div class="gtd-ai-composer-actions">
					<span>Enter to send · Shift+Enter for a new line · Esc to stop</span>
					{#if canCancel}
						<button type="button" onclick={() => void model.cancel()}>Stop</button>
					{/if}
					<button type="submit" class="mod-cta" disabled={!canSend}>Send</button>
				</div>
			</form>
		</div>
	</div>

	{#if viewState.toolActivity.length > 0}
		<section class="gtd-ai-panel" aria-labelledby="gtd-ai-tools-title">
			<h3 id="gtd-ai-tools-title">Tool activity</h3>
			<ol class="gtd-ai-timeline">
				{#each viewState.toolActivity as activity (activity.id)}
					<li data-state={activity.state}>
						<strong>{activity.name}</strong>
						<span>{activity.state}</span>
						{#if activity.summary !== null}<small>{activity.summary}</small>{/if}
						{#if activity.undoId !== null}
							<button
								type="button"
								onclick={() => void model.undoToolAction(activity.undoId!)}
							>
								Undo
							</button>
						{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if viewState.pendingApprovals.length > 0}
		<section class="gtd-ai-panel" aria-labelledby="gtd-ai-approvals-title">
			<h3 id="gtd-ai-approvals-title">Approval required</h3>
			{#each viewState.pendingApprovals as approval (approval.id)}
				<article class="gtd-ai-approval">
					<div>
						<strong>{approval.title}</strong>
						<span class="gtd-ai-risk">{approval.risk}</span>
						<p>{approval.summary}</p>
					</div>
					{#if approval.taskLinks.length > 0}
						<div class="gtd-ai-task-links" aria-label="Affected tasks">
							{#each approval.taskLinks as task (task.id)}
								<button type="button" onclick={() => void model.openTask(task.id)}>
									Open task: {task.label}
								</button>
							{/each}
						</div>
					{/if}
					<div class="gtd-ai-decision-actions">
						<button
							type="button"
							onclick={() => void model.resolveApproval(approval.id, false)}
						>
							Reject
						</button>
						<button
							type="button"
							class="mod-warning"
							onclick={() => void model.resolveApproval(approval.id, true)}
						>
							Approve
						</button>
					</div>
				</article>
			{/each}
		</section>
	{/if}

	{#if viewState.pendingQuestions.length > 0}
		<section class="gtd-ai-panel" aria-labelledby="gtd-ai-questions-title">
			<h3 id="gtd-ai-questions-title">Inbox questions</h3>
			<p>
				Answers are saved locally. Use “Reprocess task at cursor with AI” when you are ready
				to send them.
			</p>
			{#each viewState.pendingQuestions as question (question.id)}
				<article class="gtd-ai-question">
					<p>{question.text}</p>
					<div class="gtd-ai-question-meta">
						<button type="button" onclick={() => void model.openTask(question.task.id)}>
							Open task: {question.task.label}
						</button>
						<span>Affects: {question.affectedFields.join(", ")}</span>
					</div>
					<form onsubmit={(event) => submitQuestion(question.id, event)}>
						<label for={`gtd-ai-question-${question.id}`}>Your answer</label>
						<input
							id={`gtd-ai-question-${question.id}`}
							type="text"
							value={questionAnswers[question.id] ?? ""}
							oninput={(event) => updateQuestionAnswer(question.id, event)}
						/>
						<button
							type="submit"
							disabled={(questionAnswers[question.id] ?? "").trim().length === 0}
						>
							Answer
						</button>
					</form>
				</article>
			{/each}
		</section>
	{/if}
</div>

<style>
	.gtd-ai {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 10px;
		min-height: 0;
		padding: 10px;
	}
	.gtd-ai-header,
	.gtd-ai-header-actions,
	.gtd-ai-section-heading,
	.gtd-ai-composer-actions,
	.gtd-ai-question-meta,
	.gtd-ai-decision-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.gtd-ai-header {
		justify-content: space-between;
	}
	.gtd-ai-header h2,
	.gtd-ai-section-heading h3,
	.gtd-ai-panel h3 {
		margin: 0;
	}
	.gtd-ai-status,
	.gtd-ai-model,
	.gtd-ai-message-model,
	.gtd-ai-composer-actions,
	.gtd-ai-question-meta,
	.gtd-ai-risk,
	.gtd-ai-timeline small {
		color: var(--text-muted);
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-ai-status {
		margin: 2px 0 0;
	}
	.gtd-ai-model,
	.gtd-ai-risk {
		max-width: 18em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gtd-ai-error,
	.gtd-ai-setup,
	.gtd-ai-queue {
		padding: 8px 10px;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s, 4px);
	}
	.gtd-ai-error {
		border-color: var(--text-error, var(--background-modifier-border));
		color: var(--text-error);
	}
	.gtd-ai-queue {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.gtd-ai-layout {
		display: grid;
		grid-template-columns: minmax(150px, 0.32fr) minmax(0, 1fr);
		flex: 1 1 auto;
		gap: 10px;
		min-height: 260px;
	}
	.gtd-ai-sessions,
	.gtd-ai-chat,
	.gtd-ai-panel {
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s, 4px);
		background: var(--background-secondary);
	}
	.gtd-ai-sessions {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
		overflow: auto;
	}
	.gtd-ai-section-heading {
		justify-content: space-between;
	}
	.gtd-ai-session-list,
	.gtd-ai-timeline {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.gtd-ai-session-list li + li {
		margin-top: 4px;
	}
	.gtd-ai-session-list button {
		display: flex;
		width: 100%;
		justify-content: space-between;
		gap: 6px;
		text-align: left;
	}
	.gtd-ai-session-list button.active {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}
	.gtd-ai-session-list small {
		white-space: nowrap;
	}
	.gtd-ai-chat {
		display: flex;
		min-width: 0;
		flex-direction: column;
		overflow: hidden;
	}
	.gtd-ai-messages {
		display: flex;
		min-height: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 8px;
		overflow: auto;
		padding: 10px;
	}
	.gtd-ai-messages article,
	.gtd-ai-approval,
	.gtd-ai-question {
		padding: 8px;
		border-radius: var(--radius-s, 4px);
		background: var(--background-primary);
	}
	.gtd-ai-messages article.user {
		margin-left: 10%;
	}
	.gtd-ai-messages article.assistant {
		margin-right: 10%;
		background: var(--background-modifier-hover);
	}
	.gtd-ai-messages article header {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
	.gtd-ai-message-content {
		margin-top: 4px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.gtd-ai-task-links {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 8px;
	}
	.gtd-ai-task-links button {
		font-size: var(--font-ui-smaller, 0.85em);
	}
	.gtd-ai-composer {
		padding: 8px;
		border-top: 1px solid var(--background-modifier-border);
	}
	.gtd-ai-composer label,
	.gtd-ai-question label {
		display: block;
		margin-bottom: 4px;
	}
	.gtd-ai-composer textarea {
		box-sizing: border-box;
		width: 100%;
		resize: vertical;
	}
	.gtd-ai-composer-actions {
		justify-content: space-between;
		margin-top: 5px;
	}
	.gtd-ai-panel {
		padding: 10px;
	}
	.gtd-ai-panel > * + * {
		margin-top: 8px;
	}
	.gtd-ai-timeline li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 2px 8px;
		padding: 6px 0 6px 10px;
		border-left: 2px solid var(--interactive-accent);
	}
	.gtd-ai-timeline li[data-state="failed"] {
		border-left-color: var(--text-error);
	}
	.gtd-ai-timeline small {
		grid-column: 1 / -1;
	}
	.gtd-ai-approval,
	.gtd-ai-question {
		border: 1px solid var(--background-modifier-border);
	}
	.gtd-ai-approval + .gtd-ai-approval,
	.gtd-ai-question + .gtd-ai-question {
		margin-top: 8px;
	}
	.gtd-ai-approval p,
	.gtd-ai-question p {
		margin: 5px 0;
	}
	.gtd-ai-risk {
		margin-left: 6px;
		text-transform: uppercase;
	}
	.gtd-ai-decision-actions {
		justify-content: flex-end;
		margin-top: 8px;
	}
	.gtd-ai-question form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		margin-top: 8px;
	}
	.gtd-ai-question form label {
		grid-column: 1 / -1;
	}
	.gtd-ai-empty {
		margin: 12px 0;
		color: var(--text-muted);
		text-align: center;
	}
	@media (max-width: 620px) {
		.gtd-ai-layout {
			grid-template-columns: 1fr;
		}
		.gtd-ai-sessions {
			max-height: 180px;
		}
		.gtd-ai-messages article.user,
		.gtd-ai-messages article.assistant {
			margin-right: 0;
			margin-left: 0;
		}
	}
</style>
