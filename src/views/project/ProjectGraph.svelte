<script lang="ts">
	import { Menu, Modal, Notice, type App } from "obsidian";
	import {
		SvelteFlow,
		useSvelteFlow,
		type Connection,
		type Edge,
		type Node,
		type NodeTypes,
	} from "@xyflow/svelte";
	import type { Task } from "../../core/model/Task";
	import type { IntentDispatcher } from "../../services/WritebackService";
	import type { TaskStore } from "../../stores/taskStore";
	import { openTaskInFile } from "../common/openTask";
	import { elkAutoLayout } from "./elkLayout";
	import { ensureFlowStyles } from "./flowStyles.css";
	import type { ProjectModel, ProjectPort } from "../../services/ProjectService";
	import {
		criticalEdgeIds,
		criticalPathIds,
		issueLabel,
		toFlowEdges,
		toFlowNodes,
		unblockedByDelete,
	} from "./projectGraphLogic";
	import TaskNode from "./TaskNode.svelte";

	let {
		path,
		port,
		dispatcher,
		taskStore,
		app,
	}: {
		path: string;
		port: ProjectPort;
		dispatcher: IntentDispatcher;
		taskStore: TaskStore;
		app: App;
	} = $props();

	// props фиксированы на время монтирования (вид пересоздаётся с leaf)
	// svelte-ignore state_referenced_locally
	const epoch = taskStore.epoch;
	// svelte-ignore state_referenced_locally
	const today = taskStore.today;

	const nodeTypes: NodeTypes = { task: TaskNode as unknown as NodeTypes[string] };

	let container: HTMLElement | null = $state(null);
	let criticalOn = $state(false);
	let showIssues = $state(false);
	let layouting = $state(false);
	/** Позиции призраков — только сессия: frontmatter layout их не хранит
	 *  (normalizeLayout выбрасывает не-членов), поэтому храним локально. */
	let ghostPos = $state<Record<string, { x: number; y: number }>>({});

	const flow = useSvelteFlow();

	// CSS Svelte Flow — в document вида (pop-out имеет свой document, ТЗ §8)
	$effect(() => {
		if (container === null) return;
		return ensureFlowStyles(container.ownerDocument);
	});

	const model = $derived.by((): ProjectModel | null => {
		void $epoch; // модель живёт в индексе — пересборка на каждую его смену
		return port.model(path);
	});
	const ghostIds = $derived(new Set((model?.nodes ?? []).filter((n) => n.ghost).map((n) => n.id)));
	const issues = $derived(model?.issues ?? []);

	// тема Obsidian — класс на body документа вида
	const colorMode = $derived(
		container?.ownerDocument.body.classList.contains("theme-dark") ? "dark" : "light",
	);

	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);

	$effect(() => {
		const m = model;
		if (m === null) {
			nodes = [];
			edges = [];
			return;
		}
		nodes = buildFlowNodes(m);
		edges = buildFlowEdges(m);
	});

	function buildFlowNodes(m: ProjectModel): Node[] {
		const crit = criticalOn ? criticalPathIds(m) : null;
		return toFlowNodes(m).map((vm) => {
			const sessionPos = vm.data.ghost ? ghostPos[vm.id] : undefined;
			return {
				id: vm.id,
				type: "task",
				position: sessionPos ?? { x: vm.x, y: vm.y },
				draggable: true,
				connectable: !vm.data.ghost, // авторинг рёбер — только между членами (ТЗ §7)
				deletable: false, // удаление — только через write-back с подтверждением
				data: {
					...vm.data,
					critical: crit?.has(vm.id) ?? false,
					toggle: () => void toggleStatus(vm.data.task),
				},
			};
		});
	}

	function buildFlowEdges(m: ProjectModel): Edge[] {
		const crit = criticalOn ? criticalEdgeIds(m) : null;
		return toFlowEdges(m).map((e) => ({
			...e,
			...(crit?.has(e.id) === true ? { class: "gtd-edge-critical", animated: true } : {}),
		}));
	}

	// --- write-back: единая точка, отказ — уведомление ---

	async function toggleStatus(task: Task): Promise<void> {
		const isDone = task.statusChar === "x" || task.statusChar === "X";
		const res = await dispatcher.dispatch(
			isDone
				? { type: "set-status", key: task.key, statusChar: " " }
				: { type: "set-status", key: task.key, statusChar: "x", date: $today },
		);
		if (!res.ok) new Notice(`GTD Flow: ${res.reason}`);
	}

	// --- рисование рёбер: live-проверка циклов при протяжке ---

	function isValidConnection(conn: Edge | Connection): boolean {
		const source = String(conn.source);
		const target = String(conn.target);
		if (source === target) return false;
		if (ghostIds.has(source) || ghostIds.has(target)) return false;
		return port.wouldCreateCycle(path, source, target) === null;
	}

	function onConnect(conn: Connection): void {
		void (async () => {
			const res = await port.connect(path, conn.source, conn.target);
			if (!res.ok) {
				const cycle =
					res.cyclePath !== undefined && res.cyclePath.length > 0
						? ` Цикл: ${res.cyclePath.join(" → ")}`
						: "";
				new Notice(`GTD Flow: ребро отклонено — ${res.reason ?? "ошибка"}.${cycle}`);
				// записи не было (epoch не сдвинется) — откатываем оптимистичное ребро вручную
				const m = model;
				edges = m === null ? [] : buildFlowEdges(m);
			}
		})();
	}

	// --- drag узлов: батч позиций за жест ---

	function onNodeDragStop({ nodes: dragged }: { nodes: Node[] }): void {
		if (dragged.length === 0) return;
		const ghostMoves = dragged.filter((n) => ghostIds.has(n.id));
		if (ghostMoves.length > 0) {
			const next = { ...ghostPos };
			for (const g of ghostMoves) next[g.id] = { x: g.position.x, y: g.position.y };
			ghostPos = next;
		}
		const moves = dragged
			.filter((n) => !ghostIds.has(n.id))
			.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
		if (moves.length > 0) void port.moveNodes(path, moves);
	}

	// --- разрыв ребра: клик/контекст → меню-подтверждение ---

	function openEdgeMenu(edge: Edge, event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(`Разорвать зависимость ${edge.source} → ${edge.target}`)
				.setIcon("unlink")
				.onClick(() => {
					void (async () => {
						const res = await port.disconnect(path, edge.source, edge.target);
						if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "не удалось разорвать"}`);
					})();
				}),
		);
		menu.showAtMouseEvent(event);
	}

	// --- контекстное меню узла ---

	function openNodeMenu(node: Node, event: MouseEvent): void {
		const data = node.data as unknown as { task: Task; ghost: boolean };
		const menu = new Menu();
		if (!data.ghost) {
			const isDone = data.task.statusChar === "x" || data.task.statusChar === "X";
			menu.addItem((item) =>
				item
					.setSection("status")
					.setTitle(isDone ? "Открыть заново" : "Выполнено")
					.setIcon(isDone ? "rotate-ccw" : "check")
					.onClick(() => void toggleStatus(data.task)),
			);
		}
		menu.addItem((item) =>
			item
				.setSection("nav")
				.setIcon("file-text")
				.setTitle("Открыть в файле")
				.onClick(() => void openTaskInFile(app, data.task)),
		);
		if (!data.ghost) {
			const m = model;
			const est = m === null ? 0 : unblockedByDelete(m, node.id);
			menu.addItem((item) =>
				item
					.setSection("danger")
					.setIcon("trash-2")
					.setTitle(est > 0 ? `Удалить узел (разблокирует ${est})…` : "Удалить узел…")
					.onClick(() => confirmDeleteNode(node.id, data.task, est)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	function confirmDeleteNode(id: string, task: Task, est: number): void {
		const text =
			`Удалить «${task.description}» из проекта? Строка будет удалена из файла, ` +
			`id вычищен из всех ⛔ и layout.` +
			(est > 0 ? ` Это разблокирует задач: ${est}.` : "");
		new ConfirmModal(app, "Удалить узел", text, "Удалить", () => {
			void (async () => {
				const res = await port.deleteNode(path, id);
				if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "не удалось удалить"}`);
				else if (res.unblocked !== undefined && res.unblocked > 0)
					new Notice(`GTD Flow: разблокировано задач: ${res.unblocked}`);
			})();
		}).open();
	}

	// --- кнопки тулбара ---

	async function autoLayoutNow(): Promise<void> {
		const m = model;
		if (m === null || layouting) return;
		layouting = true;
		try {
			const inputs = nodes.map((n) => {
				const w = n.measured?.width;
				const h = n.measured?.height;
				return {
					id: n.id,
					...(w !== undefined ? { width: w } : {}),
					...(h !== undefined ? { height: h } : {}),
				};
			});
			const moves = await elkAutoLayout(inputs, m.edges);
			const ghostMoves = moves.filter((mv) => ghostIds.has(mv.id));
			if (ghostMoves.length > 0) {
				const next = { ...ghostPos };
				for (const g of ghostMoves) next[g.id] = { x: g.x, y: g.y };
				ghostPos = next;
			}
			// оптимистично двигаем локальные узлы: fitView ниже должен мерить УЖЕ
			// новую раскладку, а подтверждение из индекса придёт позже (дебаунс)
			const moveById = new Map(moves.map((mv) => [mv.id, mv]));
			nodes = nodes.map((n) => {
				const mv = moveById.get(n.id);
				return mv === undefined ? n : { ...n, position: { x: mv.x, y: mv.y } };
			});
			const memberMoves = moves.filter((mv) => !ghostIds.has(mv.id));
			// один батч MoveNode за нажатие — откатывается одной правкой файла (ТЗ §7)
			if (memberMoves.length > 0) await port.moveNodes(path, memberMoves);
			await flow.fitView({ padding: 0.2, duration: 200 });
		} finally {
			layouting = false;
		}
	}

	function fitViewNow(): void {
		void flow.fitView({ padding: 0.2, duration: 200 });
	}

	function addTask(): void {
		new TextPromptModal(app, "Новая задача проекта", (text) => {
			const pos = viewportCenterFlowPos();
			void (async () => {
				const res = await port.addNode(path, text, pos.x, pos.y);
				if (!res.ok) new Notice(`GTD Flow: ${res.reason ?? "не удалось добавить"}`);
			})();
		}).open();
	}

	/** Центр видимой области в координатах графа (минус полразмера узла). */
	function viewportCenterFlowPos(): { x: number; y: number } {
		if (container === null) return { x: 0, y: 0 };
		const r = container.getBoundingClientRect();
		const p = flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
		return { x: p.x - 120, y: p.y - 40 };
	}

	// --- модалки (паттерн common/DatePromptModal) ---

	class ConfirmModal extends Modal {
		constructor(
			modalApp: App,
			private readonly promptTitle: string,
			private readonly text: string,
			private readonly okLabel: string,
			private readonly onOk: () => void,
		) {
			super(modalApp);
		}

		override onOpen(): void {
			this.titleEl.setText(this.promptTitle);
			this.contentEl.createEl("p", { text: this.text });
			const row = this.contentEl.createDiv();
			row.style.display = "flex";
			row.style.gap = "8px";
			row.style.justifyContent = "flex-end";
			const cancel = row.createEl("button", { text: "Отмена" });
			cancel.addEventListener("click", () => this.close());
			const ok = row.createEl("button", { text: this.okLabel, cls: "mod-warning" });
			ok.addEventListener("click", () => {
				this.close();
				this.onOk();
			});
		}

		override onClose(): void {
			this.contentEl.empty();
		}
	}

	class TextPromptModal extends Modal {
		constructor(
			modalApp: App,
			private readonly promptTitle: string,
			private readonly onSubmit: (text: string) => void,
		) {
			super(modalApp);
		}

		override onOpen(): void {
			this.titleEl.setText(this.promptTitle);
			const wrap = this.contentEl.createDiv();
			wrap.style.display = "flex";
			wrap.style.gap = "8px";
			const input = wrap.createEl("input", { type: "text" });
			input.style.flex = "1 1 auto";
			input.placeholder = "Описание задачи";
			const submit = (): void => {
				const value = input.value.trim();
				if (value === "") return;
				this.close();
				this.onSubmit(value);
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
			});
			const ok = wrap.createEl("button", { text: "Добавить", cls: "mod-cta" });
			ok.addEventListener("click", submit);
			input.focus();
		}

		override onClose(): void {
			this.contentEl.empty();
		}
	}
</script>

<div class="gtd-project-graph">
	<div class="gtd-pg-toolbar">
		<button onclick={addTask} title="Добавить задачу в проект">＋ Задача</button>
		<button onclick={() => void autoLayoutNow()} disabled={layouting} title="Разложить граф (elk, слева направо)">
			Авто-layout
		</button>
		<button onclick={fitViewNow} title="Вписать граф в окно">Вписать</button>
		<button
			class:is-active={criticalOn}
			onclick={() => (criticalOn = !criticalOn)}
			title="Подсветить самую длинную невыполненную цепочку"
		>
			Критический путь
		</button>
		<span class="gtd-pg-spacer"></span>
		{#if issues.length > 0}
			<button
				class="gtd-pg-issues-btn"
				class:is-active={showIssues}
				onclick={() => (showIssues = !showIssues)}
				title="Проблемы графа"
			>
				⚠ {issues.length}
			</button>
		{/if}
	</div>

	<div class="gtd-pg-canvas" bind:this={container}>
		{#if showIssues && issues.length > 0}
			<div class="gtd-pg-issues">
				{#each issues as issue, i (i)}
					<div class="gtd-pg-issue">{issueLabel(issue)}</div>
				{/each}
			</div>
		{/if}
		<SvelteFlow
			bind:nodes
			bind:edges
			{nodeTypes}
			{colorMode}
			fitView
			minZoom={0.1}
			deleteKey={null}
			{isValidConnection}
			onconnect={onConnect}
			onnodedragstop={onNodeDragStop}
			onnodecontextmenu={({ node, event }) => openNodeMenu(node, event)}
			onedgeclick={({ edge, event }) => openEdgeMenu(edge, event)}
			onedgecontextmenu={({ edge, event }) => {
				event.preventDefault();
				openEdgeMenu(edge, event);
			}}
		/>
	</div>
</div>

<style>
	.gtd-project-graph {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.gtd-pg-toolbar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--background-modifier-border);
	}
	.gtd-pg-toolbar button {
		font-size: var(--font-ui-smaller, 0.85em);
		padding: 2px 8px;
	}
	.gtd-pg-toolbar button.is-active {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}
	.gtd-pg-spacer {
		flex: 1 1 auto;
	}
	.gtd-pg-issues-btn {
		color: var(--text-warning, var(--text-muted));
	}
	.gtd-pg-canvas {
		flex: 1 1 auto;
		min-height: 0;
		position: relative;
	}
	.gtd-pg-issues {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 10;
		max-width: 340px;
		max-height: 50%;
		overflow-y: auto;
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-m, 8px);
		box-shadow: var(--shadow-s, 0 2px 8px rgba(0, 0, 0, 0.15));
		padding: 8px 10px;
	}
	.gtd-pg-issue {
		font-size: var(--font-ui-smaller, 0.85em);
		color: var(--text-muted);
		padding: 3px 0;
	}
	.gtd-pg-issue + .gtd-pg-issue {
		border-top: 1px solid var(--background-modifier-border);
	}
	/* критический путь: рёбра */
	.gtd-pg-canvas :global(.svelte-flow__edge.gtd-edge-critical .svelte-flow__edge-path) {
		stroke: var(--color-orange, #e5892a);
		stroke-width: 3;
	}
	/* полотно наследует фон темы */
	.gtd-pg-canvas :global(.svelte-flow) {
		background: var(--background-primary);
	}
</style>
