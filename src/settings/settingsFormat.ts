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
export function parseIntInRange(raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
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
export function reorderCalendarPlacement(current: readonly CalendarField[], primary: CalendarField): CalendarField[] {
	const rest: CalendarField[] = [];
	for (const f of [...current, ...CALENDAR_FIELDS]) {
		if (f !== primary && CALENDAR_FIELDS.includes(f) && !rest.includes(f)) rest.push(f);
	}
	return [primary, ...rest];
}
