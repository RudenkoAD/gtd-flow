/**
 * Чистый планировщик спавна регулярных задач (ТЗ §6). НИКАКОГО IO:
 * вход — шаблоны + today + политика, выход — план (какие строки породить,
 * куда сдвинуть курсоры, какие шаблоны сломаны). Запись делает RecurrenceService
 * в порядке «сначала копия, потом курсор».
 *
 * Идемпотентность: детерминированный childId = <templateId>-<YYYYMMDD вхождения>;
 * повторный проход над теми же данными даёт пустой план (existingIds гасит спавны,
 * курсор уже сдвинут).
 *
 * Строка копии строится регулярными выражениями над rawLine шаблона —
 * сознательно БЕЗ serializeTaskLine (его пишет параллельный модуль; мы только
 * создаём НОВЫЕ строки, не редактируем существующие). Эмодзи берём из
 * core/parser/emoji.ts, чтобы не разъехаться с токенизатором.
 */
import type { IsoDate, Task } from "../model/Task";
import { ALL_FIELD_EMOJI, DATE_FIELD_EMOJI, VALUE_FIELD_EMOJI } from "../parser/emoji";
import { addDays, compare } from "./dateMath";
import type { ParseError, Rule } from "./grammar";
import { isParseError } from "./grammar";
import { MAX_ITERATIONS, isOccurrence, nextFromCompletion, nextOccurrence } from "./nextOccurrence";

/**
 * Одна заспавненная копия шаблона (её видит индекс) — данные, нужные планировщику
 * «от выполнения» (§every!): дата вхождения и дата выполнения ✅ (null — не
 * выполнена). Для календарных правил не используется. Собирает RecurrenceService
 * из 🧬-копий по индексу.
 */
export interface SpawnedChild {
	/** Дата вхождения копии (обычно из childId <tpl>-<YYYYMMDD>). */
	occurrence: IsoDate;
	/** ✅ дата выполнения либо null. */
	done: IsoDate | null;
}

export interface TemplateInfo {
	/** Задача-шаблон (container === "recurring"). */
	task: Task;
	/** Результат parseRule(task.recurrence). */
	rule: Rule | ParseError;
	/**
	 * Заспавненные копии шаблона — ТОЛЬКО для правил «от выполнения» (§every!):
	 * планировщик смотрит, выполнена ли последняя копия. Для календарных правил
	 * игнорируется (dedup/курсор держат идемпотентность и без списка копий).
	 */
	children?: SpawnedChild[];
	/**
	 * «Копия недатированная» в обход типа правила: spawn-now подставляет
	 * синтетическое календарное правило (сегодняшнее вхождение нужно и для
	 * шаблона без 🔁), и без этого флага ручная копия мигранта Tasks рождалась
	 * бы с замороженной датой шаблона — ровно тем, что вычистка §FIX-1 и
	 * предотвращает. Календарные шаблоны его не ставят.
	 */
	datelessCopy?: boolean;
}

export interface PlannedSpawn {
	templateId: string;
	occurrence: IsoDate;
	/** Детерминированный id копии: <templateId>-<YYYYMMDD>. */
	childId: string;
	/** Готовая строка для append в файл-источник входящих. */
	instanceLine: string;
}

export interface CursorAdvance {
	templateId: string;
	newCursor: IsoDate;
}

export interface TemplateIssue {
	/** null — если у шаблона нет 🆔. */
	templateId: string | null;
	filePath: string;
	lineStart: number;
	message: string;
}

export type CatchUpPolicy = "latest" | "all" | "none";

export interface SpawnPlanInput {
	templates: TemplateInfo[];
	today: IsoDate;
	catchUp: CatchUpPolicy;
	/** Потолок для catchUp === "all" (настройка, default 30). */
	catchUpCap: number;
	/** Все 🆔, уже известные индексу (любой статус носителя). */
	existingIds: Set<string>;
}

export interface SpawnPlanResult {
	spawns: PlannedSpawn[];
	cursorAdvances: CursorAdvance[];
	errors: TemplateIssue[];
}

export function makeChildId(templateId: string, occurrence: IsoDate): string {
	return `${templateId}-${occurrence.replace(/-/g, "")}`;
}

export function planSpawns(input: SpawnPlanInput): SpawnPlanResult {
	const spawns: PlannedSpawn[] = [];
	const cursorAdvances: CursorAdvance[] = [];
	const errors: TemplateIssue[] = [];
	// The caller's set describes rows that existed before this pass.  Keep a
	// private occupied set for rows we have planned as well: two carriers with a
	// duplicated template id must never make one batch append the same child id
	// twice, even before the filesystem-level deduplication gets a chance to run.
	const occupiedChildIds = new Set(input.existingIds);

	for (const tpl of input.templates) {
		const t = tpl.task;

		// пауза: любой статус, кроме ' ' (обычно '-'), выключает шаблон целиком
		if (t.statusChar !== " ") continue;

		if (t.taskId === null) {
			errors.push({
				templateId: null,
				filePath: t.filePath,
				lineStart: t.lineStart,
				message: "template has no 🆔 — deterministic child ids are impossible",
			});
			continue;
		}
		const templateId = t.taskId;

		if (isParseError(tpl.rule)) {
			errors.push({
				templateId,
				filePath: t.filePath,
				lineStart: t.lineStart,
				message: `unparseable 🔁 rule: ${tpl.rule.error}`,
			});
			continue;
		}
		const rule = tpl.rule;

		// Правила «от выполнения» (§every!) идут отдельной веткой: спавн НЕ по
		// календарю, а по выполнению последней копии. Курсор 🔜 держится тем же
		// механизмом cursorAdvances, членство isOccurrence не проверяется.
		if (rule.fromCompletion) {
			planFromCompletion(
				t,
				templateId,
				rule,
				tpl.children ?? [],
				input,
				spawns,
				cursorAdvances,
				occupiedChildIds,
			);
			continue;
		}

		// Якорь чётности недель для weekly с n>1: rule.from (иных базовых дат у
		// шаблона нет). Без from чётность держит сама цепочка курсоров — от члена
		// к члену шаг 7*n сохраняет фазу, отдельный якорь не нужен (anchor = undefined).
		const anchor = rule.from;

		let cursor: IsoDate;
		if (t.nextSpawn === null) {
			// bootstrap: 🔜 = nextOccurrence(rule, today−1) — без ретроспективы,
			// но сегодняшнее вхождение (если есть) спавнится этим же проходом
			const boot = nextOccurrence(rule, addDays(input.today, -1), anchor);
			if (boot === null) continue; // until уже в прошлом — правило исчерпано
			cursor = boot;
		} else if (!isOccurrence(rule, t.nextSpawn)) {
			// курсор структурно чужой правилу (правило правили руками) — снап вперёд
			// от today, пропущенное не спавним (ТЗ §6, жизненный цикл)
			const snapped = nextOccurrence(rule, input.today, anchor);
			if (snapped !== null && snapped !== t.nextSpawn) {
				cursorAdvances.push({ templateId, newCursor: snapped });
			}
			continue;
		} else if (!isOccurrence(rule, t.nextSpawn, anchor)) {
			// курсор структурно верен, но встал на «не ту» неделю по чётности (якорь
			// from появился/сместился у существующего шаблона). Пере-снап на БЛИЖАЙШЕЕ
			// легитимное вхождение ≥ курсора и дальше обычный due-сбор: без дублей
			// (childId+existingIds гасят уже созданные копии обеих фаз старого бага)
			// и без пропуска ближайшего due (вхождения ≤ today подхватятся ниже).
			const resnapped = nextOccurrence(rule, addDays(t.nextSpawn, -1), anchor);
			if (resnapped === null) continue; // until исчерпан
			cursor = resnapped;
		} else {
			cursor = t.nextSpawn;
		}

		// собрать все вхождения D ≤ today
		const due: IsoDate[] = [];
		let d: IsoDate | null = cursor;
		for (
			let iter = 0;
			iter < MAX_ITERATIONS && d !== null && compare(d, input.today) <= 0;
			iter++
		) {
			due.push(d);
			d = nextOccurrence(rule, d);
		}
		// d: первое вхождение строго после today; null — until исчерпан.
		// Упор в MAX_ITERATIONS (d всё ещё ≤ today) — окно усечено: спавнить на
		// таком проходе нельзя («latest» выбрал бы несвежее вхождение из середины
		// окна), только двигаем курсор; проходы сходятся за ceil(missed/1000)
		// шагов, и последний — с полным окном — спавнит ровно свежайшее.
		const truncated = d !== null && compare(d, input.today) <= 0;

		// политика catch-up: latest — только свежайшее; all — хвост с потолком;
		// none — только вхождение, приходящееся ровно на today
		let selected: IsoDate[];
		if (truncated) {
			selected = [];
		} else if (input.catchUp === "latest") {
			const last = due[due.length - 1];
			selected = last === undefined ? [] : [last];
		} else if (input.catchUp === "all") {
			selected = due.slice(Math.max(0, due.length - input.catchUpCap));
		} else {
			selected = due.filter((x) => x === input.today);
		}

		for (const occurrence of selected) {
			const childId = makeChildId(templateId, occurrence);
			// коллизия по id вместо размножения: копия уже есть (любой статус) — молчим
			if (occupiedChildIds.has(childId)) continue;
			spawns.push({
				templateId,
				occurrence,
				childId,
				instanceLine: buildInstanceLine(
					t.rawLine,
					occurrence,
					input.today,
					templateId,
					childId,
					tpl.datelessCopy === true,
				),
			});
			occupiedChildIds.add(childId);
		}

		if (d !== null && d !== t.nextSpawn) {
			cursorAdvances.push({ templateId, newCursor: d });
		} else if (d === null && rule.until !== undefined) {
			// правило исчерпано (until): курсор ПАРКУЕМ за until, иначе идемпотентность
			// висела бы только на existingIds — удаление строки-копии из индекса
			// воскрешало бы её каждым последующим проходом. Парковка ровно на until+1,
			// не на lastOccurrence+1: та дата может быть структурным членом правила
			// и заспавнила бы не-вхождение. Следующий проход: курсор за until →
			// не член правила → снап → nextOccurrence(rule, today) === null → ноль записей.
			const parked = addDays(rule.until, 1);
			if (parked !== t.nextSpawn) {
				cursorAdvances.push({ templateId, newCursor: parked });
			}
		}
	}

	return { spawns, cursorAdvances, errors };
}

/**
 * Планирование одного шаблона «от выполнения» (§every!). Отсчёт НЕ по календарю:
 *
 *  • последняя (по дате вхождения) копия ВЫПОЛНЕНА (✅) → следующий спавн на дату
 *    ✅ + интервал (nextFromCompletion). Дата в будущем — только двигаем курсор 🔜;
 *    наступила/в прошлом — РОВНО ОДНА копия на сегодня (без ретроспективной пачки).
 *  • последняя копия НЕ выполнена → ждём: ни новой копии, ни сдвига курсора.
 *  • копий ещё нет (bootstrap) → первый спавн от 🔜/сегодня, как обычное правило.
 *
 * from — нижняя граница (не раньше); until — верхняя (исчерпание, курсор паркуется
 * за until). Идемпотентность — тот же existingIds + файловый дедуп, что и у
 * календарных правил: повторный проход не плодит дублей (childId стабилен).
 */
function planFromCompletion(
	task: Task,
	templateId: string,
	rule: Rule,
	children: readonly SpawnedChild[],
	input: SpawnPlanInput,
	spawns: PlannedSpawn[],
	cursorAdvances: CursorAdvance[],
	occupiedChildIds: Set<string>,
): void {
	const today = input.today;

	// последняя по дате вхождения копия (её выполнение решает судьбу следующей)
	let last: SpawnedChild | undefined;
	for (const c of children) {
		if (last === undefined || compare(c.occurrence, last.occurrence) > 0) last = c;
	}

	let desired: IsoDate;
	if (last === undefined) {
		if (task.nextSpawn !== null) {
			// bootstrap с уже выставленным 🔜: курсор и есть плановая дата спавна —
			// он авторитетнее фиксированной даты-поля (им дальше правят лишь from/until)
			desired = task.nextSpawn;
		} else {
			// истинный бутстрап (ни копий, ни 🔜): нижняя граница — не раньше сегодня
			// И не раньше фиксированной даты-поля шаблона (📅→⏳→🛫), перенесённой
			// миграцией строки Tasks («when done» с 📅). Будущая дата откладывает
			// первую копию до её наступления; прошлая инертна (max с сегодня). rule.from
			// накладывает свою границу тем же клампом ниже — здесь его не дублируем.
			desired = today;
			const tplDate = task.due ?? task.scheduled ?? task.start;
			if (tplDate !== null && compare(tplDate, desired) > 0) desired = tplDate;
		}
	} else if (last.done === null) {
		// последняя копия не выполнена — ждём выполнения (ни спавна, ни курсора)
		return;
	} else {
		// выполнена — следующий отсчёт строго от даты ✅ + интервал
		desired = nextFromCompletion(rule, last.done);
	}

	// нижняя граница from: не раньше неё
	if (rule.from !== undefined && compare(desired, rule.from) < 0) desired = rule.from;

	// верхняя граница until: правило исчерпано — паркуем курсор за until (идемпотентность,
	// как у календарных правил), без спавна
	if (rule.until !== undefined && compare(desired, rule.until) > 0) {
		const parked = addDays(rule.until, 1);
		if (parked !== task.nextSpawn) cursorAdvances.push({ templateId, newCursor: parked });
		return;
	}

	// ещё не наступило — только держим курсор 🔜 = дата следующего планового спавна
	if (compare(desired, today) > 0) {
		if (desired !== task.nextSpawn) cursorAdvances.push({ templateId, newCursor: desired });
		return;
	}

	// desired ≤ until (строка 273), но фактический спавн идёт на today — при запоздалом
	// проходе today может уйти ЗА until. Тогда серия исчерпана: копию с датой позже until
	// не создаём (симметрия с capUntil календарного пути), паркуем курсор за until.
	if (rule.until !== undefined && compare(today, rule.until) > 0) {
		const parked = addDays(rule.until, 1);
		if (parked !== task.nextSpawn) cursorAdvances.push({ templateId, newCursor: parked });
		return;
	}

	// пора: РОВНО ОДНА копия на сегодня (desired в прошлом — без ретроспективы,
	// спавним сегодняшним днём). existingIds гасит повтор после реиндекса, файловый
	// дедуп — до него; курсор встаёт на дату вхождения.
	const occurrence = today;
	const childId = makeChildId(templateId, occurrence);
	if (!occupiedChildIds.has(childId)) {
		spawns.push({
			templateId,
			occurrence,
			childId,
			instanceLine: buildInstanceLine(
				task.rawLine,
				occurrence,
				today,
				templateId,
				childId,
				true,
			),
		});
		occupiedChildIds.add(childId);
	}
	if (occurrence !== task.nextSpawn) cursorAdvances.push({ templateId, newCursor: occurrence });
}

// ---------------------------------------------------------------------------
// Построение строки копии из rawLine шаблона (трансформация ТЗ §6):
// убрать 🔁/🔜 и шаблонные 🆔/➕/🧬, развернуть офсеты ±Nd от даты вхождения,
// добавить «➕ today 🧬 templateId 🆔 childId».
// ---------------------------------------------------------------------------

// эмодзи не являются метасимволами RegExp — экранирование не нужно
const FIELD_EMOJI_ALT = ALL_FIELD_EMOJI.join("|");
// Мобильные клавиатуры дописывают U+FE0F после эмодзи; токенизатор его глотает —
// здесь та же толерантность, иначе «\S*» съедал бы только селектор (он не \s),
// оставляя payload-токен мусором в описании копии.
const VS = "\\uFE0F?";

/** Текст 🔁-правила тянется до следующего поля-эмодзи или конца строки. */
const RECURRENCE_RE = new RegExp(
	`${VALUE_FIELD_EMOJI.recurrence}${VS}\\s*(?:(?!(?:${FIELD_EMOJI_ALT})).)*`,
	"gu",
);
const CURSOR_RE = new RegExp(`${DATE_FIELD_EMOJI.nextSpawn}${VS}\\s*\\S*`, "gu");
const ID_RE = new RegExp(`${VALUE_FIELD_EMOJI.id}${VS}\\s*\\S*`, "gu");
const SPAWNED_FROM_RE = new RegExp(`${VALUE_FIELD_EMOJI.spawnedFrom}${VS}\\s*\\S*`, "gu");
// ➕ шаблона (дата или офсет) вычищается: у копии своя дата создания
const CREATED_RE = new RegExp(
	`${DATE_FIELD_EMOJI.created}${VS}\\s*(?:[+-]\\d+d|\\d{4}-\\d{2}-\\d{2})?`,
	"gu",
);
/** Офсеты ±Nd легальны только в шаблонах — у 🛫/⏳/📅. VS вне группы 1:
 * пересобранная строка `${emoji} ${date}` выходит уже без FE0F. */
const OFFSET_RE = new RegExp(
	`(${DATE_FIELD_EMOJI.due}|${DATE_FIELD_EMOJI.scheduled}|${DATE_FIELD_EMOJI.start})${VS}\\s*([+-])(\\d+)d(?=\\s|$)`,
	"gu",
);
/** ФИКСИРОВАННЫЕ дата-поля 🛫/⏳/📅 шаблона: у копий «от выполнения» (§every!)
 * их не наследуем — иначе каждая копия несла бы одну и ту же замороженную дату.
 *
 * Граница payload — ровно та же, что читает токенизатор (scanDateTimeToken):
 * «дата», «дата HH:mm», «дата HH:mm-HH:mm». Тянуть «до следующего поля-эмодзи»
 * (как RECURRENCE_RE) нельзя: после даты по контракту идёт ОПИСАНИЕ и #теги, и
 * такая жадность молча съедала их в каждой копии every!/when done. Офсеты ±Nd
 * здесь тоже намеренно не матчатся — это «сдвиг ОТ ВХОЖДЕНИЯ», он осмыслен и
 * для правил от выполнения, и разворачивается ниже (OFFSET_RE). */
const FROM_COMPLETION_DATE_RE = new RegExp(
	`(?:${DATE_FIELD_EMOJI.due}|${DATE_FIELD_EMOJI.scheduled}|${DATE_FIELD_EMOJI.start})${VS}\\s*\\d{4}-\\d{2}-\\d{2}(?:\\s+([01]\\d|2[0-3]):[0-5]\\d(?:-([01]\\d|2[0-3]):[0-5]\\d)?)?`,
	"gu",
);
const PREFIX_RE = /^(\s*[-*+]\s*\[.\]\s*)(.*)$/u;

function buildInstanceLine(
	rawLine: string,
	occurrence: IsoDate,
	today: IsoDate,
	templateId: string,
	childId: string,
	fromCompletion: boolean,
): string {
	// префикс «- [ ] » отделяем, чтобы не тронуть отступ коллапсом пробелов
	const m = PREFIX_RE.exec(rawLine);
	const prefix = m?.[1] ?? "- [ ] ";
	let body = m?.[2] ?? rawLine.trim();

	body = body
		.replace(RECURRENCE_RE, "")
		.replace(CURSOR_RE, "")
		.replace(ID_RE, "")
		.replace(SPAWNED_FROM_RE, "")
		.replace(CREATED_RE, "");

	// Правила «от выполнения» (§every!): копия — недатированная inbox-строка (как
	// у наших родных шаблонов). Фиксированные дата-поля шаблона 🛫/⏳/📅 — в т.ч.
	// перенесённые миграцией строки Tasks («when done») — в копию НЕ тянем: иначе
	// каждая копия несла бы одну и ту же замороженную дату и была бы вечно
	// просрочена. Снимается ТОЛЬКО payload даты: описание и #теги, стоящие за
	// ней, остаются на месте, офсеты ±Nd разворачиваются ниже как у календарных.
	if (fromCompletion) body = body.replace(FROM_COMPLETION_DATE_RE, "");

	// офсеты разворачиваются от ДАТЫ ВХОЖДЕНИЯ, не от дня спавна:
	// 🛫 -3d при вхождении 2026-07-31 → 🛫 2026-07-28, даже если спавн 2026-08-03
	body = body.replace(OFFSET_RE, (_all, emoji: string, sign: string, days: string) => {
		return `${emoji} ${addDays(occurrence, (sign === "-" ? -1 : 1) * parseInt(days, 10))}`;
	});

	body = body.replace(/ {2,}/g, " ").trim();

	const suffix = `${DATE_FIELD_EMOJI.created} ${today} ${VALUE_FIELD_EMOJI.spawnedFrom} ${templateId} ${VALUE_FIELD_EMOJI.id} ${childId}`;
	return body.length > 0 ? `${prefix}${body} ${suffix}` : `${prefix}${suffix}`;
}
