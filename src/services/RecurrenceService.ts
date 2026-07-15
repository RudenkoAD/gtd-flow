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
	type SpawnPlanResult,
	type TemplateInfo,
} from "../core/recurrence/spawnPlan";
import { classifyDuplicates, type DuplicateCarrier } from "../core/recurrence/dedup";
import {
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

	constructor(private readonly deps: RecurrenceDeps) {}

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

		// 1. шаблоны + все занятые 🆔 (любой статус носителя)
		const templates: TemplateInfo[] = [];
		const existingIds = new Set<string>();
		for (const t of index.all()) {
			if (t.taskId !== null) existingIds.add(t.taskId);
			if (t.container !== "recurring") continue;
			const rule: Rule | ParseError =
				t.recurrence === null ? { error: "missing 🔁 rule" } : parseRule(t.recurrence);
			templates.push({ task: t, rule });
		}

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

		// 2. СНАЧАЛА копии: один processFile на весь батч
		const failedSpawnTemplates = await this.applySpawns(plan, settings.spawnTarget, report);

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

	/** Возвращает templateId, чьи копии НЕ записаны (их курсоры трогать нельзя). */
	private async applySpawns(
		plan: SpawnPlanResult,
		spawnTarget: string,
		report: SpawnReport,
	): Promise<Set<string>> {
		const failed = new Set<string>();
		if (plan.spawns.length === 0) return failed;
		try {
			await this.deps.ensureFile(spawnTarget);
			let transformRan = false;
			let appended = 0;
			await this.deps.write.processFile(spawnTarget, (content) => {
				transformRan = true;
				appended = 0; // transform может быть вызван повторно — считаем заново
				const present = collectContentIds(content, spawnTarget);
				const fresh = plan.spawns.filter((s) => !present.has(s.childId));
				if (fresh.length === 0) return null; // все уже в файле (гонка/повтор) — ноль записей
				appended = fresh.length;
				return appendToContent(content, fresh.map((s) => s.instanceLine).join("\n"));
			});
			if (!transformRan) {
				// файла нет даже после ensureFile — копий нет, курсоры не двигаем
				for (const s of plan.spawns) failed.add(s.templateId);
				report.errors.push({ templateId: null, message: `spawn target missing: ${spawnTarget}` });
			} else {
				report.spawned = appended;
			}
		} catch (err) {
			// отказ записи: считаем, что НИ ОДНА копия не легла (vault.process атомарен)
			for (const s of plan.spawns) failed.add(s.templateId);
			report.errors.push({ templateId: null, message: `spawn append failed: ${errorMessage(err)}` });
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
			for (const t of res.remove) {
				const r = await this.deps.dispatcher.dispatch({ type: "delete-line", key: t.key });
				if (r.ok) report.deduped++;
				// 'line-not-found' — штатный исход: второе устройство уже удалило
				else if (r.reason !== "line-not-found") {
					report.errors.push({ templateId: null, message: `dedup delete ${t.key}: ${r.reason}` });
				}
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

		const target = this.deps.settings().spawnTarget;
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
