/**
 * Отложенный ящик (ТЗ §5): чистое разбиение задач на active / deferred / done.
 * «Всплытие» — ноль записей: today перешагнул start ⇒ задача сама попадает в active
 * при следующем пересчёте. Функция чистая и идемпотентная: повторное разбиение
 * объединения корзин даёт тот же результат.
 */
import type { IsoDate, Task } from "../model/Task";
import { deriveGtdState, isCancelled, isDone, type ResolveDep } from "../model/gtdState";

export interface TicklerPartition {
	/** Живые задачи (ACTIVE/DOING/WAITING/BLOCKED — всё, что не закрыто и не отложено). */
	active: Task[];
	/** В тикле: 🛫 start > today (state TICKLER). */
	deferred: Task[];
	/** Закрытые: DONE и CANCELLED. */
	done: Task[];
}

/**
 * TEMPLATE и DETAIL не попадают ни в одну корзину — по §1 они невидимы
 * для глобальных проекций (только виды «Регулярные» и карточка).
 * Порядок внутри корзин = порядок входа (сортировка — забота QueryEngine).
 */
export function partition(
	tasks: Iterable<Task>,
	today: IsoDate,
	resolveDep: ResolveDep,
): TicklerPartition {
	const active: Task[] = [];
	const deferred: Task[] = [];
	const done: Task[] = [];
	for (const t of tasks) {
		const state = deriveGtdState(t, today, resolveDep);
		if (state === "TEMPLATE" || state === "DETAIL") continue;
		if (state === "DONE" || state === "CANCELLED") done.push(t);
		else if (state === "TICKLER") deferred.push(t);
		else active.push(t);
	}
	return { active, deferred, done };
}

// ---------------------------------------------------------------------------
// «Всплытие во входящие» (promoteTo="inbox") — фидбек: когда 🛫 наступает сама,
// задача должна прийти именно во «Входящие» своего пространства, а не просто
// остаться на месте (это старое поведение promoteTo="origin").
// ---------------------------------------------------------------------------

const BOARD_TAG_PREFIX = "#kanban/";

/** Скоуп входящих (settings.inboxIncludePlain) — от него зависит, нужен ли
 *  перенос plain-задачи в inbox-файл (см. isInInbox в QueryEngine). */
export interface PromotionConfig {
	/** Активные plain-задачи видны во «Входящих» без переноса. */
	includePlain: boolean;
	/**
	 * Нижняя граница (исключительно): кандидаты — только start ∈ (since, today].
	 * null — границы нет (исторический режим; сервис так НЕ зовёт: первый проход
	 * усыновляет сегодняшний день без обработки, иначе включение promoteTo="inbox"
	 * ретроспективно смело бы ВЕСЬ бэклог давно наступивших 🛫 массовой перезаписью).
	 */
	since: IsoDate | null;
}

/** План промоушена одной задачи, чья 🛫 НАСТУПИЛА (см. planPromotions). Сервис
 *  исполняет его существующими интентами: снятие тегов, «Вернуть во входящие»
 *  (set-date start=null) и, при needsMove, перенос строки в inbox-файл. */
export interface PlannedPromotion {
	task: Task;
	/** Теги колонок досок ('#kanban/…') к снятию; [] — снимать нечего. Иначе
	 *  hasBoardTag прячет задачу из входящих даже после переноса. */
	stripTags: string[];
	/** Переносить ли строку в inbox-файл пространства задачи, чтобы формула
	 *  входящих (isInInbox) её показала: контейнер board (скрыт всегда) либо
	 *  plain при includePlain=false. Контейнеры inbox/project видны на месте. */
	needsMove: boolean;
}

/**
 * Durable journal entry for a promotion that may span several file writes.
 * `target === null` means the task only needs its source-line cleanup; otherwise
 * the final durable postcondition is one carrier in this inbox file.
 */
export interface PromotionRetry {
	taskId: string;
	/** Source path at journal creation.  Distinguishes a completed move from an
	 * invalid attempt to use the source itself as its configured inbox target. */
	source: string;
	target: string | null;
}

/** Теги колонок досок на задаче, нормализованные к ведущему '#'. */
function boardTagsOf(t: Task): string[] {
	return t.tags
		.map((tag) => (tag.startsWith("#") ? tag : "#" + tag))
		.filter((tag) => tag.startsWith(BOARD_TAG_PREFIX));
}

/**
 * План «всплытия во входящие» для задач, чья 🛫 наступила: start задан и уже
 * НЕ в будущем (start <= today — строго `>` держит задачу в тикле, см. isDeferred),
 * задача жива (не done/cancelled) и её контейнер вообще виден в тикле
 * (plain/inbox/board/project; шаблоны/карточки/события/архив не всплывают).
 *
 * Идемпотентность (образец RecurrenceService — детерминированное условие, ложное
 * после действия): исполнение плана снимает 🛫 (start становится null), поэтому
 * на следующем проходе задача уже НЕ кандидат. Двойной вызов до реиндекса
 * безвреден — интенты по перенесённой строке дают line-not-found без записи.
 *
 * Чистая функция: ноль записей, только решение. Скоуп входящих (includePlain)
 * определяет, достаточно ли снять теги на месте или нужен перенос в inbox-файл.
 */
export function planPromotions(
	tasks: Iterable<Task>,
	today: IsoDate,
	cfg: PromotionConfig,
): PlannedPromotion[] {
	const out: PlannedPromotion[] = [];
	for (const t of tasks) {
		if (isDone(t) || isCancelled(t)) continue;
		// контейнеры вне тикля (§1: TEMPLATE/DETAIL/EVENT/ARCHIVED) не всплывают
		if (
			t.container === "recurring" ||
			t.container === "card" ||
			t.container === "events" ||
			t.container === "archive"
		)
			continue;
		if (t.start === null || t.start > today) continue; // не отложена / ещё не наступила
		if (cfg.since !== null && t.start <= cfg.since) continue; // наступила ДО окна прохода
		const needsMove = t.container === "board" || (t.container === "plain" && !cfg.includePlain);
		out.push({ task: t, stripTags: boardTagsOf(t), needsMove });
	}
	return out;
}
