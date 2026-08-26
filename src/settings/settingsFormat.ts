/**
 * Чистые парсеры/форматтеры вкладки настроек: текст полей ↔ модель Settings.
 * Без obsidian — тестируется в node (см. settingsFormat.test.ts).
 */
import type {
	ActiveCalendarSub,
	CalDavCalendarSub,
	CalendarField,
	DeferPreset,
	GtdFlowSettings,
} from "./Settings";
import type { SyncResult } from "../sync/SyncService";
import {
	DEVICE_LOCAL_ERROR_CODES,
	type ExternalRuntimeStatus,
	type ExternalSyncErrorCode,
} from "../sync/externalSyncStatus";

/** Путь-на-строку → список путей: обрезка пробелов, пустые строки отбрасываются. */
export function parsePathList(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function formatPathList(paths: readonly string[]): string {
	return paths.join("\n");
}

export interface DeferPresetsParse {
	presets: DeferPreset[];
	/** Строки, не прошедшие формат «Метка|дни» — для сообщения об ошибке. */
	invalid: string[];
}

/**
 * Формат строки: «Метка|дни». Разделитель — ПОСЛЕДНИЙ «|», чтобы метка
 * могла содержать «|», а дни — гарантированно хвост строки.
 */
export function parseDeferPresets(text: string): DeferPresetsParse {
	const presets: DeferPreset[] = [];
	const invalid: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "") continue;
		const sep = line.lastIndexOf("|");
		if (sep === -1) {
			invalid.push(line);
			continue;
		}
		const label = line.slice(0, sep).trim();
		const days = parseIntInRange(line.slice(sep + 1), 0);
		if (label === "" || days === null) {
			invalid.push(line);
			continue;
		}
		presets.push({ label, offsetDays: days });
	}
	return { presets, invalid };
}

export function formatDeferPresets(presets: readonly DeferPreset[]): string {
	return presets.map((p) => `${p.label}|${p.offsetDays}`).join("\n");
}

/**
 * Строгое целое в диапазоне [min, max]; всё прочее (пусто, дробь, «12abc»,
 * NaN) → null. Строже Number(): «» и «  » Number превращает в 0.
 */
export function parseIntInRange(
	raw: string,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number | null {
	const s = raw.trim();
	if (!/^[+-]?\d+$/.test(s)) return null;
	const n = Number(s);
	return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export const CALENDAR_FIELDS: readonly CalendarField[] = ["due", "scheduled", "start"];

/**
 * Выбранное поле — в голову приоритета, остальные сохраняют текущий
 * относительный порядок (fallback). Дубликаты и пропуски из руками
 * правленного data.json нормализуются: результат — всегда все три поля.
 */
export function reorderCalendarPlacement(
	current: readonly CalendarField[],
	primary: CalendarField,
): CalendarField[] {
	const rest: CalendarField[] = [];
	for (const f of [...current, ...CALENDAR_FIELDS]) {
		if (f !== primary && CALENDAR_FIELDS.includes(f) && !rest.includes(f)) rest.push(f);
	}
	return [primary, ...rest];
}

// ── Внешние календари: коммит имени подписки по blur/Enter ──────────────────

export interface SubNameCommitPlan {
	/** Значение для записи в sub.name (обрезано). Пустое допустимо — строка
	 *  подписки покажет «(без имени)». */
	value: string;
	/** Изменилось ли имя (сравнение по trim): true — зеркало под старым именем
	 *  осиротело (подлежит удалению) и строку надо перерисовать. */
	renamed: boolean;
}

/**
 * Решение о коммите имени подписки (blur/Enter, а НЕ на каждую букву). Сравнение
 * по trim: правка одних лишь краевых пробелов изменением не считается
 * (renamed=false), а очистка имени в пусто — считается (renamed=true: старое
 * зеркало осиротело). Значение всегда обрезается.
 */
export function planSubNameCommit(oldName: string, input: string): SubNameCommitPlan {
	const value = input.trim();
	return { value, renamed: value !== oldName.trim() };
}

// ── Входящие: коммит пути файла входящих по blur/Enter ─────────────────────

/**
 * Коммит поля «Файл входящих» (blur/Enter, а НЕ на каждую букву). Путь зеркал
 * ICS считается ОТ папки этого файла (mirrorPath → underInboxParent), поэтому
 * запись на каждый символ прогоняла зеркала по промежуточным путям: при наборе
 * «GTD/Inbox.md» файл-зеркало успевал родиться в корне, уехать в корзину и
 * пересоздаться, а каждое поколение конфигурации перезапускало ПОЛНЫЙ сетевой
 * проход по всем лентам (runAllUntilCurrentConfiguration). Пустое значение —
 * не изменение (пользователь стирает поле, чтобы набрать новое): держим прежний
 * путь, как и раньше. Возвращает true, если путь реально изменился (вызыватель
 * тогда дёргает reconcile и сохраняет).
 */
export async function commitInboxFile(
	settings: { inboxFile: string },
	input: string,
	ports: { reconcile: () => void; save: () => Promise<void> },
): Promise<boolean> {
	const value = input.trim();
	if (value === "" || value === settings.inboxFile) return false;
	settings.inboxFile = value;
	ports.reconcile();
	await ports.save();
	return true;
}

/**
 * Коммит имени подписки. При реальном переименовании: удалить зеркало СТАРОГО
 * имени РОВНО РАЗ (deleteMirror — до мутации, путь считается от старого имени),
 * записать новое имя, сохранить; вернуть true (вызыватель тогда перерисует
 * строку — заголовок и статус). Без изменений — ни удаления, ни записи (не будим
 * saveData и не трогаем зеркало впустую), вернуть false. IO приходит портами —
 * тестируется без DOM/obsidian. Это ключ к фиксу «фокус теряется после первой
 * буквы»: раньше эта чистка зеркала шла на КАЖДЫЙ input-event.
 */
export async function commitSubName(
	sub: { name: string },
	input: string,
	ports: { deleteMirror: (oldName: string) => Promise<void>; save: () => Promise<void> },
): Promise<boolean> {
	const { value, renamed } = planSubNameCommit(sub.name, input);
	if (!renamed) return false;
	const oldName = sub.name; // зеркало под СТАРЫМ именем — удаляем ДО мутации sub.name
	await ports.deleteMirror(oldName);
	sub.name = value;
	await ports.save();
	return true;
}

// ── Статус внешней синхронизации (v5, санитизированный) ─────────────────────

/**
 * Применить итог синхронизации к персистентному статусу подписки.
 * Возвращает true, когда статус изменился и требуется сохранение.
 *
 * Инварианты §5.1/§5.2 CalDAV-заказа:
 * - сырой текст (detail) НИКОГДА не персистится — только код;
 * - device-local коды (credential_missing и т.п.) не пишутся в общий
 *   data.json вовсе: локальная проблема этого устройства не имеет права
 *   затирать durable-статус успешной синхронизации другого устройства;
 * - lastError (легаси до v5) всегда обнуляется.
 */
export function applySyncResult(sub: ActiveCalendarSub, result: SyncResult): boolean {
	if (result.ok) {
		if (sub.lastSyncAt === result.at && sub.lastError === null && sub.errorCode === null)
			return false;
		sub.lastSyncAt = result.at;
		sub.lastError = null;
		sub.errorCode = null;
		return true;
	}
	if (DEVICE_LOCAL_ERROR_CODES.has(result.code)) return false;
	if (sub.errorCode === result.code && sub.lastError === null) return false;
	sub.errorCode = result.code;
	sub.lastError = null;
	return true;
}

/** Короткая безопасная подсказка по коду ошибки (без сырых данных). */
export function describeSyncErrorCode(code: ExternalSyncErrorCode): string {
	switch (code) {
		case "credential_missing":
			return "нет учётных данных на этом устройстве — настройте секрет";
		case "authentication_failed":
			return "авторизация отклонена — переподключите аккаунт";
		case "forbidden":
			return "доступ запрещён сервером";
		case "discovery_failed":
			return "не удалось обнаружить календари на сервере";
		case "collection_missing":
			return "коллекция не найдена — выполните повторное обнаружение";
		case "scope_missing":
			return "настроенный scope недоступен — обновление заблокировано";
		case "rate_limited":
			return "сервер ограничил частоту запросов — повтор в следующем проходе";
		case "network_error":
			return "сетевая ошибка — повтор в следующем проходе";
		case "timeout":
			return "тайм-аут запроса";
		case "invalid_xml":
			return "некорректный ответ сервера (XML)";
		case "invalid_calendar_data":
			return "некорректные данные календаря";
		case "response_too_large":
			return "ответ сервера превышает лимит";
		case "unsupported_server":
			return "сервер не поддерживает требуемые операции CalDAV";
		case "unknown":
			return "ошибка синхронизации (подробности в консоли разработчика)";
	}
}

/**
 * Текст статуса подписки для вкладки настроек (§9: различимые состояния).
 * Runtime-статус текущего процесса приоритетнее персистентного: он видит
 * «синхронизируется…» и device-local коды, которых в data.json нет.
 */
export function formatSyncStatus(
	sub: Pick<ActiveCalendarSub, "lastSyncAt" | "lastError" | "errorCode">,
	runtime: ExternalRuntimeStatus,
): string {
	if (runtime.state === "syncing") return "синхронизируется…";
	if (runtime.state === "error")
		return `⚠ ${describeSyncErrorCode(runtime.errorCode ?? "unknown")}`;
	const stamp = (at: number): string => {
		const d = new Date(at);
		const p = (n: number): string => String(n).padStart(2, "0");
		return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}.${p(d.getMonth() + 1)}`;
	};
	if (runtime.state === "okChanged" && sub.lastSyncAt !== null)
		return `обновлено ${stamp(sub.lastSyncAt)}`;
	if (runtime.state === "okUnchanged" && sub.lastSyncAt !== null)
		return `обновлено ${stamp(sub.lastSyncAt)} (без изменений)`;
	// neverAttempted в этом процессе — показываем персистентный статус.
	if (sub.errorCode !== null) return `⚠ ${describeSyncErrorCode(sub.errorCode)}`;
	// Легаси-текст ошибки (до v5) не рендерится сырым — только безопасная фраза.
	if (sub.lastError !== null) return `⚠ ${describeSyncErrorCode("unknown")}`;
	if (sub.lastSyncAt === null) return "ещё не синхронизировалось";
	return `обновлено ${stamp(sub.lastSyncAt)}`;
}

// ── CalDAV: приватность подписки и удаление аккаунта (§4.1/§4.3) ────────────

export type PrivacyCommitResult = "unchanged" | "applied" | "pending-redaction";

/**
 * Коммит режима приватности CalDAV-подписки (§4.3 CalDAV-заказа): crash- и
 * save-safe переход. "unconfigured" никогда не приходит в `next` — тип это
 * гарантирует, из draft-состояния уходят только явным выбором "details"/"busy".
 *
 * - Совпадает с текущим privacy — no-op: без fence, без save, без мутации.
 * - Ослабление или первый выбор ("unconfigured"→"details", "unconfigured"→
 *   "busy", "busy"→"details") — обычный коммит: записать privacy, сохранить;
 *   отказ save откатывает privacy в памяти и пробрасывает ошибку (изменение
 *   не применено). pendingRedaction здесь не участвует: "busy"→"details"
 *   лишь ждёт следующего успешного опроса, чтобы снова показывать детали —
 *   больше здесь делать нечего.
 * - Сжатие "details"→"busy" (fail-closed транзитивная точка отказа, §4.3
 *   шаг 1): СНАЧАЛА ports.fence() — завершения зависшего детального fetch не
 *   должны приземлиться ПОСЛЕ этого выбора; затем privacy="busy" И
 *   pendingRedaction=true; затем durable save — ДО любой мутации зеркала.
 *   Отказ save откатывает ОБА поля в памяти и пробрасывает ошибку: изменение
 *   не применено, зачистка не начиналась. Успех → "pending-redaction" —
 *   вызыватель запускает проход зачистки зеркала в sync-слое. sub.enabled
 *   здесь НИКОГДА не трогается. Отката durable "busy" обратно в "details" в
 *   этой функции нет и быть не может (§4.3 шаг 3).
 */
export async function commitPrivacyMode(
	sub: CalDavCalendarSub,
	next: "details" | "busy",
	ports: {
		/** Обесценить in-flight работу ДО первой durable-записи (fence поколения). */
		fence: () => void;
		/** Durable-сохранение настроек; reject — изменение НЕ применено. */
		save: () => Promise<void>;
	},
): Promise<PrivacyCommitResult> {
	if (next === sub.privacy) return "unchanged";

	if (sub.privacy === "details" && next === "busy") {
		ports.fence(); // ДО первой durable-записи — fence поколения
		const prevPrivacy = sub.privacy;
		const prevPendingRedaction = sub.pendingRedaction;
		sub.privacy = "busy";
		sub.pendingRedaction = true;
		try {
			await ports.save();
		} catch (error) {
			sub.privacy = prevPrivacy;
			sub.pendingRedaction = prevPendingRedaction;
			throw error;
		}
		return "pending-redaction";
	}

	const prevPrivacy = sub.privacy;
	sub.privacy = next;
	try {
		await ports.save();
	} catch (error) {
		sub.privacy = prevPrivacy;
		throw error;
	}
	return "applied";
}

export type AccountRemovalResult =
	| { status: "removed"; removedSubscriptionIds: string[] }
	| { status: "refused-active-subscriptions"; subscriptionIds: string[] };

/**
 * Атомарное отключение CalDAV-аккаунта (§4.1 CalDAV-заказа). Порты НЕ
 * содержат ничего секрет-связанного — намеренно: SecretStorage-запись
 * аккаунта эта функция никогда не трогает, осиротевший секрет удаляется
 * только отдельным явным действием пользователя (§4.1).
 *
 * - Аккаунт не найден И ни одна подписка на него не ссылается → уже удалён:
 *   {status:"removed", removedSubscriptionIds: []}, БЕЗ save (менять нечего).
 *   Если ссылающиеся подписки ЕСТЬ, а записи аккаунта уже нет (битые ссылки
 *   после прерванной операции) — это тот же каскад ниже, только без записи
 *   аккаунта в списке на вырезание.
 * - Есть ссылающиеся подписки и confirmCascade() → false: НИКАКОЙ мутации,
 *   без save; {status:"refused-active-subscriptions", subscriptionIds}. Если
 *   ничего не ссылается — confirmCascade вообще не вызывается.
 * - Подтверждённый каскад, атомарный порядок:
 *   1) для КАЖДОЙ ссылающейся подписки — await removeSubscription({id,name}):
 *      зеркало в корзину ПЕРВЫМ, пока запись ещё есть в списке (тот же
 *      порядок, что у ручного удаления одной подписки). Отказ ЛЮБОГО
 *      removeSubscription — пробросить немедленно, БЕЗ мутации settings: уже
 *      отправленные в корзину зеркала восстановимы, их подписки остаются в
 *      списке и пересинкуются как ни в чём не бывало.
 *   2) вырезать (splice) ВСЕ ссылающиеся подписки и запись аккаунта из
 *      массивов settings — мутация на месте (объект settings общий с
 *      вызывателем).
 *   3) await save; отказ → восстановить вырезанные записи на их исходных
 *      позициях, вызвать rollbackRemoval(id) для каждой удалённой подписки,
 *      пробросить ошибку (зеркала ещё можно восстановить из корзины — §12,
 *      последняя строка).
 *   4) вернуть {status:"removed", removedSubscriptionIds}.
 * - Подписки ДРУГИХ аккаунтов и ics-подписки не трогаются никогда.
 */
export async function removeCaldavAccount(
	settings: Pick<GtdFlowSettings, "externalCalendars" | "caldavAccounts">,
	accountId: string,
	ports: {
		/** true — пользователь явно подтвердил каскадное удаление подписок. */
		confirmCascade: () => Promise<boolean>;
		/** Tombstone+abort+recoverable-trash зеркала одной подписки (SyncService.removeSubscription). */
		removeSubscription: (sub: { id: string; name: string }) => Promise<void>;
		/** Откат tombstone при неудачном save (SyncService.rollbackSubscriptionRemoval). */
		rollbackRemoval: (id: string) => void;
		save: () => Promise<void>;
	},
): Promise<AccountRemovalResult> {
	const referencing: { sub: CalDavCalendarSub; index: number }[] = [];
	settings.externalCalendars.forEach((sub, index) => {
		if (sub.kind === "caldav" && sub.accountId === accountId) referencing.push({ sub, index });
	});
	const accountIndex = settings.caldavAccounts.findIndex((a) => a.id === accountId);

	if (accountIndex === -1 && referencing.length === 0) {
		return { status: "removed", removedSubscriptionIds: [] };
	}

	if (referencing.length > 0) {
		const confirmed = await ports.confirmCascade();
		if (!confirmed) {
			return {
				status: "refused-active-subscriptions",
				subscriptionIds: referencing.map((r) => r.sub.id),
			};
		}
	}

	// Зеркала в корзину ПЕРВЫМИ, пока подписки ещё в списке — как при удалении
	// одной подписки вручную. Отказ пробрасывается ДО какой-либо мутации settings.
	for (const { sub } of referencing) {
		await ports.removeSubscription({ id: sub.id, name: sub.name });
	}

	// Вырезаем в порядке УБЫВАНИЯ индекса — иначе более ранние индексы съедут.
	for (const { index } of [...referencing].reverse()) {
		settings.externalCalendars.splice(index, 1);
	}
	const accountToRemove = accountIndex === -1 ? null : settings.caldavAccounts[accountIndex];
	const removedAccount = accountToRemove
		? { account: accountToRemove, index: accountIndex }
		: null;
	if (removedAccount) settings.caldavAccounts.splice(accountIndex, 1);

	try {
		await ports.save();
	} catch (error) {
		// Восстанавливаем в порядке ВОЗРАСТАНИЯ исходного индекса — иначе позиции разъедутся.
		for (const { sub, index } of referencing) {
			settings.externalCalendars.splice(index, 0, sub);
		}
		if (removedAccount) {
			settings.caldavAccounts.splice(removedAccount.index, 0, removedAccount.account);
		}
		for (const { sub } of referencing) ports.rollbackRemoval(sub.id);
		throw error;
	}

	return {
		status: "removed",
		removedSubscriptionIds: referencing.map((r) => r.sub.id),
	};
}
