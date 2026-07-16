/**
 * PromoteService — «всплытие отложенной задачи во Входящие» (фидбек:
 * promoteTo="inbox"). Когда 🛫 задачи наступает САМА (перешагнута смена дня или
 * пропущенный откат при старте), пользователь ожидает задачу именно во
 * «Входящих» своего пространства, а не «где лежала» (это старое поведение
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
 * inbox-файла пространства инжектируются (main.ts подставляет nsTargetPath /
 * ensureCaptureFileNs), как spawnTargetFor/ensureFile у RecurrenceService.
 */
import type { IsoDate, Task } from "../core/model/Task";
import { planPromotions, type PlannedPromotion } from "../core/tickler/promote";
import type { IndexFeed } from "./types";
import type { IntentDispatcher } from "./WritebackService";

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
	/** Целевой inbox-файл ПРОСТРАНСТВА задачи (nsTargetPath / captureTargetInNamespace). */
	inboxTargetFor: (task: Task) => string;
	/** Убедиться, что целевой файл существует и помечен gtd-inbox (+ ns-override
	 *  для файла-исключения). Совместимо с ensureCaptureFileNs. false — не удалось. */
	ensureInboxFile: (path: string, task: Task) => Promise<boolean>;
	/** Последний обработанный день (персист, settings.promoteLastRun); null — проходов
	 *  ещё не было. Кандидаты каждого прохода — start ∈ (lastRun, today]. */
	lastRun: () => IsoDate | null;
	/** Персист последнего обработанного дня (продвигается КАЖДЫМ проходом,
	 *  независимо от режима — включение "inbox" позже не сметает origin-бэклог). */
	setLastRun: (day: IsoDate) => Promise<void>;
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
		// первый проход в жизни хранилища «усыновляет» сегодняшний день БЕЗ обработки:
		// исторический бэклог давно наступивших 🛫 не сметается массовой перезаписью
		// (ревью) — старые задачи продолжают всплывать чистой деривацией на месте
		if (last === null) {
			await this.deps.setLastRun(today);
			return report;
		}
		if (last >= today) return report; // день уже обработан
		const s = this.deps.settings();
		// "origin" — прежнее поведение §5 (ноль записей), но день продвигаем: смена
		// режима на "inbox" позже не должна ретроспективно обработать origin-период
		if (s.promoteTo !== "inbox") {
			await this.deps.setLastRun(today);
			return report;
		}

		const plan = planPromotions(this.deps.feed.getIndex().all(), today, {
			includePlain: s.includePlain,
			since: last,
		});
		for (const p of plan) {
			if (await this.promoteOne(p, report)) report.promoted++;
		}
		await this.deps.setLastRun(today);
		return report;
	}

	/**
	 * Порядок шагов важен:
	 *  1) снять 🛫 (интент «Вернуть во входящие») — первый и главный: задача
	 *     перестаёт быть отложенной; на двух устройствах раннее снятие 🛫 сужает
	 *     окно, в котором второе устройство ещё видит её кандидатом;
	 *  2) снять теги колонок досок — иначе hasBoardTag прячет из входящих;
	 *  3) перенос в inbox-файл (только needsMove) — СТРОГО последним: он двигает
	 *     физическую строку, после чего индекс отстаёт и адресация шагов 1–2 по
	 *     ключу целилась бы уже в исходный (пустой) файл. move-line сам вписывает
	 *     🆔 и пропускает append при уже присутствующем 🆔 (идемпотентность повтора).
	 *
	 * Любой отказ прерывает задачу и копится в errors: неполная обработка
	 * безопасна (потери строки нет — move-line атомарен пофайлово), пользователь
	 * может перетащить карточку вручную. false ⇒ задача не засчитана promoted.
	 */
	private async promoteOne(p: PlannedPromotion, report: PromoteReport): Promise<boolean> {
		const key = p.task.key;

		// 1. снять 🛫 — тот же интент, что «Вернуть во входящие» в меню тикля
		const clr = await this.deps.dispatcher.dispatch({
			type: "set-date",
			key,
			field: "start",
			date: null,
		});
		if (!clr.ok) {
			report.errors.push(`clear-start ${key}: ${clr.reason}`);
			return false;
		}

		// 2. снять теги колонок досок (если есть)
		if (p.stripTags.length > 0) {
			const strip = await this.deps.dispatcher.dispatch({
				type: "move-column",
				key,
				fromTag: null,
				toTag: null,
				fromTags: p.stripTags,
			});
			if (!strip.ok) {
				report.errors.push(`strip-tags ${key}: ${strip.reason}`);
				return false;
			}
		}

		// 3. перенос в inbox-файл пространства — только если на месте задача
		//    осталась бы скрытой формулой входящих (board / plain без includePlain)
		if (p.needsMove) {
			const target = this.deps.inboxTargetFor(p.task);
			if (!(await this.deps.ensureInboxFile(target, p.task))) {
				report.errors.push(`ensure-inbox ${key}: ${target}`);
				return false;
			}
			const mv = await this.deps.dispatcher.dispatch({ type: "move-line", key, toFile: target });
			if (!mv.ok) {
				report.errors.push(`move-line ${key}: ${mv.reason}`);
				return false;
			}
			report.moved++;
		}
		return true;
	}
}
