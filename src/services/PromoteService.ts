/**
 * PromoteService — «всплытие отложенной задачи во Входящие» (фидбек:
 * promoteTo="inbox"). Когда 🛫 задачи наступает САМА (перешагнута смена дня или
 * пропущенный откат при старте), пользователь ожидает задачу именно во
 * настроенный единый файл входящих, а не «где лежала» (это поведение
 * promoteTo="origin", при котором сервис не пишет НИЧЕГО — чистое всплытие §5).
 *
 * Проход промоушена (образец RecurrenceService.runPass): чистый planPromotions
 * отбирает задачи с наступившей 🛫 → сервис исполняет план существующими
 * интентами в порядке «снять 🛫 → снять теги досок → (при needsMove) перенести
 * в inbox-файл». Снятие 🛫 = тот же интент, что пункт меню тикля «Вернуть во
 * входящие» (set-date field:"start" date:null); оно же — маркер идемпотентности:
 * после него start === null ⇒ задача больше не кандидат.
 *
 * Ноль импортов obsidian: запись — через IntentDispatcher, цель/создание
 * единый inbox-файл и его создание инжектируются, как
 * spawnTargetFor/ensureFile у RecurrenceService.
 */
import type { IsoDate, Task } from "../core/model/Task";
import {
	planPromotions,
	type PlannedPromotion,
	type PromotionRetry,
} from "../core/tickler/promote";
import type { IndexFeed } from "./types";
import type { EnsureTaskIdResult, IntentDispatcher } from "./WritebackService";

export interface PromoteReport {
	/** Сколько задач полностью промоутнуто (все шаги успешны). */
	promoted: number;
	/** Из них перенесено строкой в inbox-файл (needsMove). */
	moved: number;
	/** Диагностика по отказавшим шагам (задача осталась частично обработанной). */
	errors: string[];
}

export interface PromotePort {
	/** spawn-подобный проход: сериализован мьютексом; до готовности индекса и вне
	 *  режима "inbox" — no-op с пустым отчётом. */
	runPass(): Promise<PromoteReport>;
}

export interface PromoteDeps {
	feed: IndexFeed;
	dispatcher: IntentDispatcher;
	todayIso: () => IsoDate;
	indexReady: () => boolean;
	/** Режим возврата отложенной + скоуп входящих (settings.promoteTo,
	 *  settings.inboxIncludePlain). "origin" ⇒ проход не пишет ничего. Тип
	 *  структурный (сервис не тянет формат Settings, как RecurrenceService). */
	settings: () => { promoteTo: "origin" | "inbox"; includePlain: boolean };
	/** Configured unified inbox file. */
	inboxTargetFor: (task: Task) => string;
	/** Убедиться, что целевой файл существует и помечен gtd-inbox. */
	ensureInboxFile: (path: string, task: Task) => Promise<boolean>;
	/** Последний обработанный день (персист, settings.promoteLastRun); null — проходов
	 *  ещё не было. Кандидаты каждого прохода — start ∈ (lastRun, today]. */
	lastRun: () => IsoDate | null;
	/** Персист последнего обработанного дня (продвигается КАЖДЫМ проходом,
	 *  независимо от режима — включение "inbox" позже не сметает origin-бэклог).
	 * Не вызывается, пока хотя бы одна promotion-операция не подтверждена. */
	setLastRun: (day: IsoDate) => Promise<void>;
	/** Обязательная стабилизация id специально для многошагового promotion. Не
	 * зависит от настройки autoInjectId: журнал должен пережить рестарт процесса. */
	ensureTaskId: (key: string) => Promise<EnsureTaskIdResult>;
	/** Долговечный журнал незавершённых операций. Запись сохраняется ДО первой
	 * мутации строки и удаляется только после подтверждения финального состояния. */
	promotionRetries: () => readonly PromotionRetry[];
	setPromotionRetries: (retries: readonly PromotionRetry[]) => Promise<void>;
}

export class PromoteService implements PromotePort {
	/**
	 * Мьютекс всех проходов: перекрывающиеся вызовы (onReady + откат дня в один
	 * момент) сериализуются, а не гонятся за одни и те же строки. Второй проход
	 * по актуальному индексу естественно пуст (🛫 уже снят), по устаревшему —
	 * даёт line-not-found без записей. Тот же приём, что у RecurrenceService.
	 */
	private mutex: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: PromoteDeps) {}

	async runPass(): Promise<PromoteReport> {
		return this.locked(() => this.runPassInner());
	}

	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.mutex.then(fn, fn);
		this.mutex = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async runPassInner(): Promise<PromoteReport> {
		const report: PromoteReport = { promoted: 0, moved: 0, errors: [] };
		// до полной сборки индекса кандидаты неполны — как гейт §6 у регулярных
		if (!this.deps.indexReady()) return report;
		const today = this.deps.todayIso();
		const last = this.deps.lastRun();

		// Journalled work is always attempted first, including on the same day and
		// after the user has switched the policy back to "origin".  Otherwise a
		// line whose start marker was already removed would become invisible to the
		// normal planner forever.
		const retryPlan = this.retryPlan(report);
		const retryIds = retryPlan.taskIds;
		for (const retry of retryPlan.executable) {
			if (await this.resumeRetry(retry, report)) report.promoted++;
		}
		if (this.deps.promotionRetries().length > 0) {
			// The error is already specific above where possible.  This guard also
			// covers a failed journal cleanup, which must not permit checkpointing.
			if (report.errors.length === 0) report.errors.push("promotion retry is still pending");
		}

		// первый проход в жизни хранилища «усыновляет» сегодняшний день БЕЗ обработки:
		// исторический бэклог давно наступивших 🛫 не сметается массовой перезаписью
		// (ревью) — старые задачи продолжают всплывать чистой деривацией на месте
		if (last === null) {
			if (report.errors.length === 0) await this.deps.setLastRun(today);
			return report;
		}
		if (last >= today) return report; // журнал выше уже попробовали
		const s = this.deps.settings();
		// "origin" — прежнее поведение §5 (ноль записей), но день продвигаем: смена
		// режима на "inbox" позже не должна ретроспективно обработать origin-период
		if (s.promoteTo !== "inbox") {
			if (report.errors.length === 0) await this.deps.setLastRun(today);
			return report;
		}

		const plan = planPromotions(this.deps.feed.getIndex().all(), today, {
			includePlain: s.includePlain,
			since: last,
		});
		for (const p of plan) {
			// A reindexed retry is also present in this window.  It was handled from
			// its durable entry above, so never run a second, stale plan for it.
			if (p.task.taskId !== null && retryIds.has(p.task.taskId)) continue;
			if (await this.promoteOne(p, report)) report.promoted++;
		}
		if (report.errors.length === 0 && this.deps.promotionRetries().length === 0)
			await this.deps.setLastRun(today);
		return report;
	}

	/**
	 * First anchor the task with an id and persist a retry record.  Every following
	 * write is individually idempotent, so a restart after *any* substep resumes
	 * from the journal rather than depending on the start marker still existing.
	 */
	private async promoteOne(p: PlannedPromotion, report: PromoteReport): Promise<boolean> {
		const anchored = await this.deps.ensureTaskId(p.task.key);
		if (!anchored.ok) {
			report.errors.push(`ensure-id ${p.task.key}: ${anchored.reason}`);
			return false;
		}
		const retry: PromotionRetry = {
			taskId: anchored.taskId,
			source: p.task.filePath,
			target: p.needsMove ? this.deps.inboxTargetFor(p.task) : null,
		};
		if (!(await this.rememberRetry(retry, report))) return false;
		return this.applyPromotion(p.task, p.stripTags, retry, report);
	}

	/** Replay one persisted operation against the current index. */
	private async resumeRetry(retry: PromotionRetry, report: PromoteReport): Promise<boolean> {
		const carriers = this.deps.feed.getIndex().resolveDep(retry.taskId);
		if (carriers.length === 0) {
			report.errors.push(`promotion retry ${retry.taskId}: task-not-found`);
			return false;
		}
		let task: Task | undefined;
		if (retry.target === null) {
			if (carriers.length === 1) task = carriers[0];
		} else {
			const inTarget = carriers.filter((carrier) => carrier.filePath === retry.target);
			const inSource = carriers.filter((carrier) => carrier.filePath === retry.source);
			if (inTarget.length <= 1 && inSource.length === 1) task = inSource[0];
			else if (inTarget.length === 1 && inSource.length === 0 && carriers.length === 1)
				task = inTarget[0];
		}
		if (task === undefined) {
			report.errors.push(`promotion retry ${retry.taskId}: duplicate-id-conflict`);
			return false;
		}
		return this.applyPromotion(task, boardTagsOf(task), retry, report);
	}

	/** Execute each write in a journalled operation.  The journal record is removed
	 * only after all postconditions are confirmed by successful write calls. */
	private async applyPromotion(
		task: Task,
		stripTags: readonly string[],
		retry: PromotionRetry,
		report: PromoteReport,
	): Promise<boolean> {
		const key = task.key;
		if (retry.target !== null && retry.source === retry.target) {
			report.errors.push(`move-line ${key}: same-file`);
			return false;
		}
		const clear = await this.deps.dispatcher.dispatch({
			type: "set-date",
			key,
			field: "start",
			date: null,
		});
		if (!clear.ok) return this.promotionError(report, `clear-start ${key}`, clear);

		if (stripTags.length > 0) {
			const strip = await this.deps.dispatcher.dispatch({
				type: "move-column",
				key,
				fromTag: null,
				toTag: null,
				fromTags: [...stripTags],
			});
			if (!strip.ok) return this.promotionError(report, `strip-tags ${key}`, strip);
		}

		if (retry.target !== null && task.filePath !== retry.target) {
			if (!(await this.deps.ensureInboxFile(retry.target, task))) {
				report.errors.push(`ensure-inbox ${key}: ${retry.target}`);
				return false;
			}
			const moved = await this.deps.dispatcher.dispatch({
				type: "move-line",
				key,
				toFile: retry.target,
			});
			if (!moved.ok) return this.promotionError(report, `move-line ${key}`, moved);
			report.moved++;
		}

		if (!(await this.forgetRetry(retry.taskId, report))) return false;
		return true;
	}

	private promotionError(
		report: PromoteReport,
		operation: string,
		result: { ok: false; reason: string },
	): false {
		report.errors.push(`${operation}: ${result.reason}`);
		return false;
	}

	private retryPlan(report: PromoteReport): {
		executable: PromotionRetry[];
		taskIds: Set<string>;
	} {
		const byId = new Map<string, PromotionRetry>();
		const conflictingIds = new Set<string>();
		for (const retry of this.deps.promotionRetries()) {
			const previous = byId.get(retry.taskId);
			if (previous === undefined) {
				byId.set(retry.taskId, retry);
				continue;
			}
			if (previous.target !== retry.target || previous.source !== retry.source) {
				conflictingIds.add(retry.taskId);
			}
		}
		for (const taskId of conflictingIds) {
			report.errors.push(`promotion retry ${taskId}: journal-conflict`);
		}
		return {
			executable: [...byId.values()].filter((retry) => !conflictingIds.has(retry.taskId)),
			// Every persisted retry suppresses the normal planner.  In particular,
			// corrupted conflicting entries must not fall through to a fresh move.
			taskIds: new Set(byId.keys()),
		};
	}

	private async rememberRetry(retry: PromotionRetry, report: PromoteReport): Promise<boolean> {
		const current = this.deps.promotionRetries();
		const conflicting = current.find(
			(entry) =>
				entry.taskId === retry.taskId &&
				(entry.target !== retry.target || entry.source !== retry.source),
		);
		if (conflicting !== undefined) {
			report.errors.push(`promotion retry ${retry.taskId}: target-conflict`);
			return false;
		}
		if (current.some((entry) => entry.taskId === retry.taskId)) return true;
		try {
			await this.deps.setPromotionRetries([...current, retry]);
			return true;
		} catch (error) {
			report.errors.push(`remember-promotion ${retry.taskId}: ${errorMessage(error)}`);
			return false;
		}
	}

	private async forgetRetry(taskId: string, report: PromoteReport): Promise<boolean> {
		try {
			await this.deps.setPromotionRetries(
				this.deps.promotionRetries().filter((retry) => retry.taskId !== taskId),
			);
			return true;
		} catch (error) {
			report.errors.push(`complete-promotion ${taskId}: ${errorMessage(error)}`);
			return false;
		}
	}
}

function boardTagsOf(task: Task): string[] {
	return task.tags
		.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
		.filter((tag) => tag.startsWith("#kanban/"));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
