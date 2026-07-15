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
import { MAX_ITERATIONS, isOccurrence, nextOccurrence } from "./nextOccurrence";

export interface TemplateInfo {
	/** Задача-шаблон (container === "recurring"). */
	task: Task;
	/** Результат parseRule(task.recurrence). */
	rule: Rule | ParseError;
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

		let cursor: IsoDate;
		if (t.nextSpawn === null) {
			// bootstrap: 🔜 = nextOccurrence(rule, today−1) — без ретроспективы,
			// но сегодняшнее вхождение (если есть) спавнится этим же проходом
			const boot = nextOccurrence(rule, addDays(input.today, -1));
			if (boot === null) continue; // until уже в прошлом — правило исчерпано
			cursor = boot;
		} else if (!isOccurrence(rule, t.nextSpawn)) {
			// курсор не принадлежит правилу (правило правили руками) —
			// снап вперёд от today, пропущенное не спавним (ТЗ §6, жизненный цикл)
			const snapped = nextOccurrence(rule, input.today);
			if (snapped !== null && snapped !== t.nextSpawn) {
				cursorAdvances.push({ templateId, newCursor: snapped });
			}
			continue;
		} else {
			cursor = t.nextSpawn;
		}

		// собрать все вхождения D ≤ today
		const due: IsoDate[] = [];
		let d: IsoDate | null = cursor;
		for (let iter = 0; iter < MAX_ITERATIONS && d !== null && compare(d, input.today) <= 0; iter++) {
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
			if (input.existingIds.has(childId)) continue;
			spawns.push({
				templateId,
				occurrence,
				childId,
				instanceLine: buildInstanceLine(t.rawLine, occurrence, input.today, templateId, childId),
			});
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
const PREFIX_RE = /^(\s*[-*+]\s*\[.\]\s*)(.*)$/u;

function buildInstanceLine(
	rawLine: string,
	occurrence: IsoDate,
	today: IsoDate,
	templateId: string,
	childId: string,
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

	// офсеты разворачиваются от ДАТЫ ВХОЖДЕНИЯ, не от дня спавна:
	// 🛫 -3d при вхождении 2026-07-31 → 🛫 2026-07-28, даже если спавн 2026-08-03
	body = body.replace(OFFSET_RE, (_all, emoji: string, sign: string, days: string) => {
		return `${emoji} ${addDays(occurrence, (sign === "-" ? -1 : 1) * parseInt(days, 10))}`;
	});

	body = body.replace(/ {2,}/g, " ").trim();

	const suffix = `${DATE_FIELD_EMOJI.created} ${today} ${VALUE_FIELD_EMOJI.spawnedFrom} ${templateId} ${VALUE_FIELD_EMOJI.id} ${childId}`;
	return body.length > 0 ? `${prefix}${body} ${suffix}` : `${prefix}${suffix}`;
}
