/**
 * Чистые парсеры/форматтеры вкладки настроек: текст полей ↔ модель Settings.
 * Без obsidian — тестируется в node (см. settingsFormat.test.ts).
 */
import type { CalendarField, DeferPreset } from "./Settings";

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
