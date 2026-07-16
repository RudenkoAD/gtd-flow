/**
 * RecurrenceService (ТЗ §6, §15) — единственный «пишущий создатель строк».
 *
 * Проход спавна: шаблоны (container === "recurring") → core planSpawns →
 * применение плана в жёстком порядке «СНАЧАЛА копии, ПОТОМ курсоры» (краш
 * между ними безопасен: следующий проход найдёт childId в индексе и просто
 * сдвинет курсор; обратный порядок терял бы вхождения) → дедуп коллизий 🆔
 * после схождения синка двух устройств.
 *
 * Ноль импортов obsidian: запись через WritePort/IntentDispatcher, создание
 * файла-цели — через инжектированный ensureFile.
 */
import type { IsoDate, Task } from "../core/model/Task";
import { parseTaskLine } from "../core/parser/parseTaskLine";
import { VALUE_FIELD_EMOJI } from "../core/parser/emoji";
import {
	serializeTokens,
	tokenizeTaskLine,
	type FieldToken,
} from "../core/parser/tokenizer";
import { compare, isValidIsoDate } from "../core/recurrence/dateMath";
import { isParseError, parseRule, type ParseError, type Rule } from "../core/recurrence/grammar";
import { MAX_ITERATIONS, nextOccurrence } from "../core/recurrence/nextOccurrence";
import {
	makeChildId,
	planSpawns,
	type PlannedSpawn,
	type SpawnPlanResult,
	type TemplateInfo,
} from "../core/recurrence/spawnPlan";
import { classifyDuplicates, type DuplicateCarrier } from "../core/recurrence/dedup";
import {
	locateExactTaskLine,
	locateTaskLine,
	type IntentDispatcher,
	type WritePort,
} from "./WritebackService";
import type { IndexFeed } from "./types";

// ---------------------------------------------------------------------------
// Общий контракт (вид «Регулярные» кодируется против него дословно)
// ---------------------------------------------------------------------------

export interface SpawnReport {
	spawned: number;
	advanced: number;
	deduped: number;
	conflicts: string[];
	errors: { templateId: string | null; message: string }[];
}

export interface RecurrencePort {
	runPass(): Promise<SpawnReport>; // spawn + dedup; сериализован мьютексом; до готовности индекса — no-op {spawned:0,...}
	spawnNow(templateKey: string): Promise<{ ok: boolean; reason?: string }>;
	pause(templateKey: string): Promise<void>; // status -> '-'
	resume(templateKey: string): Promise<void>; // status -> ' ' + снап курсора 🔜 = nextOccurrence(rule, today)
	setRule(templateKey: string, ruleText: string): Promise<{ ok: boolean; parseError?: string }>; // 🔁 + снап 🔜
}

export interface RecurrenceDeps {
	feed: IndexFeed;
	write: WritePort;
	dispatcher: IntentDispatcher;
	settings: () => { spawnTarget: string; catchUp: "latest" | "all" | "none"; catchUpCap: number };
	todayIso: () => IsoDate;
	indexReady: () => boolean;
	/** Создать файл-цель спавна (и папку), если его ещё нет (VaultAdapter.ensureFile). */
	ensureFile: (path: string) => Promise<void>;
	/**
	 * Цель спавна для КОНКРЕТНОГО шаблона: копия регулярного идёт во входящие
	 * ПРОСТРАНСТВА ШАБЛОНА (не активного!) — рабочий шаблон спавнит в рабочий inbox,
	 * даже когда активна «Жизнь» (дизайн). Резолвинг пространства/цели инжектируется
	 * (сервис не знает о Settings/defs): main.ts подставляет nsTargetPath(...). Опционален
	 * — без него ВСЕ спавны идут в единый settings().spawnTarget (обратная совместимость,
	 * поведение до пространств; тесты без деп-функции им и пользуются).
	 */
	spawnTargetFor?: (template: Task) => string;
	/** Генератор 🆔; по умолчанию 6 символов base36 (как в WritebackService/CardService). */
	genId?: () => string;
}

// ---------------------------------------------------------------------------
// Утилиты уровня модуля (чистые, тестируются через сервис)
// ---------------------------------------------------------------------------

/** Детерминированный id копии: <templateId>-<YYYYMMDD> (ТЗ §6). */
const INSTANCE_ID_RE = /^(.+)-(\d{4})(\d{2})(\d{2})$/;

/** Правило «каждый день» для spawn-now: даёт ровно сегодняшнее вхождение,
 *  не требуя парсинга 🔁 шаблона (spawn-now легален и для черновика без правила). */
const DAILY_RULE: Rule = { freq: "daily", n: 1 };

function emptyReport(): SpawnReport {
	return { spawned: 0, advanced: 0, deduped: 0, conflicts: [], errors: [] };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function defaultGenId(): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += BASE36.charAt(Math.floor(Math.random() * BASE36.length));
	return s;
}

/** Все 🆔 из содержимого файла — повторная проверка ВНУТРИ transform:
 *  гонка с собственной незакоммиченной записью закрыта (ТЗ §6, шаг 4). */
function collectContentIds(content: string, filePath: string): Set<string> {
	const out = new Set<string>();
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = parseTaskLine(lines[i]!, {
			filePath,
			lineStart: i,
			parentLine: null,
			heading: null,
			container: "plain",
			projectActive: true,
		});
		if (t !== null && t.taskId !== null) out.add(t.taskId);
	}
	return out;
}

/** append блока строк в конец файла — той же формы, что WritebackService.moveLine. */
function appendToContent(content: string, block: string): string {
	const withNl = block.endsWith("\n") ? block : `${block}\n`;
	if (content.trimEnd() === "") return withNl;
	return content + (content.endsWith("\n") ? "" : "\n") + withNl;
}

/**
 * Правка текста 🔁 на строке шаблона. serializeTaskLine.setField/setValueField
 * не покрывают recurrence (payload с пробелами: assertToken его отверг бы),
 * поэтому payload правится напрямую через токенизатор — та же механика, что
 * setPayloadField: замена ПОСЛЕДНЕГО вхождения (его видит парсер), добавление
 * нового поля в конец при отсутствии; round-trip без потерь гарантирует
 * serializeTokens. null — строка не является задачей.
 */
function setRecurrenceText(rawLine: string, ruleText: string): string | null {
	const t = tokenizeTaskLine(rawLine);
	if (t === null) return null;
	const idxs: number[] = [];
	for (let i = 0; i < t.segments.length; i++) {
		const s = t.segments[i]!;
		if (s.kind === "field" && s.field === "recurrence") idxs.push(i);
	}
	if (idxs.length > 0) {
		const tok = t.segments[idxs[idxs.length - 1]!] as FieldToken;
		// голый «🔁» в конце строки — добавить разделитель перед payload
		if (tok.gap === "" && tok.payload === "") tok.gap = " ";
		tok.payload = ruleText;
	} else {
		t.segments.push(
			{ kind: "text", text: " " },
			{ kind: "field", field: "recurrence", emoji: VALUE_FIELD_EMOJI.recurrence, gap: " ", payload: ruleText },
		);
	}
	return serializeTokens(t);
}

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

export class RecurrenceService implements RecurrencePort {
	/**
	 * Мьютекс всех пишущих операций: цепочка промисов. Повторный вызов во
	 * время прохода НЕ схлопывается в no-op, а ЖДЁТ завершения текущего и
	 * выполняет собственный полный проход — идемпотентность (existingIds +
	 * повторная проверка 🆔 внутри transform) делает второй проход пустым,
	 * зато вызывающий гарантированно получает отчёт по актуальному состоянию.
	 */
	private mutex: Promise<unknown> = Promise.resolve();

	private readonly genId: () => string;

	/**
	 * Память «ключ id-less шаблона → вписанный нами 🆔» на окно дебаунса
	 * реиндексации (~150мс): пока индекс отдаёт шаблон ещё БЕЗ taskId, повторный
	 * runPass НЕ должен выдать ему второй (другой) id, а обязан подождать. После
	 * реиндекса ключ шаблона переезжает в 'id:<🆔>' и из числа id-less исчезает —
	 * его запись здесь вычищается (иначе память растёт по сессии).
	 */
	private readonly injectedIds = new Map<string, string>();

	constructor(private readonly deps: RecurrenceDeps) {
		this.genId = deps.genId ?? defaultGenId;
	}

	/**
	 * Файл-цель спавна шаблона: деп-функция spawnTargetFor (пространство ШАБЛОНА),
	 * иначе единый глобальный settings().spawnTarget (обратная совместимость).
	 * template === undefined (шаблон исчез из индекса между планом и записью) —
	 * тоже глобальный фолбэк.
	 */
	private spawnTargetOf(template: Task | undefined): string {
		if (this.deps.spawnTargetFor !== undefined && template !== undefined) {
			return this.deps.spawnTargetFor(template);
		}
		return this.deps.settings().spawnTarget;
	}

	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.mutex.then(fn, fn);
		this.mutex = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// --- RecurrencePort ---

	async runPass(): Promise<SpawnReport> {
		return this.locked(() => this.runPassInner());
	}

	async spawnNow(templateKey: string): Promise<{ ok: boolean; reason?: string }> {
		return this.locked(() => this.spawnNowInner(templateKey));
	}

	async pause(templateKey: string): Promise<void> {
		await this.locked(() =>
			this.deps.dispatcher.dispatch({ type: "set-status", key: templateKey, statusChar: "-" }),
		);
	}

	async resume(templateKey: string): Promise<void> {
		await this.locked(async () => {
			// задачу читаем ДО записи: статусная правка не меняет 🆔/🔁/файл
			const tpl = this.deps.feed.getIndex().get(templateKey);
			await this.deps.dispatcher.dispatch({ type: "set-status", key: templateKey, statusChar: " " });
			if (tpl === undefined || tpl.taskId === null || tpl.recurrence === null) return;
			const rule = parseRule(tpl.recurrence);
			if (isParseError(rule)) return; // битое правило всплывёт ошибкой ближайшего runPass
			const next = nextOccurrence(rule, this.deps.todayIso());
			if (next === null) return; // until исчерпан — снапать некуда
			await this.deps.dispatcher.dispatch({
				type: "advance-cursor",
				templateId: tpl.taskId,
				date: next,
			});
		});
	}

	async setRule(templateKey: string, ruleText: string): Promise<{ ok: boolean; parseError?: string }> {
		return this.locked(() => this.setRuleInner(templateKey, ruleText));
	}

	// --- spawn-проход ---

	private async runPassInner(): Promise<SpawnReport> {
		const report = emptyReport();
		// жёсткий гейт: до полной сборки индекса existingIds неполон,
		// и «идемпотентный» план начал бы плодить дубли — только no-op
		if (!this.deps.indexReady()) return report;

		const settings = this.deps.settings();
		const today = this.deps.todayIso();
		const index = this.deps.feed.getIndex();

		// 1. шаблоны + все занятые 🆔 (любой статус носителя); шаблоны без 🆔
		//    копим отдельно — им нужна ленивая инъекция, а не ошибка
		const templates: TemplateInfo[] = [];
		const idless: Task[] = [];
		const existingIds = new Set<string>();
		// templateId → задача-шаблон: нужна на фазе записи, чтобы развести спавны
		// по входящим ПРОСТРАНСТВА каждого шаблона (spawnTargetOf).
		const templateById = new Map<string, Task>();
		// 🆔, вписанные нами в прошлых проходах этой сессии, индекс мог ещё не
		// увидеть (дебаунс) — держим занятыми, чтобы freshId не выдал дубликат
		for (const injected of this.injectedIds.values()) existingIds.add(injected);
		for (const t of index.all()) {
			if (t.taskId !== null) existingIds.add(t.taskId);
			if (t.container !== "recurring") continue;
			if (t.taskId === null) {
				idless.push(t);
				continue;
			}
			const rule: Rule | ParseError =
				t.recurrence === null ? { error: "missing 🔁 rule" } : parseRule(t.recurrence);
			templates.push({ task: t, rule });
			templateById.set(t.taskId, t);
		}

		// 1a. Ленивая инъекция 🆔 в шаблоны без него (ТЗ §6: детерминированный
		//     childId невозможен без стабильного 🆔). Это НЕ ошибка и НЕ спавн в
		//     этом проходе: пишем только 🆔 (set-id), а спавн отдаём СЛЕДУЮЩЕМУ
		//     проходу — после реиндекса и окна синка двух устройств, когда 🆔 успел
		//     сойтись. Иначе копии минтились бы от ещё-не-сошедшегося случайного
		//     id и на втором устройстве осиротели бы. Ошибка "template has no 🆔"
		//     как класс исчезает: planSpawns этих шаблонов уже не видит.
		await this.injectMissingIds(idless, existingIds);

		const plan = planSpawns({
			templates,
			today,
			catchUp: settings.catchUp,
			catchUpCap: settings.catchUpCap,
			existingIds,
		});
		for (const e of plan.errors) {
			report.errors.push({ templateId: e.templateId, message: e.message });
		}

		// 2. СНАЧАЛА копии: спавны группируются по файлу-цели (входящие пространства
		//    шаблона), по одному processFile на цель.
		const failedSpawnTemplates = await this.applySpawns(
			plan,
			(templateId) => this.spawnTargetOf(templateById.get(templateId)),
			report,
		);

		// 3. ПОТОМ курсоры; шаблонам с незаписанной копией курсор не двигаем —
		//    иначе вхождение потеряно (следующий проход его уже не увидит)
		for (const adv of plan.cursorAdvances) {
			if (failedSpawnTemplates.has(adv.templateId)) continue;
			const res = await this.deps.dispatcher.dispatch({
				type: "advance-cursor",
				templateId: adv.templateId,
				date: adv.newCursor,
			});
			if (res.ok) report.advanced++;
			else report.errors.push({ templateId: adv.templateId, message: `advance-cursor: ${res.reason}` });
		}

		// 4. дедуп коллизий 🆔 (после схождения синка двух устройств)
		await this.dedupPass(report);
		return report;
	}

	/**
	 * Вписать 🆔 в шаблоны без него — по одному свежему id на шаблон, интентом
	 * set-id (та же ленивая механика, что у CardService.openOrCreate). Память
	 * injectedIds закрывает окно дебаунса реиндексации: пока индекс отдаёт шаблон
	 * ещё без taskId, повторный проход НЕ выдаёт второй id, а ждёт. Ключи,
	 * переставшие быть id-less шаблонами (реиндекс переименовал ключ в 'id:<🆔>' /
	 * шаблон удалён), из памяти вычищаются. Спавн этих шаблонов — дело следующего
	 * прохода: здесь ни спавна, ни курсора, ни ошибки в report.
	 */
	private async injectMissingIds(idless: readonly Task[], existingIds: Set<string>): Promise<void> {
		const seen = new Set<string>();
		for (const t of idless) {
			seen.add(t.key);
			if (this.injectedIds.has(t.key)) continue; // уже вписали в этой сессии — ждём реиндекс
			const fresh = this.freshId(existingIds);
			if (fresh === null) continue; // генератор зациклился на занятых id — повторит следующий проход
			const res = await this.deps.dispatcher.dispatch({ type: "set-id", key: t.key, taskId: fresh });
			if (res.ok) {
				this.injectedIds.set(t.key, fresh);
				existingIds.add(fresh); // не переиспользовать этот id для соседнего id-less шаблона
			}
		}
		// прунинг памяти: ключи, ушедшие из числа id-less шаблонов
		for (const key of [...this.injectedIds.keys()]) {
			if (!seen.has(key)) this.injectedIds.delete(key);
		}
	}

	/** Свежий 🆔 для ленивой инъекции: минуя и занятые (existingIds — индекс плюс
	 *  выданные в этом проходе), и все носители по индексу; 32 попытки — как в
	 *  WritebackService.freshId. null — генератор зациклился на занятых id. */
	private freshId(existingIds: ReadonlySet<string>): string | null {
		for (let attempt = 0; attempt < 32; attempt++) {
			const id = this.genId();
			if (!existingIds.has(id) && this.deps.feed.getIndex().resolveDep(id).length === 0) return id;
		}
		return null;
	}

	/**
	 * Возвращает templateId, чьи копии НЕ записаны (их курсоры трогать нельзя).
	 * Спавны группируются по файлу-цели (targetOf по templateId → входящие
	 * пространства шаблона) — по одному ensureFile+processFile на цель. Отказ
	 * записи одной цели помечает failed ТОЛЬКО её шаблоны: курсоры шаблонов
	 * других пространств двигаются штатно (их копии легли). report.spawned
	 * аккумулируется по всем целям.
	 */
	private async applySpawns(
		plan: SpawnPlanResult,
		targetOf: (templateId: string) => string,
		report: SpawnReport,
	): Promise<Set<string>> {
		const failed = new Set<string>();
		if (plan.spawns.length === 0) return failed;

		// разложить спавны по файлу-цели (сохраняя порядок внутри группы)
		const byTarget = new Map<string, PlannedSpawn[]>();
		for (const s of plan.spawns) {
			const target = targetOf(s.templateId);
			const list = byTarget.get(target);
			if (list !== undefined) list.push(s);
			else byTarget.set(target, [s]);
		}

		for (const [target, spawns] of byTarget) {
			try {
				await this.deps.ensureFile(target);
				let transformRan = false;
				let appended = 0;
				await this.deps.write.processFile(target, (content) => {
					transformRan = true;
					appended = 0; // transform может быть вызван повторно — считаем заново
					const present = collectContentIds(content, target);
					const fresh = spawns.filter((s) => !present.has(s.childId));
					if (fresh.length === 0) return null; // все уже в файле (гонка/повтор) — ноль записей
					appended = fresh.length;
					return appendToContent(content, fresh.map((s) => s.instanceLine).join("\n"));
				});
				if (!transformRan) {
					// файла нет даже после ensureFile — копий этой цели нет, курсоры не двигаем
					for (const s of spawns) failed.add(s.templateId);
					report.errors.push({ templateId: null, message: `spawn target missing: ${target}` });
				} else {
					report.spawned += appended;
				}
			} catch (err) {
				// отказ записи цели: НИ ОДНА её копия не легла (vault.process атомарен)
				for (const s of spawns) failed.add(s.templateId);
				report.errors.push({ templateId: null, message: `spawn append failed: ${errorMessage(err)}` });
			}
		}
		return failed;
	}

	// --- дедуп ---

	/**
	 * Дедуп (ТЗ §6): группы byId с >1 носителем, чей id похож на копию
	 * (паттерн <tplId>-<YYYYMMDD> и/или 🧬 у носителя). Канон каждого носителя
	 * пересчитывается планировщиком от шаблона; шаблон удалён/сломан или канон
	 * невоспроизводим → группа целиком в конфликты (работу пользователя не
	 * трогаем НИКОГДА). Auto-remove — только доказуемо машинных строк.
	 */
	private async dedupPass(report: SpawnReport): Promise<void> {
		const index = this.deps.feed.getIndex();
		for (const [id, keys] of index.duplicateIds()) {
			const carriers: Task[] = [];
			for (const k of keys) {
				const t = index.get(k);
				if (t !== undefined) carriers.push(t);
			}
			if (carriers.length < 2) continue;
			const instanceLike =
				INSTANCE_ID_RE.test(id) || carriers.some((c) => c.spawnedFrom !== null);
			if (!instanceLike) continue; // дубль пользовательских id — lint-бейдж, не наш дедуп

			const withCanon = this.canonicalCarriers(id, carriers);
			if (withCanon === null) {
				report.conflicts.push(...carriers.map((c) => c.key));
				continue;
			}
			const res = classifyDuplicates(withCanon);
			if ("conflict" in res) {
				report.conflicts.push(...res.conflict.map((t) => t.key));
				continue;
			}
			await this.removeCarriers(res.remove, report);
		}
	}

	/**
	 * Батч-удаление проигравших носителей группы: ВСЕ жертвы одного файла —
	 * одним processFile, чтобы ни одно удаление не наблюдало сдвигов строк от
	 * предыдущего (последовательные delete-line с протухшими подсказками
	 * lineStart роняли под нож кипера). Пояс и подтяжки: каждая жертва
	 * дополнительно локализуется locateExactTaskLine — только строка,
	 * текстуально равная её rawLine; изменённого пользователем кипера фильтр
	 * не отдаст, а идентичные пристин-копии взаимозаменяемы, поэтому
	 * «ближайшая к подсказке» из ещё не занятых (claimed) безопасна.
	 */
	private async removeCarriers(remove: readonly Task[], report: SpawnReport): Promise<void> {
		const byFile = new Map<string, Task[]>();
		for (const t of remove) {
			const list = byFile.get(t.filePath);
			if (list) list.push(t);
			else byFile.set(t.filePath, [t]);
		}
		for (const [path, victims] of byFile) {
			try {
				let removed = 0;
				let transformRan = false;
				await this.deps.write.processFile(path, (content) => {
					transformRan = true;
					removed = 0; // transform может быть вызван повторно — считаем заново
					const lines = content.split("\n");
					const claimed = new Set<number>();
					for (const v of victims) {
						const idx = locateExactTaskLine(lines, path, v, claimed);
						// -1 — штатно: второе устройство уже удалило эту копию
						if (idx !== -1) claimed.add(idx);
					}
					if (claimed.size === 0) return null;
					removed = claimed.size;
					return lines.filter((_, i) => !claimed.has(i)).join("\n");
				});
				if (transformRan) report.deduped += removed;
				else report.errors.push({ templateId: null, message: `dedup delete ${path}: file-not-found` });
			} catch (err) {
				report.errors.push({
					templateId: null,
					message: `dedup delete ${path}: ${errorMessage(err)}`,
				});
			}
		}
	}

	/** null — канон группы невоспроизводим (id не по паттерну, шаблон удалён/дублирован/без правила). */
	private canonicalCarriers(id: string, carriers: Task[]): DuplicateCarrier[] | null {
		const m = INSTANCE_ID_RE.exec(id);
		if (m === null) return null;
		const occurrence: IsoDate = `${m[2]}-${m[3]}-${m[4]}`;
		if (!isValidIsoDate(occurrence)) return null;
		const templates = this.deps.feed
			.getIndex()
			.resolveDep(m[1]!)
			.filter((t) => t.container === "recurring");
		const tpl = templates[0];
		if (tpl === undefined || templates.length > 1) return null;
		if (tpl.recurrence === null) return null;
		const rule = parseRule(tpl.recurrence);
		if (isParseError(rule)) return null;

		return carriers.map((c) => ({
			task: c,
			// канон невоспроизводим для конкретного носителя (➕ снесён, occurrence
			// выпала из правила и т.п.) → "" никогда не равен rawLine ⇒ носитель
			// считается изменённым — fail-closed в пользу сохранения строки
			canonicalLine: this.canonicalLine(tpl, rule, occurrence, id, c) ?? "",
		}));
	}

	/**
	 * Каноническая строка спавна носителя: НЕ дублируем buildInstanceLine
	 * (он приватен в core/spawnPlan), а прогоняем планировщик на синтетическом
	 * шаблоне с курсором = occurrence и today = ➕ носителя (день его спавна) —
	 * получаем ровно ту строку, которую породил бы честный проход в тот день.
	 */
	private canonicalLine(
		tpl: Task,
		rule: Rule,
		occurrence: IsoDate,
		childId: string,
		carrier: Task,
	): string | null {
		const spawnDay = carrier.created ?? occurrence;
		if (compare(occurrence, spawnDay) > 0) return null;
		const synthetic: Task = { ...tpl, statusChar: " ", nextSpawn: occurrence };
		const res = planSpawns({
			templates: [{ task: synthetic, rule }],
			today: spawnDay,
			// 'all' с потолком в предел итераций: нужно именно вхождение occurrence,
			// а не «свежайшее» — latest выбрал бы более позднее при spawnDay > occurrence
			catchUp: "all",
			catchUpCap: MAX_ITERATIONS,
			existingIds: new Set(),
		});
		return res.spawns.find((s) => s.childId === childId)?.instanceLine ?? null;
	}

	// --- spawn-now ---

	/**
	 * Внеплановая копия «прямо сейчас»: occurrence = today, курсор НЕ трогаем
	 * (плановое вхождение по-прежнему заспавнится своим чередом). Работает и
	 * для паузы, и для черновика без правила — правило здесь не нужно вовсе.
	 */
	private async spawnNowInner(templateKey: string): Promise<{ ok: boolean; reason?: string }> {
		if (!this.deps.indexReady()) return { ok: false, reason: "index-not-ready" };
		const index = this.deps.feed.getIndex();
		const tpl = index.get(templateKey);
		if (tpl === undefined) return { ok: false, reason: "task-not-found" };
		if (tpl.container !== "recurring") return { ok: false, reason: "not-a-template" };
		if (tpl.taskId === null) return { ok: false, reason: "template-has-no-id" };

		const today = this.deps.todayIso();
		const childId = makeChildId(tpl.taskId, today);
		if (index.resolveDep(childId).length > 0) return { ok: false, reason: "already-spawned" };

		// синтетический план с DAILY_RULE и курсором today даёт ровно одно
		// сегодняшнее вхождение — переиспользуем трансформацию шаблон→копия ядра
		const synthetic: Task = { ...tpl, statusChar: " ", nextSpawn: today };
		const plan = planSpawns({
			templates: [{ task: synthetic, rule: DAILY_RULE }],
			today,
			catchUp: "latest",
			catchUpCap: 1,
			existingIds: new Set(),
		});
		const spawn = plan.spawns[0];
		if (spawn === undefined) return { ok: false, reason: "plan-empty" }; // недостижимо

		// внеплановая копия идёт во входящие ПРОСТРАНСТВА ШАБЛОНА (как плановый спавн)
		const target = this.spawnTargetOf(tpl);
		try {
			await this.deps.ensureFile(target);
			let transformRan = false;
			let appended = false;
			await this.deps.write.processFile(target, (content) => {
				transformRan = true;
				if (collectContentIds(content, target).has(childId)) {
					appended = false;
					return null; // гонка: копия уже в файле — второй раз не пишем
				}
				appended = true;
				return appendToContent(content, spawn.instanceLine);
			});
			if (!transformRan) return { ok: false, reason: "target-not-found" };
			if (!appended) return { ok: false, reason: "already-spawned" };
			return { ok: true };
		} catch (err) {
			return { ok: false, reason: `write-failed: ${errorMessage(err)}` };
		}
	}

	// --- правка правила ---

	/**
	 * Порядок записи: сначала 🔁, потом снап 🔜 = nextOccurrence(new, today).
	 * Краш между ними безопасен: устаревший курсор не пройдёт валидацию членства
	 * в новом правиле на ближайшем runPass и будет снапнут там (без спавна).
	 */
	private async setRuleInner(
		templateKey: string,
		ruleText: string,
	): Promise<{ ok: boolean; parseError?: string }> {
		const trimmed = ruleText.trim();
		// перевод строки развалил бы строку задачи в файле; parseRule его не ловит
		// (токенизация по \s), поэтому отдельная проверка до всего остального
		if (/[\r\n]/.test(ruleText)) return { ok: false, parseError: "rule must be a single line" };
		const rule = parseRule(trimmed);
		if (isParseError(rule)) return { ok: false, parseError: rule.error };

		const tpl = this.deps.feed.getIndex().get(templateKey);
		if (tpl === undefined) return { ok: false }; // не parse-ошибка: parseError не заполняем

		let failure: string | null = "file-not-found";
		await this.deps.write.processFile(tpl.filePath, (content) => {
			failure = null;
			const lines = content.split("\n");
			const idx = locateTaskLine(lines, tpl.filePath, tpl);
			if (idx === -1) {
				failure = "line-not-found";
				return null;
			}
			const next = setRecurrenceText(lines[idx]!, trimmed);
			if (next === null) {
				failure = "transform-failed";
				return null;
			}
			if (next === lines[idx]) return null; // правило не изменилось — успех без записи
			lines[idx] = next;
			return lines.join("\n");
		});
		if (failure !== null) return { ok: false };

		// снап курсора — только при адресуемом шаблоне; черновик без 🆔 получит
		// курсор bootstrap'ом первого прохода после вставки id
		if (tpl.taskId !== null) {
			const next = nextOccurrence(rule, this.deps.todayIso());
			if (next !== null) {
				await this.deps.dispatcher.dispatch({
					type: "advance-cursor",
					templateId: tpl.taskId,
					date: next,
				});
			}
		}
		return { ok: true };
	}
}
